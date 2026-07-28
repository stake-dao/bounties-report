import { describe, it, expect } from "vitest";
import { keccak256 } from "viem";
import MerkleTree from "merkletreejs";
import {
  computeLeaf,
  computeRoot,
  toPairMap,
} from "../../verify/invariants/artifact";
import { findDuplicateKeys } from "../../verify/invariants/jsonSafe";
import {
  checkPreservation,
  unionPairKeys,
} from "../../verify/invariants/preservation";
import {
  checkDeltaExclusivity,
  positiveDeltas,
} from "../../verify/invariants/exclusivity";
import { PairMap, Violation } from "../../verify/invariants/types";
import { MerkleData } from "../../interfaces/MerkleData";

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const T1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC (checksummed)
const T2 = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367"; // sCRVUSD

const ctx = {
  target: "voters" as const,
  chainId: 1,
  distributor: "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db" as `0x${string}`,
  pinnedBlock: 0n,
};

function pairs(entries: [string, string, bigint][]): PairMap {
  const m: PairMap = new Map();
  for (const [account, token, amount] of entries) {
    if (!m.has(account)) m.set(account, new Map());
    m.get(account)!.set(token, amount);
  }
  return m;
}

function merkleDataFrom(entries: [string, string, bigint][]): MerkleData {
  const p = pairs(entries);
  const leaves = entries.map(([a, t, amt]) =>
    computeLeaf(a as `0x${string}`, t as `0x${string}`, amt)
  );
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const claims: MerkleData["claims"] = {};
  for (const [account, token, amount] of entries) {
    if (!claims[account]) claims[account] = { tokens: {} };
    claims[account].tokens[token] = {
      amount: amount.toString(),
      proof: tree.getHexProof(
        computeLeaf(account as `0x${string}`, token as `0x${string}`, amount)
      ),
    };
  }
  return { merkleRoot: computeRoot(p), claims };
}

describe("invariants: structural", () => {
  it("recomputes the same root as the generator encoding", () => {
    const data = merkleDataFrom([
      [A1, T1, 100n],
      [A2, T1, 50n],
      [A2, T2, 7n],
    ]);
    expect(computeRoot(toPairMap(data))).toBe(data.merkleRoot);
  });

  it("flags duplicate (account, token) pairs across case variants", () => {
    const violations: Omit<Violation, "target" | "chainId">[] = [];
    // T1 checksummed vs lowercased are distinct JSON keys for the same account.
    toPairMap(
      {
        merkleRoot: "0x",
        claims: {
          [T1]: { tokens: { [T2]: { amount: "1", proof: [] } } },
          [T1.toLowerCase()]: { tokens: { [T2.toLowerCase()]: { amount: "2", proof: [] } } },
        },
      } as unknown as MerkleData,
      (v) => violations.push(v)
    );
    expect(violations.some((v) => v.invariant === "STRUCT_DUPLICATE_PAIR")).toBe(true);
  });

  it("rejects zero, negative-ish and non-integer amounts", () => {
    for (const bad of ["0", "-5", "1.5", "0x10", ""]) {
      const violations: Omit<Violation, "target" | "chainId">[] = [];
      toPairMap(
        {
          merkleRoot: "0x",
          claims: { [A1]: { tokens: { [T1]: { amount: bad, proof: [] } } } },
        } as unknown as MerkleData,
        (v) => violations.push(v)
      );
      expect(
        violations.some((v) => v.invariant === "STRUCT_BAD_AMOUNT"),
        `amount "${bad}" should be rejected`
      ).toBe(true);
    }
  });

  it("detects duplicate JSON keys that JSON.parse would silently merge", () => {
    const text = `{"claims":{"${A1}":{"tokens":{"${T1}":{"amount":"1"},"${T1}":{"amount":"9"}}}}}`;
    const dups = findDuplicateKeys(text);
    expect(dups.length).toBe(1);
    expect(dups[0].key).toBe(T1);
  });

  it("accepts clean JSON with repeated keys in different objects", () => {
    const text = `{"a":{"x":1},"b":{"x":2}}`;
    expect(findDuplicateKeys(text)).toHaveLength(0);
  });

  it("detects duplicates hidden behind unicode escape spellings", () => {
    // "a" decodes to "a": JSON.parse merges them, the scanner must too.
    const text = `{"a":1,"\\u0061":2}`;
    expect(findDuplicateKeys(text)).toHaveLength(1);
  });
});

describe("invariants: CLI argument validation", () => {
  it("rejects unknown --target values instead of passing an empty run", async () => {
    const { parseTarget } = await import("../../verify/invariants/cli");
    expect(() => parseTarget("voter")).toThrow(/invalid --target/);
    expect(parseTarget("voters")).toBe("voters");
    expect(parseTarget(undefined)).toBe("both");
  });
});

