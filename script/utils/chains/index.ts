/**
 * Custom chains configuration for the entire codebase
 * All chain imports should use this file instead of importing directly from viem/chains
 *
 * Note: RPC URLs are centrally managed in rpcConfig.ts
 * The default RPC URLs here are used as fallbacks by viem
 */

import { Chain } from "viem";
import {
  mainnet as viemMainnet,
  bsc as viemBsc,
  optimism as viemOptimism,
  fraxtal as viemFraxtal,
  base as viemBase,
  polygon as viemPolygon,
  arbitrum as viemArbitrum,
  sonic as viemSonic,
  hemi as viemHemi,
} from "viem/chains";
import { hyperliquid } from "./hyperliquid";

// Custom mainnet chain with Stake eRPC as primary
// For programmatic access, use getPrimaryRpcUrl(1) from rpcConfig.ts
export const mainnet: Chain = {
  ...viemMainnet,
  rpcUrls: {
    default: {
      http: ["https://stake-erpc.contact-69d.workers.dev/1"],
    },
  },
};

// Re-export standard chains
export const bsc = viemBsc;
export const optimism = viemOptimism;
export const fraxtal = viemFraxtal;
export const base = viemBase;
export const polygon = viemPolygon;
export const arbitrum = viemArbitrum;
export const sonic = viemSonic;
export const hemi = viemHemi;

// Export custom chains
export { hyperliquid };

// Chain ID to Chain mapping for convenience
export const CHAINS_BY_ID: Record<number, Chain> = {
  1: mainnet,
  10: optimism,
  56: bsc,
  137: polygon,
  146: sonic,
  252: fraxtal,
  999: hyperliquid,
  8453: base,
  42161: arbitrum,
  43111: hemi,
};

// Helper to get chain by ID
export function getChainById(chainId: number): Chain | undefined {
  return CHAINS_BY_ID[chainId];
}

// Export all chains as a namespace for wildcard imports compatibility
export const chains = {
  mainnet,
  bsc,
  optimism,
  fraxtal,
  base,
  polygon,
  arbitrum,
  sonic,
  hemi,
  hyperliquid,
};