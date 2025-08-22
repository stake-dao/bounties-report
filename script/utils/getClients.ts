import { createPublicClient, http, PublicClient, Chain } from "viem";
import {
  mainnet,
  bsc,
  optimism,
  fraxtal,
  base,
  polygon,
  arbitrum,
  sonic,
  hemi
} from "viem/chains";

interface ChainConfig {
  chain: Chain;
  rpcUrls: string[];
}

const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: {
    chain: mainnet,
    rpcUrls: [
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "",
      "https://mainnet.gateway.tenderly.co",
      "https://eth-mainnet.public.blastapi.io",
      "https://ethereum-rpc.publicnode.com",
      "https://rpc.ankr.com/eth",
    ].filter(Boolean),
  },
  56: {
    chain: bsc,
    rpcUrls: [
      "https://bsc-dataseed1.binance.org",
      "https://bsc-dataseed2.binance.org",
      "https://bsc-dataseed3.binance.org",
      "https://bsc-dataseed4.binance.org",
      "https://rpc.ankr.com/bsc",
    ],
  },
  10: {
    chain: optimism,
    rpcUrls: [
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://opt-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "",
      "https://mainnet.optimism.io",
      "https://optimism.llamarpc.com",
      "https://rpc.ankr.com/optimism",
    ].filter(Boolean),
  },
  137: {
    chain: polygon,
    rpcUrls: [
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://polygon-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "",
      "https://polygon-rpc.com",
      "https://rpc-mainnet.matic.network",
      "https://rpc.ankr.com/polygon",
      "https://polygon.llamarpc.com",
      "https://polygon-mainnet.public.blastapi.io",
      "https://polygon.meowrpc.com",
    ].filter(Boolean),
  },
  146: {
    chain: sonic,
    rpcUrls: ["https://rpc.soniclabs.com"],
  },
  1124: {
    chain: fraxtal,
    rpcUrls: ["https://rpc.frax.com", "https://fraxtal.drpc.org"],
  },
  8453: {
    chain: base,
    rpcUrls: [
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://base-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "",
      "https://base.llamarpc.com",
      "https://rpc.ankr.com/base",
      "https://mainnet.base.org",
      "https://base.publicnode.com",
    ].filter(Boolean),
  },
  42161: {
    chain: arbitrum,
    rpcUrls: [
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://arb-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "",
      "https://arbitrum.llamarpc.com",
      "https://rpc.ankr.com/arbitrum",
      "https://arbitrum-one.publicnode.com",
      "https://arbitrum.blockpi.network/v1/rpc/public",
      "https://arb-mainnet-public.unifra.io",
      "https://arb1.arbitrum.io/rpc",
    ].filter(Boolean),
  },
  43111: {
    chain: hemi,
    rpcUrls: [
      "https://rpc.hemi.network/rpc"
    ].filter(Boolean)
  }
};

const clientCache = new Map<string, PublicClient>();

async function testRpcEndpoint(url: string, chainId: number): Promise<number> {
  try {
    const startTime = Date.now();
    const testClient = createPublicClient({
      chain: CHAIN_CONFIGS[chainId].chain,
      transport: http(url, { timeout: 5000 }),
    });
    
    await (testClient as any).getBlockNumber();
    const latency = Date.now() - startTime;
    return latency;
  } catch (error: any) {
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

  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(`Chain ${chainId} not configured`);
  }

  if (config.rpcUrls.length === 0) {
    throw new Error(`No RPC URLs available for chain ${chainId}`);
  }
  
  // Test all endpoints concurrently
  const latencyTests = await Promise.all(
    config.rpcUrls.map(url => testRpcEndpoint(url, chainId))
  );

  // Find all working endpoints sorted by latency
  const workingEndpoints = latencyTests
    .map((latency, index) => ({ latency, index, url: config.rpcUrls[index] }))
    .filter(endpoint => endpoint.latency !== Infinity)
    .sort((a, b) => a.latency - b.latency);

  if (workingEndpoints.length === 0) {
    console.error(`[RPC] No healthy RPC endpoints available for chain ${chainId}`);
    // Try with increased timeout as last resort
    const extendedTests = await Promise.all(
      config.rpcUrls.map(async (url) => {
        try {
          const testClient = createPublicClient({
            chain: config.chain,
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
      index: config.rpcUrls.indexOf(workingExtended.url),
      url: workingExtended.url 
    });
  }

  const bestEndpoint = workingEndpoints[0];

  // Create client with the fastest endpoint and fallback transport
  const client = createPublicClient({
    chain: config.chain,
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
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    throw new Error(`Chain ${chainId} not configured`);
  }

  // Return up to 3 clients for redundancy
  return config.rpcUrls.slice(0, 3).map(url =>
    createPublicClient({
      chain: config.chain,
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
    
    const config = CHAIN_CONFIGS[chainId];
    if (!config) {
      throw new Error(`Chain ${chainId} not configured`);
    }
    
    // Try each RPC URL sequentially with longer timeouts
    for (const url of config.rpcUrls) {
      try {
        const client = createPublicClient({
          chain: config.chain,
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