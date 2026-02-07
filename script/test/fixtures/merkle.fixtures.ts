/**
 * Test fixtures for generateMerkleTree and mergeMerkleData.
 *
 * These fixtures use real-looking Ethereum addresses so that viem's
 * getAddress() checksumming works correctly.
 */
import type { UniversalMerkle } from "../../interfaces/UniversalMerkle";
import type { MerkleData } from "../../interfaces/MerkleData";

// Realistic checksummed addresses
export const ADDR_A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth
export const ADDR_B = "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8"; // binance
export const ADDR_C = "0x68378fCB3A27D5613aFCfddB590d35a6e751972C"; // random

// Token addresses
export const TOKEN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const TOKEN_DOLA = "0x865377367054516e17014CcDEd1e7d814EDC9ce4";
export const TOKEN_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/**
 * Single address, single token distribution.
 */
export const singleAddressDistribution: UniversalMerkle = {
  [ADDR_A]: {
    [TOKEN_USDC]: "1000000", // 1 USDC
  },
};

/**
 * Multiple addresses, single token distribution.
 */
export const multiAddressDistribution: UniversalMerkle = {
  [ADDR_A]: {
    [TOKEN_USDC]: "1000000",
  },
  [ADDR_B]: {
    [TOKEN_USDC]: "2000000",
  },
};

/**
 * Multiple addresses, multiple tokens distribution.
 */
export const multiTokenDistribution: UniversalMerkle = {
  [ADDR_A]: {
    [TOKEN_USDC]: "1000000",
    [TOKEN_DOLA]: "500000000000000000000", // 500 DOLA (18 decimals)
  },
  [ADDR_B]: {
    [TOKEN_USDC]: "2000000",
    [TOKEN_WETH]: "1000000000000000000", // 1 WETH
  },
};

/**
 * Distribution with lowercase addresses to test checksumming.
 */
export const lowercaseAddressDistribution: UniversalMerkle = {
  [ADDR_A.toLowerCase()]: {
    [TOKEN_USDC.toLowerCase()]: "1000000",
  },
  [ADDR_B.toLowerCase()]: {
    [TOKEN_USDC.toLowerCase()]: "2000000",
  },
};

/**
 * Empty distribution.
 */
export const emptyDistribution: UniversalMerkle = {};

/**
 * A pre-computed MerkleData for testing mergeMerkleData.
 * We will generate this in the test by running generateMerkleTree on
 * singleAddressDistribution and multiAddressDistribution, respectively.
 */

/**
 * Distribution with duplicate address (different case) -- should be merged.
 */
export const duplicateAddressDistribution: UniversalMerkle = {
  [ADDR_A.toLowerCase()]: {
    [TOKEN_USDC]: "1000000",
  },
  [ADDR_A]: {
    [TOKEN_USDC]: "2000000",
  },
};

/**
 * Large distribution for stress testing.
 */
export function generateLargeDistribution(count: number): UniversalMerkle {
  const distribution: UniversalMerkle = {};
  for (let i = 0; i < count; i++) {
    // Generate deterministic pseudo-addresses
    const hex = i.toString(16).padStart(40, "0");
    const address = `0x${hex}`;
    distribution[address] = {
      [TOKEN_USDC]: (BigInt(i + 1) * BigInt(1000000)).toString(),
    };
  }
  return distribution;
}
