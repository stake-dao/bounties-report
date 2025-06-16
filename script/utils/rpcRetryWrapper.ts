import { PublicClient } from "viem";
import { getOptimizedClient, getRedundantClients } from "./constants";

export interface RetryOptions {
  maxRetries?: number;
  retryDelay?: number;
  exponentialBackoff?: boolean;
  fallbackToOtherClients?: boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  retryDelay: 1000,
  exponentialBackoff: true,
  fallbackToOtherClients: true,
};

/**
 * Execute an RPC call with automatic retry and fallback logic
 * @param chainId - The chain ID to execute the call on
 * @param operation - The RPC operation to execute
 * @param options - Retry configuration options
 * @returns The result of the operation
 */
export async function executeWithRetry<T>(
  chainId: number,
  operation: (client: PublicClient) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;

  // First try with the primary optimized client
  const primaryClient = await getOptimizedClient(chainId);
  
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await operation(primaryClient);
    } catch (error) {
      lastError = error as Error;
      console.error(`RPC call failed (attempt ${attempt + 1}/${opts.maxRetries + 1}):`, error);
      
      if (attempt < opts.maxRetries) {
        const delay = opts.exponentialBackoff
          ? opts.retryDelay * Math.pow(2, attempt)
          : opts.retryDelay;
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // If fallback is enabled, try with other healthy clients
  if (opts.fallbackToOtherClients) {
    console.log("Primary client failed, trying fallback clients...");
    
    try {
      const fallbackClients = await getRedundantClients(chainId);
      
      // Skip the first client as it's likely the same as primaryClient
      for (let i = 1; i < fallbackClients.length; i++) {
        const client = fallbackClients[i];
        
        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            console.log(`Trying fallback client ${i}...`);
            return await operation(client);
          } catch (error) {
            console.error(`Fallback client ${i} failed:`, error);
            
            if (attempt === 0) {
              await new Promise(resolve => setTimeout(resolve, opts.retryDelay));
            }
          }
        }
      }
    } catch (fallbackError) {
      console.error("Failed to get fallback clients:", fallbackError);
    }
  }

  throw new Error(
    `RPC operation failed after ${opts.maxRetries + 1} attempts. Last error: ${lastError?.message}`
  );
}

/**
 * Execute multiple RPC calls in parallel with retry logic
 * @param chainId - The chain ID to execute the calls on
 * @param operations - Array of RPC operations to execute
 * @param options - Retry configuration options
 * @returns Array of results in the same order as operations
 */
export async function executeBatchWithRetry<T>(
  chainId: number,
  operations: Array<(client: PublicClient) => Promise<T>>,
  options: RetryOptions = {}
): Promise<T[]> {
  const promises = operations.map(operation =>
    executeWithRetry(chainId, operation, options)
  );
  
  return Promise.all(promises);
}

/**
 * Execute an RPC call with timeout
 * @param chainId - The chain ID to execute the call on
 * @param operation - The RPC operation to execute
 * @param timeout - Timeout in milliseconds
 * @param options - Retry configuration options
 * @returns The result of the operation
 */
export async function executeWithTimeout<T>(
  chainId: number,
  operation: (client: PublicClient) => Promise<T>,
  timeout: number,
  options: RetryOptions = {}
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Operation timed out after ${timeout}ms`)), timeout);
  });

  const operationPromise = executeWithRetry(chainId, operation, options);

  return Promise.race([operationPromise, timeoutPromise]);
}

/**
 * Create a wrapped client that automatically applies retry logic to all calls
 * @param chainId - The chain ID for the client
 * @param options - Default retry options for all calls
 * @returns A proxy that wraps all client methods with retry logic
 */
export async function createRetryClient(
  chainId: number,
  options: RetryOptions = {}
): Promise<PublicClient> {
  const client = await getOptimizedClient(chainId);
  
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      
      if (typeof value === "function") {
        return async (...args: any[]) => {
          return executeWithRetry(
            chainId,
            async (c) => {
              const method = (c as any)[prop];
              return method.apply(c, args);
            },
            options
          );
        };
      }
      
      return value;
    },
  });
}