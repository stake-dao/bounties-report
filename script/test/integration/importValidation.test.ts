/**
 * Import Validation Tests
 *
 * These tests verify that all modules import correctly after the refactor
 * that moved shared functions to script/shared/.
 *
 * Shared modules:
 *   - script/shared/nonDelegators.ts (computeNonDelegatorsDistribution, Distribution)
 *   - script/shared/merkle/generateMerkleTree.ts (generateMerkleTree, mergeMerkleData)
 *
 * vlCVX/utils.ts retains protocol-specific exports:
 *   - getSCRVUsdTransfer (used by createDelegatorsMerkle.ts and computevlCVXDelegatorsAPR.ts)
 */
import { describe, it, expect } from "vitest";

describe("shared/nonDelegators.ts exports", () => {
  it("exports computeNonDelegatorsDistribution as a function", async () => {
    const mod = await import("../../shared/nonDelegators");
    expect(typeof mod.computeNonDelegatorsDistribution).toBe("function");
  });

  it("exports Distribution type (module loads without errors)", async () => {
    const mod = await import("../../shared/nonDelegators");
    expect(mod).toBeDefined();
  });
});

describe("shared/merkle/generateMerkleTree.ts exports", () => {
  it("exports generateMerkleTree as a function", async () => {
    const mod = await import("../../shared/merkle/generateMerkleTree");
    expect(typeof mod.generateMerkleTree).toBe("function");
  });

  it("exports mergeMerkleData as a function", async () => {
    const mod = await import("../../shared/merkle/generateMerkleTree");
    expect(typeof mod.mergeMerkleData).toBe("function");
  });
});

describe("vlCVX/utils.ts protocol-specific exports", () => {
  it("exports getSCRVUsdTransfer as a function", async () => {
    const mod = await import("../../vlCVX/utils");
    expect(typeof mod.getSCRVUsdTransfer).toBe("function");
  });
});

describe("Shared module functional correctness", () => {
  it("generateMerkleTree produces valid merkle root", async () => {
    const { generateMerkleTree } = await import(
      "../../shared/merkle/generateMerkleTree"
    );

    const testDistribution = {
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045": {
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "1000000",
      },
    };

    const result = generateMerkleTree(testDistribution);
    expect(result.merkleRoot).toBeTruthy();
    expect(result.merkleRoot.startsWith("0x")).toBe(true);
  });

  it("computeNonDelegatorsDistribution produces correct distribution", async () => {
    const { computeNonDelegatorsDistribution } = await import(
      "../../shared/nonDelegators"
    );

    const csvResult = {
      "0x1111111111111111111111111111111111111111": [
        {
          rewardAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          rewardAmount: BigInt("1000000000000000000"),
        },
      ],
    };
    const gaugeMapping = {
      "0x1111111111111111111111111111111111111111": { choiceId: 1 },
    };
    const votes = [
      {
        voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        vp: 100,
        choice: { "1": 1 },
      },
    ];

    const result = computeNonDelegatorsDistribution(
      csvResult,
      gaugeMapping,
      votes
    );
    expect(Object.keys(result).length).toBeGreaterThan(0);
  });
});
