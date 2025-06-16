import {
  createPublicClient,
  http,
  PublicClient,
} from "viem";
import { RPC_CONFIGS, getAvailableEndpoints, RpcEndpoint } from "./rpcConfig";

export interface ClientTestResult {
  endpoint: RpcEndpoint;
  success: boolean;
  latency?: number;
  error?: string;
}

export class RpcClientManager {
  private clients: Map<string, PublicClient> = new Map();
  private healthyEndpoints: Map<number, RpcEndpoint[]> = new Map();
  private lastHealthCheck: Map<number, number> = new Map();
  private readonly HEALTH_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly CONNECTION_TIMEOUT = 5000; // 5 seconds
  private readonly MAX_RETRIES = 3;

  /**
   * Get a public client for a specific chain
   * This will test connections and return the fastest available client
   */
  async getClient(chainId: number): Promise<PublicClient> {
    const cacheKey = `${chainId}-primary`;
    
    // Check if we have a cached healthy client
    if (this.clients.has(cacheKey)) {
      const lastCheck = this.lastHealthCheck.get(chainId) || 0;
      if (Date.now() - lastCheck < this.HEALTH_CHECK_INTERVAL) {
        return this.clients.get(cacheKey)!;
      }
    }

    // Get or test endpoints
    const healthyEndpoints = await this.getHealthyEndpoints(chainId);
    if (healthyEndpoints.length === 0) {
      throw new Error(`No healthy RPC endpoints available for chain ${chainId}`);
    }

    // Create client with the best endpoint
    const bestEndpoint = healthyEndpoints[0];
    const client = this.createClient(chainId, bestEndpoint);
    
    // Cache the client
    this.clients.set(cacheKey, client);
    this.lastHealthCheck.set(chainId, Date.now());

    return client;
  }

  /**
   * Get all healthy clients for a chain (for redundancy)
   */
  async getAllHealthyClients(chainId: number): Promise<PublicClient[]> {
    const healthyEndpoints = await this.getHealthyEndpoints(chainId);
    
    return healthyEndpoints.slice(0, 3).map((endpoint, index) => {
      const cacheKey = `${chainId}-${index}`;
      
      if (!this.clients.has(cacheKey)) {
        const client = this.createClient(chainId, endpoint);
        this.clients.set(cacheKey, client);
      }
      
      return this.clients.get(cacheKey)!;
    });
  }

  /**
   * Test all endpoints for a chain and return healthy ones
   */
  private async getHealthyEndpoints(chainId: number): Promise<RpcEndpoint[]> {
    // Check cache first
    const cached = this.healthyEndpoints.get(chainId);
    const lastCheck = this.lastHealthCheck.get(chainId) || 0;
    
    if (cached && cached.length > 0 && Date.now() - lastCheck < this.HEALTH_CHECK_INTERVAL) {
      return cached;
    }

    // Test all available endpoints
    const endpoints = getAvailableEndpoints(chainId);
    if (endpoints.length === 0) {
      throw new Error(`No RPC endpoints configured for chain ${chainId}`);
    }

    const testResults = await this.testEndpoints(chainId, endpoints);
    
    // Filter and sort by latency
    const healthy = testResults
      .filter(result => result.success)
      .sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity))
      .map(result => result.endpoint);

    // Cache results
    this.healthyEndpoints.set(chainId, healthy);
    this.lastHealthCheck.set(chainId, Date.now());

    return healthy;
  }

  /**
   * Test multiple endpoints concurrently
   */
  private async testEndpoints(
    chainId: number,
    endpoints: RpcEndpoint[]
  ): Promise<ClientTestResult[]> {
    const testPromises = endpoints.map(endpoint =>
      this.testEndpoint(chainId, endpoint)
    );

    return Promise.all(testPromises);
  }

  /**
   * Test a single endpoint
   */
  private async testEndpoint(
    chainId: number,
    endpoint: RpcEndpoint
  ): Promise<ClientTestResult> {
    const startTime = Date.now();
    
    try {
      const client = this.createClient(chainId, endpoint);
      
      // Test with timeout
      const blockNumberPromise = client.getBlockNumber();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timeout")), this.CONNECTION_TIMEOUT)
      );

      await Promise.race([blockNumberPromise, timeoutPromise]);
      
      const latency = Date.now() - startTime;
      
      return {
        endpoint,
        success: true,
        latency,
      };
    } catch (error) {
      return {
        endpoint,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Create a viem public client
   */
  private createClient(chainId: number, endpoint: RpcEndpoint): PublicClient {
    const config = RPC_CONFIGS[chainId];
    if (!config) {
      throw new Error(`Chain ${chainId} not configured`);
    }

    return createPublicClient({
      chain: config.chain,
      transport: http(endpoint.url, {
        retryCount: this.MAX_RETRIES,
        retryDelay: 200,
        timeout: 10000,
      }),
    });
  }

  /**
   * Force refresh all endpoints for a chain
   */
  async refreshEndpoints(chainId: number): Promise<void> {
    this.lastHealthCheck.delete(chainId);
    this.healthyEndpoints.delete(chainId);
    
    // Clear cached clients for this chain
    for (const [key, _] of this.clients) {
      if (key.startsWith(`${chainId}-`)) {
        this.clients.delete(key);
      }
    }
    
    await this.getHealthyEndpoints(chainId);
  }

  /**
   * Get connection status for all configured chains
   */
  async getConnectionStatus(): Promise<Record<number, ClientTestResult[]>> {
    const status: Record<number, ClientTestResult[]> = {};
    
    for (const chainId of Object.keys(RPC_CONFIGS).map(Number)) {
      const endpoints = getAvailableEndpoints(chainId);
      if (endpoints.length > 0) {
        status[chainId] = await this.testEndpoints(chainId, endpoints);
      }
    }
    
    return status;
  }

  /**
   * Clear all cached clients and endpoints
   */
  clearCache(): void {
    this.clients.clear();
    this.healthyEndpoints.clear();
    this.lastHealthCheck.clear();
  }
}

// Export singleton instance
export const rpcClientManager = new RpcClientManager();