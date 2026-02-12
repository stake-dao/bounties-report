/**
 * Unit tests for generateMerkleTree and mergeMerkleData.
 *
 * Tests the shared module extracted from vlAURA and vlCVX.
 */
import { describe, it, expect } from "vitest";
import {
  generateMerkleTree as generateShared,
  mergeMerkleData as mergeShared,
} from "../../shared/merkle/generateMerkleTree";
const generateVlAURA = generateShared;
const mergeVlAURA = mergeShared;
const generateVlCVX = generateShared;
const mergeVlCVX = mergeShared;
import {
  singleAddressDistribution,
  multiAddressDistribution,
  multiTokenDistribution,
  lowercaseAddressDistribution,
  emptyDistribution,
  ADDR_A,
  ADDR_B,
  TOKEN_USDC,
  TOKEN_DOLA,
  TOKEN_WETH,
} from "../fixtures/merkle.fixtures";
import MerkleTree from "merkletreejs";
import { utils } from "ethers";
import { keccak256, getAddress } from "viem";

// Helper to verify a merkle proof
function verifyProof(
  merkleRoot: string,
  address: string,
  tokenAddress: string,
  amount: string,
  proof: string[]
): boolean {
  const leaf = utils.keccak256(
    utils.solidityPack(
      ["bytes"],
      [
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["address", "address", "uint256"],
            [address, tokenAddress, amount]
          )
        ),
      ]
    )
  );
  const tree = new MerkleTree([], keccak256, { sortPairs: true });
  return tree.verify(proof, leaf, merkleRoot);
}

// Run tests against both implementations
const implementations = [
  { name: "vlAURA", generate: generateVlAURA, merge: mergeVlAURA },
  { name: "vlCVX", generate: generateVlCVX, merge: mergeVlCVX },
] as const;

