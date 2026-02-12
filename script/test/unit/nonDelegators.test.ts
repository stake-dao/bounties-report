/**
 * Unit tests for computeNonDelegatorsDistribution.
 *
 * Tests the shared module extracted from vlAURA and vlCVX.
 */
import { describe, it, expect } from "vitest";
import { computeNonDelegatorsDistribution as computeShared } from "../../shared/nonDelegators";
const computeVlAURA = computeShared;
const computeVlCVX = computeShared;
import {
  minimalCsvResult,
  minimalGaugeMapping,
  twoEqualVoters,
  unequalVoters,
  splitVoteVoters,
  nonParticipatingVoter,
  multiGaugeCsvResult,
  multiGaugeMapping,
  multiGaugeVoters,
  emptyCsvResult,
  emptyVotes,
  unmappedGaugeCsvResult,
  TOKEN_A,
  TOKEN_B,
} from "../fixtures/nonDelegators.fixtures";

// Helper to sum all token amounts across all voters in a distribution
function sumTokenAmounts(
  distribution: Record<string, { tokens: Record<string, bigint> }>,
  tokenAddress: string
): bigint {
  return Object.values(distribution).reduce((acc, { tokens }) => {
    return acc + (tokens[tokenAddress] || 0n);
  }, 0n);
}

// Helper to get the number of unique recipients
function recipientCount(
  distribution: Record<string, { tokens: Record<string, bigint> }>
): number {
  return Object.keys(distribution).length;
}

// Run the same test suite against both implementations
const implementations = [
  { name: "vlAURA", fn: computeVlAURA },
  { name: "vlCVX", fn: computeVlCVX },
] as const;

for (const { name, fn } of implementations) {
  describe(`computeNonDelegatorsDistribution [${name}]`, () => {
    // --- Basic distribution ---

    it("distributes rewards equally between two equal voters", () => {
      const result = fn(minimalCsvResult, minimalGaugeMapping, twoEqualVoters);

      expect(recipientCount(result)).toBe(2);

      // Total distributed should equal the reward amount
      const total = sumTokenAmounts(result, TOKEN_A);
      expect(total).toBe(BigInt("1000000000000000000"));

      // Each voter should get roughly 50% (allow for rounding)
      const voterA =
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]?.tokens[TOKEN_A] ??
        0n;
      const voterB =
        result["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]?.tokens[
          TOKEN_A
        ] ?? 0n;

      // Due to the "last voter gets remaining" logic, one may get dust.
      // But both should be within 1 wei of 5e17.
      expect(voterA + voterB).toBe(BigInt("1000000000000000000"));
    });

    it("distributes rewards proportionally to unequal VP", () => {
      const result = fn(minimalCsvResult, minimalGaugeMapping, unequalVoters);

      const voterA =
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]?.tokens[TOKEN_A] ??
        0n;
      const voterB =
        result["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]?.tokens[
          TOKEN_A
        ] ?? 0n;
      const total = voterA + voterB;

      // Total must equal reward amount
      expect(total).toBe(BigInt("1000000000000000000"));

      // Voter A (300 VP) should get ~75%, voter B (100 VP) ~25%
      // We allow 1 wei tolerance for rounding
      const expectedA = (BigInt("1000000000000000000") * 300n) / 400n;
      expect(voterA).toBeGreaterThanOrEqual(expectedA - 1n);
      expect(voterA).toBeLessThanOrEqual(expectedA + 1n);
    });

    it("handles split votes correctly", () => {
      const result = fn(minimalCsvResult, minimalGaugeMapping, splitVoteVoters);

      const voterA =
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]?.tokens[TOKEN_A] ??
        0n;
      const voterB =
        result["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]?.tokens[
          TOKEN_A
        ] ?? 0n;
      const total = voterA + voterB;

      // Total must equal reward amount
      expect(total).toBe(BigInt("1000000000000000000"));

      // Voter A: VP=200, choice split = {1:1, 2:1}, ratio for choice 1 = 50%
      //   effective VP = 200 * 0.5 = 100
      // Voter B: VP=100, choice = {1:1}, ratio for choice 1 = 100%
      //   effective VP = 100 * 1.0 = 100
      // Both should get ~50%
      expect(voterA + voterB).toBe(BigInt("1000000000000000000"));
    });

    it("excludes voters who did not vote for the gauge", () => {
      const result = fn(
        minimalCsvResult,
        minimalGaugeMapping,
        nonParticipatingVoter
      );

      // Only voter A voted for choice 1
      expect(recipientCount(result)).toBe(1);
      expect(
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]
      ).toBeDefined();
      expect(
        result["0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"]
      ).toBeUndefined();

      // Voter A gets everything
      const voterA =
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"].tokens[TOKEN_A];
      expect(voterA).toBe(BigInt("1000000000000000000"));
    });

    // --- Multi-gauge ---

    it("distributes across multiple gauges and tokens", () => {
      const result = fn(
        multiGaugeCsvResult,
        multiGaugeMapping,
        multiGaugeVoters
      );

      const voterA =
        result["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];
      expect(voterA).toBeDefined();

      // Should receive both tokens
      expect(voterA.tokens[TOKEN_A]).toBe(BigInt("1000000000000000000"));
      expect(voterA.tokens[TOKEN_B]).toBe(BigInt("2000000000000000000"));
    });

    // --- Edge cases ---

    it("returns empty distribution for empty CSV result", () => {
      const result = fn(emptyCsvResult, minimalGaugeMapping, twoEqualVoters);
      expect(recipientCount(result)).toBe(0);
    });

    it("returns empty distribution when no voters voted for any gauge", () => {
      const result = fn(minimalCsvResult, minimalGaugeMapping, emptyVotes);
      // With no voters, no one can receive rewards
      expect(recipientCount(result)).toBe(0);
    });

    it("throws when gauge is not found in gauge mapping", () => {
      expect(() =>
        fn(unmappedGaugeCsvResult, minimalGaugeMapping, twoEqualVoters)
      ).toThrow("Choice ID not found for gauge");
    });

    // --- Conservation of total rewards ---

    it("conserves total reward amount across all recipients (no rewards lost)", () => {
      // Use a prime number as reward to stress the division logic
      const primeRewardCsv = {
        "0x1111111111111111111111111111111111111111": [
          {
            rewardAddress: TOKEN_A,
            rewardAmount: BigInt("999999999999999997"), // prime-ish
          },
        ],
      };

      const result = fn(primeRewardCsv, minimalGaugeMapping, twoEqualVoters);
      const total = sumTokenAmounts(result, TOKEN_A);
      expect(total).toBe(BigInt("999999999999999997"));
    });

    // --- Zero reward amount ---

    it("handles zero reward amount without errors", () => {
      const zeroRewardCsv = {
        "0x1111111111111111111111111111111111111111": [
          {
            rewardAddress: TOKEN_A,
            rewardAmount: 0n,
          },
        ],
      };

      const result = fn(zeroRewardCsv, minimalGaugeMapping, twoEqualVoters);
      // With zero rewards, no distribution entries should exist
      expect(recipientCount(result)).toBe(0);
    });
  });
}

