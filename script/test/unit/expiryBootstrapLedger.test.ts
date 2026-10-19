import { describe, expect, it } from "vitest";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { assertExpiryLedger, bootstrapExpiryLedger, expiryKey, Publication } from "../../shared/merkle/expiry";

describe("expiry bootstrap checkpoint refresh", () => {
  it("advances the root while preserving unknown and Union credits and FIFO claims", () => {
    const account = "0x0000000000000000000000000000000000000001";
    const token = "0x0000000000000000000000000000000000000002";
    const key = expiryKey(account, token);
    const blockHash = `0x${"1".repeat(64)}`;
    const publication = (block: number, amount: string): Publication => {
      const merkle = generateMerkleTree({ [account]: { [token]: amount } });
      return { root: merkle.merkleRoot, timestamp: block * 86400, block, blockHash, merkle };
    };
    const publications: Publication[] = [
      { root: `0x${"0".repeat(64)}`, timestamp: 0, block: 0, blockHash, merkle: null },
      { root: `0x${"2".repeat(64)}`, timestamp: 86400, block: 1, blockHash, merkle: null },
      publication(2, "100"),
      publication(3, "200"),
    ];
    const union = { root: publications[3].root, amounts: { [key]: "60" } };
    const before = bootstrapExpiryLedger(1, publications, { [key]: "20" }, { block: 3, blockHash }, union);
    const next = publication(4, "250");
    const refreshed = bootstrapExpiryLedger(1, [...publications, next], { [key]: "25" }, { block: 4, blockHash }, union);

    expect(refreshed.checkpoint.block).toBeGreaterThan(before.checkpoint.block);
    expect(refreshed.root).toBe(next.root);
    expect(refreshed.root).not.toBe(before.root);
    const credits = refreshed.pairs[key].credits;
    expect(credits.filter(credit => credit.protection !== null)).toEqual([
      { ...before.pairs[key].credits[0], paid: "25" },
      before.pairs[key].credits[2],
    ]);
    expect(credits.map(credit => credit.protection)).toEqual([
      "unresolved history", null, "unresolved Union ageing", null,
    ]);
    expect(credits[3].granted).toBe("50");
    expect(credits[3].activatedAt).toBe(next.timestamp);
    expect(credits.reduce((sum, credit) => sum + BigInt(credit.granted) - BigInt(credit.paid) - BigInt(credit.recovered), 0n)).toBe(225n);
    expect(() => assertExpiryLedger(refreshed)).not.toThrow();
  });
});
