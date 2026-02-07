/**
 * Unit tests for createCombineDistribution from script/utils/merkle/merkle.ts.
 *
 * This function is used by both vlAURA and vlCVX merkle generation to combine
 * current distribution data with previous merkle data. It is NOT being moved
 * in the refactor, but its correct behavior is critical to ensure the pipeline
 * produces identical outputs.
 */
import { describe, it, expect } from "vitest";
import {
  createCombineDistribution,
  createSimpleDistribution,
} from "../../utils/merkle/merkle";
import { getAddress } from "viem";

const ADDR_A = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ADDR_B = "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8";
const TOKEN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN_DOLA = "0x865377367054516e17014CcDEd1e7d814EDC9ce4";

describe("createCombineDistribution", () => {
  it("converts current distribution to UniversalMerkle format", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = { merkleRoot: "", claims: {} };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumUsdc = getAddress(TOKEN_USDC);

    expect(result[checksumA]).toBeDefined();
    expect(result[checksumA][checksumUsdc]).toBe("1000000");
  });

  it("merges current distribution with previous merkle data", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = {
      merkleRoot: "0xabc",
      claims: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: {
              amount: "2000000",
              proof: [],
            },
          },
        },
      },
    };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumUsdc = getAddress(TOKEN_USDC);

    // Should sum: 1M + 2M = 3M
    expect(result[checksumA][checksumUsdc]).toBe("3000000");
  });

  it("adds new addresses from previous merkle that are not in current distribution", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = {
      merkleRoot: "0xabc",
      claims: {
        [ADDR_B]: {
          tokens: {
            [TOKEN_DOLA]: {
              amount: "500000000000000000000",
              proof: [],
            },
          },
        },
      },
    };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumB = getAddress(ADDR_B);
    const checksumUsdc = getAddress(TOKEN_USDC);
    const checksumDola = getAddress(TOKEN_DOLA);

    expect(result[checksumA][checksumUsdc]).toBe("1000000");
    expect(result[checksumB][checksumDola]).toBe("500000000000000000000");
  });

  it("normalizes addresses to checksum format", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A.toLowerCase()]: {
          tokens: {
            [TOKEN_USDC.toLowerCase()]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = { merkleRoot: "", claims: {} };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    // All keys should be checksummed
    for (const address of Object.keys(result)) {
      expect(address).toBe(getAddress(address));
      for (const token of Object.keys(result[address])) {
        expect(token).toBe(getAddress(token));
      }
    }
  });

  it("handles empty current distribution", () => {
    const currentDistribution = { distribution: {} };
    const previousMerkle = {
      merkleRoot: "0xabc",
      claims: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: {
              amount: "1000000",
              proof: [],
            },
          },
        },
      },
    };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumUsdc = getAddress(TOKEN_USDC);

    // Should just have the previous data
    expect(result[checksumA][checksumUsdc]).toBe("1000000");
  });

  it("handles empty previous merkle", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = { merkleRoot: "", claims: {} };

    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumUsdc = getAddress(TOKEN_USDC);

    expect(result[checksumA][checksumUsdc]).toBe("1000000");
  });

  it("handles null previous merkle claims gracefully", () => {
    const currentDistribution = {
      distribution: {
        [ADDR_A]: {
          tokens: {
            [TOKEN_USDC]: BigInt("1000000"),
          },
        },
      },
    };
    const previousMerkle = { merkleRoot: "", claims: null as any };

    // Should not throw
    const result = createCombineDistribution(
      currentDistribution,
      previousMerkle
    );

    const checksumA = getAddress(ADDR_A);
    const checksumUsdc = getAddress(TOKEN_USDC);

    expect(result[checksumA][checksumUsdc]).toBe("1000000");
  });
});

describe("createSimpleDistribution", () => {
  it("converts Distribution to UniversalMerkle format", () => {
    const distribution = {
      [ADDR_A]: {
        tokens: {
          [TOKEN_USDC]: BigInt("1000000"),
        },
      },
    };

    const result = createSimpleDistribution(distribution);

    expect(result[ADDR_A][TOKEN_USDC]).toBe("1000000");
  });

  it("handles multiple addresses and tokens", () => {
    const distribution = {
      [ADDR_A]: {
        tokens: {
          [TOKEN_USDC]: BigInt("1000000"),
          [TOKEN_DOLA]: BigInt("500000000000000000000"),
        },
      },
      [ADDR_B]: {
        tokens: {
          [TOKEN_USDC]: BigInt("2000000"),
        },
      },
    };

    const result = createSimpleDistribution(distribution);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result[ADDR_A][TOKEN_USDC]).toBe("1000000");
    expect(result[ADDR_A][TOKEN_DOLA]).toBe("500000000000000000000");
    expect(result[ADDR_B][TOKEN_USDC]).toBe("2000000");
  });

  it("handles empty distribution", () => {
    const result = createSimpleDistribution({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});
