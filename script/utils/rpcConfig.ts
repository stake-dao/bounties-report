import { Chain } from "viem";
import {
  mainnet,
  bsc,
  optimism,
  fraxtal,
  base,
  polygon,
  arbitrum,
  sonic,
} from "../utils/chains";

export interface RpcEndpoint {
  url: string;
  priority: number;
  requiresApiKey?: boolean;
}

export interface ChainRpcConfig {
  chain: Chain;
  endpoints: RpcEndpoint[];
}

// Utility to inject API keys into endpoint URLs
function injectApiKey(url: string, apiKeys: Record<string, string | undefined>): string {
  if (url.includes("{ALCHEMY_API_KEY}")) {
    return url.replace("{ALCHEMY_API_KEY}", apiKeys.ALCHEMY_API_KEY || "");
  }
  if (url.includes("{INFURA_API_KEY}")) {
    return url.replace("{INFURA_API_KEY}", apiKeys.INFURA_API_KEY || "");
  }
  return url;
}

export const RPC_CONFIGS: Record<number, ChainRpcConfig> = {
  // Ethereum Mainnet
  1: {
    chain: mainnet,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/1",
        priority: 1,
      },
      {
        url: "https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}",
        priority: 2,
        requiresApiKey: true,
      },
      {
        url: `https://mainnet.gateway.tenderly.co`,
        priority: 3,
      },
      {
        url: "https://eth-mainnet.public.blastapi.io",
        priority: 4,
      },
      {
        url: "https://ethereum-rpc.publicnode.com",
        priority: 5,
      },
      {
        url: "https://rpc.ankr.com/eth",
        priority: 6,
      },
    ],
  },
  // BSC
  56: {
    chain: bsc,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/56",
        priority: 1,
      },
      {
        url: "https://bsc-dataseed1.binance.org",
        priority: 2,
      },
      {
        url: "https://bsc-dataseed2.binance.org",
        priority: 3,
      },
      {
        url: "https://bsc-dataseed3.binance.org",
        priority: 4,
      },
      {
        url: "https://bsc-dataseed4.binance.org",
        priority: 5,
      },
      {
        url: "https://rpc.ankr.com/bsc",
        priority: 6,
      },
    ],
  },
  // Optimism
  10: {
    chain: optimism,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/10",
        priority: 1,
      },
      {
        url: "https://opt-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}",
        priority: 2,
        requiresApiKey: true,
      },
      {
        url: "https://mainnet.optimism.io",
        priority: 3,
      },
      {
        url: "https://optimism.llamarpc.com",
        priority: 4,
      },
      {
        url: "https://rpc.ankr.com/optimism",
        priority: 5,
      },
    ],
  },
  // Fraxtal
  252: {
    chain: fraxtal,
    endpoints: [
      {
        url: "https://fraxtal-rpc.publicnode.com",
        priority: 2,
      },
      {
        url: "https://rpc.frax.com",
        priority: 1,
      },
      {
        url: "https://fraxtal.drpc.org",
        priority: 3,
      },
    ],
  },
  // Base
  8453: {
    chain: base,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/8453",
        priority: 1,
      },
      {
        url: "https://base-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}",
        priority: 2,
        requiresApiKey: true,
      },
      {
        url: "https://base.llamarpc.com",
        priority: 3,
      },
      {
        url: "https://rpc.ankr.com/base",
        priority: 4,
      },
      {
        url: "https://mainnet.base.org",
        priority: 5,
      },
      {
        url: "https://developer-access-mainnet.base.org",
        priority: 6,
      },
    ],
  },
  // Polygon
  137: {
    chain: polygon,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/137",
        priority: 1,
      },
      {
        url: "https://polygon-rpc.com",
        priority: 2,
      },
      {
        url: "https://rpc-mainnet.matic.network",
        priority: 3,
      },
      {
        url: "https://rpc.ankr.com/polygon",
        priority: 4,
      },
    ],
  },
  // Sonic
  146: {
    chain: sonic,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/146",
        priority: 1,
      },
      {
        url: "https://rpc.soniclabs.com",
        priority: 2,
      },
    ],
  },
  // Arbitrum
  42161: {
    chain: arbitrum,
    endpoints: [
      {
        url: "https://stake-erpc.contact-69d.workers.dev/42161",
        priority: 1,
      },
      {
        url: "https://arb-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}",
        priority: 2,
        requiresApiKey: true,
      },
      {
        url: "https://arb1.arbitrum.io/rpc",
        priority: 3,
      },
      {
        url: "https://arbitrum.llamarpc.com",
        priority: 4,
      },
      {
        url: "https://rpc.ankr.com/arbitrum",
        priority: 5,
      },
    ],
  },
};

// Filter out endpoints that require API keys if keys are not available
export function getAvailableEndpoints(chainId: number): RpcEndpoint[] {
  const config = RPC_CONFIGS[chainId];
  if (!config) return [];

  const apiKeys = {
    ALCHEMY_API_KEY: process.env.WEB3_ALCHEMY_API_KEY,
    INFURA_API_KEY: process.env.INFURA_API_KEY,
  };

  return config.endpoints
    .filter((endpoint) => {
      if (endpoint.requiresApiKey) {
        if (endpoint.url.includes("{ALCHEMY_API_KEY}") && !apiKeys.ALCHEMY_API_KEY) return false;
        if (endpoint.url.includes("{INFURA_API_KEY}") && !apiKeys.INFURA_API_KEY) return false;
      }
      return true;
    })
    .map((endpoint) => ({
      ...endpoint,
      url: injectApiKey(endpoint.url, apiKeys),
    }))
    .sort((a, b) => a.priority - b.priority);
}

// Get the primary (highest priority) RPC URL for a chain
export function getPrimaryRpcUrl(chainId: number): string {
  const endpoints = getAvailableEndpoints(chainId);
  if (endpoints.length === 0) {
    throw new Error(`No available RPC endpoints for chain ${chainId}`);
  }
  return endpoints[0].url;
}

// Get the chain configuration for a chain ID
export function getChainConfig(chainId: number): ChainRpcConfig | undefined {
  return RPC_CONFIGS[chainId];
}