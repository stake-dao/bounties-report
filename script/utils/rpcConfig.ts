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
} from "viem/chains";

export interface RpcEndpoint {
  url: string;
  priority: number;
  requiresApiKey?: boolean;
}

export interface ChainRpcConfig {
  chain: Chain;
  endpoints: RpcEndpoint[];
}

// Get API key from environment
const ALCHEMY_API_KEY = process.env.WEB3_ALCHEMY_API_KEY || "";
const INFURA_API_KEY = process.env.INFURA_API_KEY || "";

export const RPC_CONFIGS: Record<number, ChainRpcConfig> = {
  // Ethereum Mainnet
  1: {
    chain: mainnet,
    endpoints: [
      {
        url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
      },
      {
        url: `https://mainnet.infura.io/v3/${INFURA_API_KEY}`,
        priority: 2,
        requiresApiKey: true,
      },
      {
        url: "https://eth.llamarpc.com",
        priority: 3,
      },
      {
        url: "https://cloudflare-eth.com",
        priority: 4,
      },
      {
        url: "https://rpc.ankr.com/eth",
        priority: 5,
      },
    ],
  },
  // BSC
  56: {
    chain: bsc,
    endpoints: [
      {
        url: "https://bsc-dataseed1.binance.org",
        priority: 1,
      },
      {
        url: "https://bsc-dataseed2.binance.org",
        priority: 2,
      },
      {
        url: "https://bsc-dataseed3.binance.org",
        priority: 3,
      },
      {
        url: "https://bsc-dataseed4.binance.org",
        priority: 4,
      },
      {
        url: "https://rpc.ankr.com/bsc",
        priority: 5,
      },
    ],
  },
  // Optimism
  10: {
    chain: optimism,
    endpoints: [
      {
        url: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
      },
      {
        url: "https://mainnet.optimism.io",
        priority: 2,
      },
      {
        url: "https://optimism.llamarpc.com",
        priority: 3,
      },
      {
        url: "https://rpc.ankr.com/optimism",
        priority: 4,
      },
    ],
  },
  // Fraxtal
  1124: {
    chain: fraxtal,
    endpoints: [
      {
        url: "https://rpc.frax.com",
        priority: 1,
      },
      {
        url: "https://fraxtal.drpc.org",
        priority: 2,
      },
    ],
  },
  // Base
  8453: {
    chain: base,
    endpoints: [
      {
        url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
      },
      {
        url: "https://mainnet.base.org",
        priority: 2,
      },
      {
        url: "https://base.llamarpc.com",
        priority: 3,
      },
      {
        url: "https://rpc.ankr.com/base",
        priority: 4,
      },
    ],
  },
  // Polygon
  137: {
    chain: polygon,
    endpoints: [
      {
        url: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
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
        url: `https://sonic-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
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
        url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
        priority: 1,
        requiresApiKey: true,
      },
      {
        url: "https://arb1.arbitrum.io/rpc",
        priority: 2,
      },
      {
        url: "https://arbitrum.llamarpc.com",
        priority: 3,
      },
      {
        url: "https://rpc.ankr.com/arbitrum",
        priority: 4,
      },
    ],
  },
};

// Filter out endpoints that require API keys if keys are not available
export function getAvailableEndpoints(chainId: number): RpcEndpoint[] {
  const config = RPC_CONFIGS[chainId];
  if (!config) return [];

  return config.endpoints
    .filter((endpoint) => {
      if (endpoint.requiresApiKey) {
        if (endpoint.url.includes("alchemy") && !ALCHEMY_API_KEY) return false;
        if (endpoint.url.includes("infura") && !INFURA_API_KEY) return false;
      }
      return true;
    })
    .sort((a, b) => a.priority - b.priority);
}