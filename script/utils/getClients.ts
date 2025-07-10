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
      "https://polygon-rpc.com",
      "https://rpc-mainnet.matic.network",
      "https://rpc.ankr.com/polygon",
    ],
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
    return Date.now() - startTime;
  } catch {
    return Infinity;
  }
}

export async function getClient(chainId: number): Promise<PublicClient> {
  const cacheKey = `client-${chainId}`;
  
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey)!;
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

  // Find the fastest endpoint
  let bestIndex = 0;
  let bestLatency = latencyTests[0];
  
  for (let i = 1; i < latencyTests.length; i++) {
    if (latencyTests[i] < bestLatency) {
      bestLatency = latencyTests[i];
      bestIndex = i;
    }
  }

  if (bestLatency === Infinity) {
    throw new Error(`No healthy RPC endpoints available for chain ${chainId}`);
  }

  // Create client with the fastest endpoint
  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrls[bestIndex], {
      retryCount: 5,
      retryDelay: 1000,
      timeout: 30000,
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