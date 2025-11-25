import { createPublicClient, http, PublicClient } from "viem";
import { getAvailableEndpoints } from "./rpcConfig";
import { CHAINS_BY_ID } from "./chains";

const clientCache = new Map<string, PublicClient>();

async function testRpcEndpoint(url: string, chainId: number): Promise<number> {
  try {
    const chain = CHAINS_BY_ID[chainId];
    if (!chain) {
      return Infinity;
    }

    const startTime = Date.now();
    const testClient = createPublicClient({
      chain,
      transport: http(url, { timeout: 5000 }),
    });

    await (testClient as any).getBlockNumber();
    const latency = Date.now() - startTime;
    return latency;
  } catch (error: any) {
    // Skip eth.merkle.io as it's unreliable
    if (url.includes("eth.merkle.io")) {
      console.warn("[RPC] Skipping eth.merkle.io - known unreliable endpoint");
    }
    return Infinity;
  }
}

export async function getClient(chainId: number, skipCache: boolean = false): Promise<PublicClient> {
  const cacheKey = `client-${chainId}`;

  if (!skipCache && clientCache.has(cacheKey)) {
    const cachedClient = clientCache.get(cacheKey)!;
    // Test if cached client is still working
    try {
      await (cachedClient as any).getBlockNumber();
      return cachedClient;
    } catch {
      clientCache.delete(cacheKey);
    }
  }

  const chain = CHAINS_BY_ID[chainId];
  if (!chain) {
    throw new Error(`Chain ${chainId} not configured in CHAINS_BY_ID`);
  }

  // Get RPC endpoints from rpcConfig.ts
  const endpoints = getAvailableEndpoints(chainId);
  if (endpoints.length === 0) {
    throw new Error(`No RPC URLs available for chain ${chainId}`);
  }

  const rpcUrls = endpoints.map(e => e.url);

  // Test all endpoints concurrently
  const latencyTests = await Promise.all(
    rpcUrls.map(url => testRpcEndpoint(url, chainId))
  );

  // Find all working endpoints sorted by latency
  const workingEndpoints = latencyTests
    .map((latency, index) => ({ latency, index, url: rpcUrls[index] }))
    .filter(endpoint => endpoint.latency !== Infinity)
    .sort((a, b) => a.latency - b.latency);

  if (workingEndpoints.length === 0) {
    console.error(`[RPC] No healthy RPC endpoints available for chain ${chainId}`);
    // Try with increased timeout as last resort
    const extendedTests = await Promise.all(
      rpcUrls.map(async (url) => {
        try {
          const testClient = createPublicClient({
            chain,
            transport: http(url, { timeout: 15000 }),
          });
          const startTime = Date.now();
          await (testClient as any).getBlockNumber();
          const latency = Date.now() - startTime;
          return { latency, url };
        } catch {
          return { latency: Infinity, url };
        }
      })
    );

    const workingExtended = extendedTests.find(test => test.latency !== Infinity);
    if (!workingExtended) {
      throw new Error(`No healthy RPC endpoints available for chain ${chainId} even with extended timeout`);
    }

    workingEndpoints.push({
      latency: workingExtended.latency,
      index: rpcUrls.indexOf(workingExtended.url),
      url: workingExtended.url
    });
  }

  const bestEndpoint = workingEndpoints[0];

  // Create client with the fastest endpoint and fallback transport
  const client = createPublicClient({
    chain,
    transport: http(bestEndpoint.url, {
      retryCount: 5,
      retryDelay: 1000,
      timeout: 30000,
      // Removed verbose logging for cleaner output
    }),
  });

  clientCache.set(cacheKey, client);
  return client;
}

export async function getRedundantClients(chainId: number): Promise<PublicClient[]> {
  const chain = CHAINS_BY_ID[chainId];
  if (!chain) {
    throw new Error(`Chain ${chainId} not configured`);
  }

  const endpoints = getAvailableEndpoints(chainId);
  const rpcUrls = endpoints.map(e => e.url);

  // Return up to 3 clients for redundancy
  return rpcUrls.slice(0, 3).map(url =>
    createPublicClient({
      chain,
      transport: http(url, {
        retryCount: 3,
        retryDelay: 200,
        timeout: 10000,
      }),
    })
  );
}

export function clearClientCache(): void {
  clientCache.clear();
}

// Helper function to create a client with automatic fallback
export async function getClientWithFallback(chainId: number): Promise<PublicClient> {
  try {
    return await getClient(chainId);
  } catch (error) {
    console.error(`[RPC] Failed to get client for chain ${chainId}, trying fallback...`);

    const chain = CHAINS_BY_ID[chainId];
    if (!chain) {
      throw new Error(`Chain ${chainId} not configured`);
    }

    const endpoints = getAvailableEndpoints(chainId);
    const rpcUrls = endpoints.map(e => e.url);

    // Try each RPC URL sequentially with longer timeouts
    for (const url of rpcUrls) {
      try {
        const client = createPublicClient({
          chain,
          transport: http(url, {
            retryCount: 3,
            retryDelay: 2000,
            timeout: 60000, // 60 second timeout for fallback
          }),
        });

        // Test the client
        await (client as any).getBlockNumber();
        return client;
      } catch (err) {
        console.error(`[RPC Fallback] Failed with ${url}: ${err}`);
        continue;
      }
    }

    throw new Error(`All RPC endpoints failed for chain ${chainId}`);
  }
}