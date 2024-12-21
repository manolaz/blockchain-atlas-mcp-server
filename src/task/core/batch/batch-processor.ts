import { Logger } from '../../../logging/index.js';
import { 
    BatchProcessor,
    BatchConfig,
    BatchResult,
    BatchProgressCallback
} from './batch-types.js';
import { ErrorCodes, createError } from '../../../errors/index.js';

const DEFAULT_CONFIG: BatchConfig = {
    batchSize: 50,
    concurrentBatches: 3,
    retryCount: 3,
    retryDelay: 1000 // 1 second
};

export class TaskBatchProcessor implements BatchProcessor {
    private logger: Logger;
    private config: BatchConfig;

    constructor(config: Partial<BatchConfig> = {}) {
        this.logger = Logger.getInstance().child({ component: 'TaskBatchProcessor' });
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Processes a single batch of items with optional validation
     */
    async processBatch<T>(
        batch: T[],
        operation: (item: T) => Promise<void>,
        progressCallback?: BatchProgressCallback
    ): Promise<BatchResult> {
        const result: BatchResult = {
            success: true,
            processedCount: 0,
            failedCount: 0,
            errors: []
        };

        // Process items sequentially with validation
        for (const [index, item] of batch.entries()) {
            try {
                await this.processWithRetry(item, operation);
                result.processedCount++;

                if (progressCallback?.onOperationComplete) {
                    progressCallback.onOperationComplete(index + 1, batch.length);
                }
            } catch (error) {
                result.failedCount++;
                result.errors.push({
                    item,
                    error: error instanceof Error ? error : new Error(String(error)),
                    context: {
                        batchSize: batch.length,
                        currentIndex: index,
                        processedCount: result.processedCount,
                        failureReason: error instanceof Error ? error.message : String(error)
                    }
                });
                result.success = false;
                
                // Enhanced error logging
                this.logger.error('Batch item processing failed', {
                    error,
                    itemIndex: index,
                    batchProgress: `${index + 1}/${batch.length}`,
                    processedCount: result.processedCount,
                    failedCount: result.failedCount,
                    context: {
                        batchSize: batch.length,
                        currentIndex: index,
                        processedCount: result.processedCount
                    }
                });

                // Allow progress callback to handle error
                if (progressCallback?.onOperationComplete) {
                    progressCallback.onOperationComplete(index + 1, batch.length);
                }
            }
        }

        return result;
    }

    /**
     * Processes items in batches with concurrency control
     */
    async processInBatches<T>(
        items: T[],
        batchSize: number,
        operation: (item: T) => Promise<void>,
        progressCallback?: BatchProgressCallback
    ): Promise<BatchResult> {
        const batches = this.createBatches(items, batchSize);
        const totalBatches = batches.length;
        let currentBatch = 0;

        const result: BatchResult = {
            success: true,
            processedCount: 0,
            failedCount: 0,
            errors: []
        };

        // Process batches with concurrency control
        while (currentBatch < totalBatches) {
            const batchPromises: Promise<BatchResult>[] = [];

            // Create concurrent batch operations up to the limit
            for (
                let i = 0;
                i < this.config.concurrentBatches && currentBatch < totalBatches;
                i++, currentBatch++
            ) {
                if (progressCallback?.onBatchStart) {
                    progressCallback.onBatchStart(currentBatch + 1, totalBatches);
                }

                const batchPromise = this.processBatch(
                    batches[currentBatch],
                    operation,
                    progressCallback
                ).then(batchResult => {
                    if (progressCallback?.onBatchComplete) {
                        progressCallback.onBatchComplete(currentBatch + 1, batchResult);
                    }
                    return batchResult;
                });

                batchPromises.push(batchPromise);
            }

            // Wait for current batch of promises to complete
            const batchResults = await Promise.all(batchPromises);

            // Aggregate results
            for (const batchResult of batchResults) {
                result.processedCount += batchResult.processedCount;
                result.failedCount += batchResult.failedCount;
                result.errors.push(...batchResult.errors);
                if (!batchResult.success) {
                    result.success = false;
                }
            }
        }

        this.logger.info('Batch processing completed', {
            totalItems: items.length,
            processedCount: result.processedCount,
            failedCount: result.failedCount,
            batchCount: totalBatches
        });

        return result;
    }

    /**
     * Creates batches from an array of items
     */
    private createBatches<T>(items: T[], batchSize: number): T[][] {
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }

    /**
     * Processes an item with retry logic and enhanced error handling
     */
    private async processWithRetry<T>(
        item: T,
        operation: (item: T) => Promise<void>
    ): Promise<void> {
        let lastError: Error | undefined;
        let lastAttemptContext: Record<string, unknown> = {};

        for (let attempt = 1; attempt <= this.config.retryCount; attempt++) {
            try {
                try {
                    await operation(item);
                    if (attempt > 1) {
                        this.logger.info('Operation succeeded after retry', {
                            successfulAttempt: attempt,
                            totalAttempts: this.config.retryCount
                        });
                    }
                    return;
                } catch (error) {
                    // Don't retry certain errors
                    if (error instanceof Error && 
                        (error.message.includes('TASK_CYCLE') || 
                         error.message.includes('TASK_DEPENDENCY'))) {
                        throw error; // Immediately fail for dependency/cycle errors
                    }
                    throw error;
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                lastAttemptContext = {
                    attempt,
                    maxAttempts: this.config.retryCount,
                    error: lastError,
                    item: typeof item === 'object' ? JSON.stringify(item) : item,
                    timestamp: new Date().toISOString()
                };

                this.logger.warn('Operation failed, retrying', lastAttemptContext);

                if (attempt < this.config.retryCount) {
                    const delay = this.config.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
                    await this.delay(delay);
                }
            }
        }

        // Enhanced error creation with detailed context
        throw createError(
            ErrorCodes.OPERATION_FAILED,
            {
                message: 'Operation failed after all retry attempts',
                retryCount: this.config.retryCount,
                error: lastError,
                context: lastAttemptContext,
                item: typeof item === 'object' ? JSON.stringify(item) : item
            },
            `Operation failed after ${this.config.retryCount} attempts`,
            'Check logs for detailed error history and consider increasing retry count or delay'
        );
    }

    /**
     * Delays execution
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Updates batch processor configuration
     */
    updateConfig(config: Partial<BatchConfig>): void {
        this.config = { ...this.config, ...config };
        this.logger.debug('Batch processor configuration updated', { config: this.config });
    }

    /**
     * Gets batch processor statistics
     */
    getStats(): {
        config: BatchConfig;
        performance: {
            averageBatchSize: number;
            concurrencyLevel: number;
            retryRate: number;
        };
    } {
        return {
            config: { ...this.config },
            performance: {
                averageBatchSize: this.config.batchSize,
                concurrencyLevel: this.config.concurrentBatches,
                retryRate: 0 // This would need to be tracked during processing
            }
        };
    }
}