describe("invariants: waiver capping", () => {
  it("never waives a violation lacking a quantified deficit", async () => {
    const { applyWaivers } = await import("../../verify/invariants/waivers");
    const violation: Violation = {
      invariant: "EXCL_DELTA_OVERLAP",
      severity: "CRITICAL",
      target: "voters",
      chainId: 1,
      subject: `${T1} / ${T2}`,
      detail: "test",
      // deficit intentionally absent
    };
    const { active, waived } = applyWaivers([violation], [
      {
        invariant: "EXCL_DELTA_OVERLAP",
        chainId: 1,
        target: "voters",
        account: T1,
        token: T2,
        maxDeficit: "999999999999999999999999",
        reason: "should not apply",
        addedBy: "test",
        addedAt: "2026-07-28",
      },
    ]);
    expect(waived).toHaveLength(0);
    expect(active).toHaveLength(1);
  });

  it("re-fires when the measured deficit exceeds the waiver cap", async () => {
    const { applyWaivers } = await import("../../verify/invariants/waivers");
    const base = {
      invariant: "PRESERVE_BELOW_CLAIMED" as const,
      severity: "CRITICAL" as const,
      target: "voters" as const,
      chainId: 1,
      subject: `${T1} / ${T2}`,
      detail: "test",
    };
    const waiver = {
      invariant: "PRESERVE_BELOW_CLAIMED" as const,
      chainId: 1,
      target: "voters" as const,
      account: T1,
      token: T2,
      maxDeficit: "100",
      reason: "capped",
      addedBy: "test",
      addedAt: "2026-07-28",
    };
    const under = applyWaivers([{ ...base, deficit: 100n }], [waiver]);
    expect(under.waived).toHaveLength(1);
    const over = applyWaivers([{ ...base, deficit: 101n }], [waiver]);
    expect(over.active).toHaveLength(1);
    expect(over.waived).toHaveLength(0);
  });
});

describe("invariants: cumulative preservation", () => {
  it("passes when amounts grow and nothing disappears", () => {
    const violations: Violation[] = [];
    const baseline = pairs([[A1, T1, 100n]]);
    const current = pairs([
      [A1, T1, 150n],
      [A2, T1, 10n],
    ]);
    checkPreservation(ctx, current, baseline, new Map(), violations);
    expect(violations).toHaveLength(0);
  });

  it("flags a reduced cumulative amount even when partially claimed", () => {
    const violations: Violation[] = [];
    const baseline = pairs([[A1, T1, 100n]]);
    const current = pairs([[A1, T1, 60n]]);
    const claimed = new Map([[`${A1}:${T1}`, 20n]]);
    checkPreservation(ctx, current, baseline, claimed, violations);
    expect(violations.map((v) => v.invariant)).toContain("PRESERVE_AMOUNT_REDUCED");
  });

  it("flags a removed pair with an unclaimed remainder", () => {
    const violations: Violation[] = [];
    const baseline = pairs([[A1, T1, 100n]]);
    const claimed = new Map([[`${A1}:${T1}`, 40n]]);
    checkPreservation(ctx, pairs([]), baseline, claimed, violations);
    expect(violations.map((v) => v.invariant)).toContain("PRESERVE_PAIR_REMOVED");
  });

  it("allows removal of a fully-claimed pair", () => {
    const violations: Violation[] = [];
    const baseline = pairs([[A1, T1, 100n]]);
    const claimed = new Map([[`${A1}:${T1}`, 100n]]);
    checkPreservation(ctx, pairs([]), baseline, claimed, violations);
    expect(violations).toHaveLength(0);
  });

  it("flags proposed amounts below claimedOnChain (claim would revert)", () => {
    const violations: Violation[] = [];
    const current = pairs([[A2, T2, 5n]]);
    const claimed = new Map([[`${A2}:${T2}`, 9n]]);
    checkPreservation(ctx, current, pairs([]), claimed, violations);
    expect(violations.map((v) => v.invariant)).toContain("PRESERVE_BELOW_CLAIMED");
  });

  it("builds the union of pair keys without duplicates", () => {
    const keys = unionPairKeys(pairs([[A1, T1, 1n]]), pairs([[A1, T1, 2n], [A2, T2, 3n]]));
    expect(keys).toHaveLength(2);
  });
});

describe("invariants: delta-scoped exclusivity", () => {
  it("ignores historical carryover present in both cumulative trees", () => {
    const violations: Violation[] = [];
    // A1 has an old sCRVUSD entry on both sides, unchanged this epoch.
    const votersBase = pairs([[A1, T2, 100n]]);
    const votersCurr = pairs([[A1, T2, 100n], [A2, T1, 5n]]);
    const delegBase = pairs([[A1, T2, 40n]]);
    const delegCurr = pairs([[A1, T2, 40n]]);
    checkDeltaExclusivity(
      1,
      positiveDeltas(votersCurr, votersBase),
      positiveDeltas(delegCurr, delegBase),
      violations
    );
    expect(violations).toHaveLength(0);
  });

  it("flags the same (account, token) receiving on both sides this epoch", () => {
    const violations: Violation[] = [];
    const votersCurr = pairs([[A1, T2, 110n]]);
    const votersBase = pairs([[A1, T2, 100n]]);
    const delegCurr = pairs([[A1, T2, 50n]]);
    const delegBase = pairs([[A1, T2, 40n]]);
    checkDeltaExclusivity(
      1,
      positiveDeltas(votersCurr, votersBase),
      positiveDeltas(delegCurr, delegBase),
      violations
    );
    expect(violations.map((v) => v.invariant)).toContain("EXCL_DELTA_OVERLAP");
  });

  it("does not flag different tokens for the same account", () => {
    const violations: Violation[] = [];
    checkDeltaExclusivity(
      1,
      positiveDeltas(pairs([[A1, T1, 10n]]), pairs([])),
      positiveDeltas(pairs([[A1, T2, 10n]]), pairs([])),
      violations
    );
    expect(violations).toHaveLength(0);
  });
});