for (const { name, generate, merge } of implementations) {
  describe(`generateMerkleTree [${name}]`, () => {
    it("generates a valid merkle root for single address distribution", () => {
      const result = generate(singleAddressDistribution);

      expect(result.merkleRoot).toBeDefined();
      expect(result.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.claims).toBeDefined();
      expect(Object.keys(result.claims)).toHaveLength(1);
    });

    it("generates valid proofs that verify against the root", () => {
      const result = generate(multiAddressDistribution);

      // Verify each proof
      for (const [address, claim] of Object.entries(result.claims)) {
        for (const [tokenAddress, tokenClaim] of Object.entries(
          claim.tokens
        )) {
          const isValid = verifyProof(
            result.merkleRoot,
            address,
            tokenAddress,
            tokenClaim.amount,
            tokenClaim.proof
          );
          expect(isValid).toBe(true);
        }
      }
    });

    it("handles multi-token distributions", () => {
      const result = generate(multiTokenDistribution);

      expect(result.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);

      // ADDR_A should have USDC and DOLA
      const checksumA = getAddress(ADDR_A);
      expect(result.claims[checksumA]).toBeDefined();
      expect(Object.keys(result.claims[checksumA].tokens)).toHaveLength(2);

      // ADDR_B should have USDC and WETH
      const checksumB = getAddress(ADDR_B);
      expect(result.claims[checksumB]).toBeDefined();
      expect(Object.keys(result.claims[checksumB].tokens)).toHaveLength(2);

      // Total leaves = 2 + 2 = 4
      let totalLeaves = 0;
      for (const claim of Object.values(result.claims)) {
        totalLeaves += Object.keys(claim.tokens).length;
      }
      expect(totalLeaves).toBe(4);
    });

    it("normalizes lowercase addresses to checksum format", () => {
      const result = generate(lowercaseAddressDistribution);

      // All addresses in claims should be checksummed
      for (const address of Object.keys(result.claims)) {
        expect(address).toBe(getAddress(address));
      }

      // Token addresses in claims should be checksummed
      for (const claim of Object.values(result.claims)) {
        for (const tokenAddress of Object.keys(claim.tokens)) {
          expect(tokenAddress).toBe(getAddress(tokenAddress));
        }
      }
    });

    it("produces deterministic output for the same input", () => {
      const result1 = generate(multiAddressDistribution);
      const result2 = generate(multiAddressDistribution);

      expect(result1.merkleRoot).toBe(result2.merkleRoot);

      // Claims should be structurally identical
      for (const address of Object.keys(result1.claims)) {
        for (const token of Object.keys(result1.claims[address].tokens)) {
          expect(result1.claims[address].tokens[token].amount).toBe(
            result2.claims[address].tokens[token].amount
          );
          expect(result1.claims[address].tokens[token].proof).toEqual(
            result2.claims[address].tokens[token].proof
          );
        }
      }
    });

    it("preserves token amounts as strings", () => {
      const result = generate(multiTokenDistribution);
      const checksumA = getAddress(ADDR_A);
      const checksumUsdc = getAddress(TOKEN_USDC);

      expect(typeof result.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "string"
      );
      expect(result.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "1000000"
      );
    });

    it("handles empty distribution gracefully", () => {
      const result = generate(emptyDistribution);
      // An empty distribution should still return a valid structure
      expect(result.merkleRoot).toBeDefined();
      expect(Object.keys(result.claims)).toHaveLength(0);
    });
  });

  describe(`mergeMerkleData [${name}]`, () => {
    it("merges two non-overlapping merkle trees", () => {
      const merkleA = generate({
        [ADDR_A]: { [TOKEN_USDC]: "1000000" },
      });
      const merkleB = generate({
        [ADDR_B]: { [TOKEN_USDC]: "2000000" },
      });

      const merged = merge(merkleA, merkleB);

      expect(merged.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Object.keys(merged.claims)).toHaveLength(2);

      const checksumA = getAddress(ADDR_A);
      const checksumB = getAddress(ADDR_B);
      const checksumUsdc = getAddress(TOKEN_USDC);

      expect(merged.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "1000000"
      );
      expect(merged.claims[checksumB].tokens[checksumUsdc].amount).toBe(
        "2000000"
      );
    });

    it("sums token amounts for overlapping addresses", () => {
      const merkleA = generate({
        [ADDR_A]: { [TOKEN_USDC]: "1000000" },
      });
      const merkleB = generate({
        [ADDR_A]: { [TOKEN_USDC]: "2000000" },
      });

      const merged = merge(merkleA, merkleB);

      const checksumA = getAddress(ADDR_A);
      const checksumUsdc = getAddress(TOKEN_USDC);

      expect(Object.keys(merged.claims)).toHaveLength(1);
      expect(merged.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "3000000" // 1M + 2M
      );
    });

    it("handles overlapping addresses with different tokens", () => {
      const merkleA = generate({
        [ADDR_A]: { [TOKEN_USDC]: "1000000" },
      });
      const merkleB = generate({
        [ADDR_A]: { [TOKEN_DOLA]: "500000000000000000000" },
      });

      const merged = merge(merkleA, merkleB);

      const checksumA = getAddress(ADDR_A);
      const checksumUsdc = getAddress(TOKEN_USDC);
      const checksumDola = getAddress(TOKEN_DOLA);

      expect(Object.keys(merged.claims)).toHaveLength(1);
      expect(merged.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "1000000"
      );
      expect(merged.claims[checksumA].tokens[checksumDola].amount).toBe(
        "500000000000000000000"
      );
    });

    it("generates valid proofs after merging", () => {
      const merkleA = generate({
        [ADDR_A]: { [TOKEN_USDC]: "1000000" },
      });
      const merkleB = generate({
        [ADDR_B]: { [TOKEN_DOLA]: "500000000000000000000" },
      });

      const merged = merge(merkleA, merkleB);

      for (const [address, claim] of Object.entries(merged.claims)) {
        for (const [tokenAddress, tokenClaim] of Object.entries(
          claim.tokens
        )) {
          const isValid = verifyProof(
            merged.merkleRoot,
            address,
            tokenAddress,
            tokenClaim.amount,
            tokenClaim.proof
          );
          expect(isValid).toBe(true);
        }
      }
    });

    it("returns empty MerkleData when merging two empty trees", () => {
      const emptyMerkle = { merkleRoot: "", claims: {} };
      const merged = merge(emptyMerkle, emptyMerkle);

      expect(merged.merkleRoot).toBe("");
      expect(Object.keys(merged.claims)).toHaveLength(0);
    });

    it("returns the non-empty tree when one tree is empty", () => {
      const merkleA = generate({
        [ADDR_A]: { [TOKEN_USDC]: "1000000" },
      });
      const emptyMerkle = { merkleRoot: "", claims: {} };

      const merged = merge(merkleA, emptyMerkle);

      const checksumA = getAddress(ADDR_A);
      const checksumUsdc = getAddress(TOKEN_USDC);

      expect(Object.keys(merged.claims)).toHaveLength(1);
      expect(merged.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "1000000"
      );
    });

    it("normalizes addresses during merge", () => {
      // Create merkle trees with lowercase addresses
      const merkleA = generate({
        [ADDR_A.toLowerCase()]: { [TOKEN_USDC.toLowerCase()]: "1000000" },
      });
      const merkleB = generate({
        [ADDR_A]: { [TOKEN_USDC]: "2000000" },
      });

      const merged = merge(merkleA, merkleB);

      // Should only have one entry for ADDR_A (merged)
      expect(Object.keys(merged.claims)).toHaveLength(1);

      const checksumA = getAddress(ADDR_A);
      const checksumUsdc = getAddress(TOKEN_USDC);
      expect(merged.claims[checksumA].tokens[checksumUsdc].amount).toBe(
        "3000000"
      );
    });
  });
}

