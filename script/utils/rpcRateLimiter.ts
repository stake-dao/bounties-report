import { PublicClient } from "viem";

interface RateLimiterOptions {
  maxConcurrent?: number;
  delayBetweenBatches?: number;
  retryDelay?: number;
  maxRetries?: number;
}

export class RpcRateLimiter {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;
  private delayBetweenBatches: number;
  private retryDelay: number;
  private maxRetries: number;

  constructor(options: RateLimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.delayBetweenBatches = options.delayBetweenBatches || 100;
    this.retryDelay = options.retryDelay || 1000;
    this.maxRetries = options.maxRetries || 3;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        let lastError: any;
        
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
          try {
            const result = await fn();
            resolve(result);
            return;
          } catch (error: any) {
            lastError = error;
            
            // Check if it's a rate limit error
            if (error?.cause?.status === 429 || error?.details?.includes("429")) {
              console.log(`Rate limit hit, waiting ${this.retryDelay * (attempt + 1)}ms before retry ${attempt + 1}/${this.maxRetries}`);
              await this.delay(this.retryDelay * (attempt + 1));
            } else {
              // If it's not a rate limit error, reject immediately
              reject(error);
              return;
            }
          }
        }
        
        reject(lastError);
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const task = this.queue.shift();
    
    if (task) {
      try {
        await task();
      } catch (error) {
        console.error("Task failed:", error);
      } finally {
        this.running--;
        
        // Add delay between batches
        if (this.queue.length > 0) {
          await this.delay(this.delayBetweenBatches);
        }
        
        this.processQueue();
      }
    }
  }

  async executeInBatches<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    batchSize: number = 5
  ): Promise<R[]> {
    const results: R[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(item => this.execute(() => fn(item)))
      );
      results.push(...batchResults);
      
      // Add delay between batches
      if (i + batchSize < items.length) {
        await this.delay(this.delayBetweenBatches * 2);
      }
    }
    
    return results;
  }
}

// Helper function for rate-limited contract reads
export async function rateLimitedReadContract(
  client: PublicClient,
  params: any,
  rateLimiter: RpcRateLimiter
): Promise<any> {
  return rateLimiter.execute(() => (client as any).readContract(params));
}