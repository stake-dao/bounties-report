import { describe, expect, it } from "vitest";
import { decodeAbiParameters, getAddress, zeroHash } from "viem";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { bootstrapExpiryLedger, expiryKey } from "../../shared/merkle/expiry";
import { monthlyReview, recoverLedger } from "../../recovery/monthly";
import { BATCH, transition } from "../../recovery/transition";
import { VOTERS, TREASURY_RECIPIENT, RECIPIENT, pairKey, refreshRecovery } from "../../recovery/prepare";

const account = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const token = account(99999), other = account(99998), module = account(99997);

describe("automatic expiry transition", () => {
  it("finishes a multi-chunk period only after every eligible row is adopted, preserving younger and legacy rights", () => {
    const distribution: Record<string, Record<string, string>> = {};
    const claims: Record<string, string> = {};
    for (let i = 1; i <= 517; i++) {
      distribution[account(i)] = { [token]: "103", [other]: "19" };
      claims[expiryKey(account(i), token)] = "3";
      claims[expiryKey(account(i), other)] = "0";
    }
    distribution[RECIPIENT] = { [token]: "17" };
    distribution[TREASURY_RECIPIENT] = { [token]: "0", [other]: "0" };
    claims[expiryKey(RECIPIENT, token)] = "0";
    claims[expiryKey(TREASURY_RECIPIENT, token)] = "0";
    claims[expiryKey(TREASURY_RECIPIENT, other)] = "0";
    let source = generateMerkleTree(distribution);
    let ledger = bootstrapExpiryLedger(1, [
      { root: zeroHash, merkle: null, block: 1, blockHash: zeroHash, timestamp: 1, logIndex: 0 },
      { root: source.merkleRoot, merkle: source, block: 2, blockHash: zeroHash, timestamp: 2, logIndex: 0 },
    ], claims, { block: 2, blockHash: zeroHash }, null, VOTERS);
    for (const pair of Object.values(ledger.pairs)) if (pair.token === other) for (const credit of pair.credits) credit.protection = "recent source";
    const counts: number[] = [];
    for (let chunk = 0; chunk < 4; chunk++) {
      const review = monthlyReview(ledger, 1800000000, "2027-01", TREASURY_RECIPIENT, true, chunk === 0 ? { [token]: 37n } : {});
      if (!review.rows.length) break;
      counts.push(review.rows.length);
      const counters = new Map(Object.values(ledger.pairs).map(pair => [pairKey(pair.account, pair.token), BigInt(pair.paid)]));
      const recovery = refreshRecovery(review, source, counters, chunk === 0 ? { [token]: 37n } : {});
      const encoded = transition(review, source, recovery, module, BigInt(chunk), zeroHash);
      const [batch] = decodeAbiParameters(BATCH, encoded.payload);
      expect(batch.rows.length).toBe(review.rows.length);
      expect(batch.credits[0].fundingOffset).toBe(chunk === 0 ? 37n : 0n);
      expect(batch.expectedProposal).toBe(zeroHash);
      const replacement = transition(review, source, recovery, module, BigInt(chunk), encoded.proposal);
      expect(replacement.expectedProposal).toBe(encoded.proposal);
      expect(decodeAbiParameters(BATCH, replacement.payload)[0].expectedProposal).toBe(encoded.proposal);
      expect(replacement.payload).not.toBe(encoded.payload);
      expect(replacement.proposal).not.toBe(encoded.proposal);
      ledger = recoverLedger(ledger, review, recovery.rows, recovery.merkle, { block: 3 + chunk, blockHash: zeroHash, logIndex: 1 });
      source = recovery.merkle;
      if (chunk < 2) expect(monthlyReview(ledger, review.cutoff, review.period!, TREASURY_RECIPIENT, true).rows.length).toBeGreaterThan(0);
    }
    expect(counts).toEqual([256, 256, 5]);
    expect(source.claims[TREASURY_RECIPIENT].tokens[token].amount).toBe("51663");
    expect(source.claims[RECIPIENT].tokens[token].amount).toBe("17");
    for (let i = 1; i <= 517; i++) {
      expect(source.claims[account(i)].tokens[token].amount).toBe("3");
      expect(source.claims[account(i)].tokens[other].amount).toBe("19");
    }
    expect(monthlyReview(ledger, 1800000000, "2027-01", TREASURY_RECIPIENT, true).rows).toEqual([]);
  });

  it("refuses missing Treasury membership instead of inserting a fictitious zero leaf", () => {
    const source = generateMerkleTree({ [account(1)]: { [token]: "103" } });
    const review = { chainId: 1, distributor: VOTERS, recipient: TREASURY_RECIPIENT, sourceRoot: source.merkleRoot, sourceFile: "fixture", cutoff: 1, checkpoint: { block: "1", hash: zeroHash }, provenance: "fixture", rows: [{ account: account(1), token, claimed: "3", maximum: "100" }] };
    const result = refreshRecovery(review, source, new Map([[pairKey(account(1), token), 3n]]));
    expect(() => transition(review, source, result, module, 0n, zeroHash)).toThrow("Treasury leaf absent");
  });
});