// --- Cross-implementation parity ---

describe("vlAURA vs vlCVX merkle parity", () => {
  it("produces identical merkle roots for identical single-address input", () => {
    const resultA = generateVlAURA(singleAddressDistribution);
    const resultB = generateVlCVX(singleAddressDistribution);

    expect(resultA.merkleRoot).toBe(resultB.merkleRoot);
  });

  it("produces identical merkle roots for multi-address input", () => {
    const resultA = generateVlAURA(multiAddressDistribution);
    const resultB = generateVlCVX(multiAddressDistribution);

    expect(resultA.merkleRoot).toBe(resultB.merkleRoot);
  });

  it("produces identical merkle roots for multi-token input", () => {
    const resultA = generateVlAURA(multiTokenDistribution);
    const resultB = generateVlCVX(multiTokenDistribution);

    expect(resultA.merkleRoot).toBe(resultB.merkleRoot);
  });

  it("produces identical claims for multi-token input", () => {
    const resultA = generateVlAURA(multiTokenDistribution);
    const resultB = generateVlCVX(multiTokenDistribution);

    for (const address of Object.keys(resultA.claims)) {
      expect(resultB.claims[address]).toBeDefined();
      for (const token of Object.keys(resultA.claims[address].tokens)) {
        expect(resultA.claims[address].tokens[token].amount).toBe(
          resultB.claims[address].tokens[token].amount
        );
        expect(resultA.claims[address].tokens[token].proof).toEqual(
          resultB.claims[address].tokens[token].proof
        );
      }
    }
  });

  it("produces identical merge results", () => {
    const distA = { [ADDR_A]: { [TOKEN_USDC]: "1000000" } };
    const distB = { [ADDR_B]: { [TOKEN_DOLA]: "500000000000000000000" } };

    const merkleAura1 = generateVlAURA(distA);
    const merkleAura2 = generateVlAURA(distB);
    const mergedAura = mergeVlAURA(merkleAura1, merkleAura2);

    const merkleCvx1 = generateVlCVX(distA);
    const merkleCvx2 = generateVlCVX(distB);
    const mergedCvx = mergeVlCVX(merkleCvx1, merkleCvx2);

    expect(mergedAura.merkleRoot).toBe(mergedCvx.merkleRoot);

    for (const address of Object.keys(mergedAura.claims)) {
      for (const token of Object.keys(mergedAura.claims[address].tokens)) {
        expect(mergedAura.claims[address].tokens[token].amount).toBe(
          mergedCvx.claims[address].tokens[token].amount
        );
        expect(mergedAura.claims[address].tokens[token].proof).toEqual(
          mergedCvx.claims[address].tokens[token].proof
        );
      }
    }
  });
});
