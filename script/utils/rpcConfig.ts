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

export const RPC_CONFIGS: Record<number, ChainRpcConfig> = {
  // Ethereum Mainnet
  1: {
    chain: mainnet,
    endpoints: [
      {
        url: `https://mainnet.gateway.tenderly.co`,
        priority: 1,
      },
      {
        url: "https://eth-mainnet.public.blastapi.io",
        priority: 3,
      },
      {
        url: "https://ethereum-rpc.publicnode.com",
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
        url: "https://mainnet.optimism.io",
        priority: 1,
      },
      {
        url: "https://optimism.llamarpc.com",
        priority: 2,
      },
      {
        url: "https://rpc.ankr.com/optimism",
        priority: 3,
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
        url: "https://base.llamarpc.com",
        priority: 1,
      },
      {
        url: "https://rpc.ankr.com/base",
        priority: 3,
      },
    ],
  },
  // Polygon
  137: {
    chain: polygon,
    endpoints: [
      {
        url: "https://polygon-rpc.com",
        priority: 1,
      },
      {
        url: "https://rpc-mainnet.matic.network",
        priority: 2,
      },
      {
        url: "https://rpc.ankr.com/polygon",
        priority: 3,
      },
    ],
  },
  // Sonic
  146: {
    chain: sonic,
    endpoints: [
      {
        url: "https://rpc.soniclabs.com",
        priority: 1,
      },
    ],
  },
  // Arbitrum
  42161: {
    chain: arbitrum,
    endpoints: [
      {
        url: "https://arb1.arbitrum.io/rpc",
        priority: 1,
      },
      {
        url: "https://arbitrum.llamarpc.com",
        priority: 2,
      },
      {
        url: "https://rpc.ankr.com/arbitrum",
        priority: 3,
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