// --- Cross-implementation parity ---

describe("vlAURA vs vlCVX nonDelegators parity", () => {
  it("produces identical outputs for identical inputs (basic case)", () => {
    const resultA = computeVlAURA(
      minimalCsvResult,
      minimalGaugeMapping,
      twoEqualVoters
    );
    const resultB = computeVlCVX(
      minimalCsvResult,
      minimalGaugeMapping,
      twoEqualVoters
    );

    // Both should have the same recipients
    expect(Object.keys(resultA).sort()).toEqual(Object.keys(resultB).sort());

    // Both should distribute the same total
    const totalA = sumTokenAmounts(resultA, TOKEN_A);
    const totalB = sumTokenAmounts(resultB, TOKEN_A);
    expect(totalA).toBe(totalB);

    // Each voter should get the same amount in both implementations
    for (const voter of Object.keys(resultA)) {
      for (const token of Object.keys(resultA[voter].tokens)) {
        expect(resultA[voter].tokens[token]).toBe(
          resultB[voter].tokens[token]
        );
      }
    }
  });

  it("produces identical outputs for multi-gauge multi-token inputs", () => {
    const resultA = computeVlAURA(
      multiGaugeCsvResult,
      multiGaugeMapping,
      multiGaugeVoters
    );
    const resultB = computeVlCVX(
      multiGaugeCsvResult,
      multiGaugeMapping,
      multiGaugeVoters
    );

    expect(Object.keys(resultA).sort()).toEqual(Object.keys(resultB).sort());
    for (const voter of Object.keys(resultA)) {
      for (const token of Object.keys(resultA[voter].tokens)) {
        expect(resultA[voter].tokens[token]).toBe(
          resultB[voter].tokens[token]
        );
      }
    }
  });

  it("produces identical outputs for unequal voters", () => {
    const resultA = computeVlAURA(
      minimalCsvResult,
      minimalGaugeMapping,
      unequalVoters
    );
    const resultB = computeVlCVX(
      minimalCsvResult,
      minimalGaugeMapping,
      unequalVoters
    );

    for (const voter of Object.keys(resultA)) {
      for (const token of Object.keys(resultA[voter].tokens)) {
        expect(resultA[voter].tokens[token]).toBe(
          resultB[voter].tokens[token]
        );
      }
    }
  });
});
