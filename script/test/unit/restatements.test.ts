/**
 * Unit tests for epoch-scoped restatement credits: exact subtraction, the
 * delta cap, scope filters (epoch/target/chain), the root pin, and every
 * fail-closed path (missing file, drifted ledger, malformed registry entry).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { computeRoot } from "../../verify/invariants/artifact";
import {
  RestatementEntry,
  applyRestatementCredits,
  clearJustifiedRemovals,
  loadRestatements,
} from "../../verify/invariants/restatements";
import { PairMap, Violation } from "../../verify/invariants/types";

const ACCT = getAddress("0x1111000000000000000000000000000000000011");
const OTHER = getAddress("0x2222000000000000000000000000000000000022");
const CRV = getAddress("0xD533a949740bb3306d119CC777fa900bA034cd52");
const CVX = getAddress("0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B");

function pairs(entries: [string, string, bigint][]): PairMap {
  const m: PairMap = new Map();
  for (const [account, token, amount] of entries) {
    if (!m.has(account)) m.set(account, new Map());
    m.get(account)!.set(token, amount);
  }
  return m;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "restatements-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a MerkleData-shaped credits ledger and return its entry. */
function writeLedger(
  entries: [string, string, bigint][],
  overrides: Partial<RestatementEntry> = {}
): RestatementEntry {
  const claims: Record<string, { tokens: Record<string, { amount: string }> }> =
    {};
  for (const [account, token, amount] of entries) {
    claims[account] ??= { tokens: {} };
    claims[account].tokens[token] = { amount: amount.toString() };
  }
  const file = path.join(dir, "credits.json");
  fs.writeFileSync(file, JSON.stringify({ claims }));
  return {
    target: "voters",
    chainId: 1,
    epoch: 1786579200,
    creditsFile: file,
    creditsRoot: computeRoot(pairs(entries)).toLowerCase(),
    reason: "test",
    addedBy: "test",
    addedAt: "2026-08-18",
    ...overrides,
  };
}

const SCOPE = { target: "voters" as const, chainId: 1, epoch: 1786579200 };

describe("applyRestatementCredits", () => {
  it("subtracts a wei-exact credit, removing the pair from the delta", () => {
    const entry = writeLedger([[ACCT, CRV, 100n]]);
    const violations: Violation[] = [];
    const { deltas, applied } = applyRestatementCredits(
      pairs([[ACCT, CRV, 100n], [OTHER, CRV, 7n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toEqual([]);
    expect(deltas.has(ACCT)).toBe(false);
    expect(deltas.get(OTHER)?.get(CRV)).toBe(7n);
    expect(applied).toHaveLength(1);
    expect(applied[0].creditedPairs).toBe(1);
    expect(applied[0].creditedAddresses).toBe(1);
  });

  it("keeps the residual when the delta exceeds the credit", () => {
    const entry = writeLedger([[ACCT, CRV, 100n]]);
    const violations: Violation[] = [];
    const { deltas } = applyRestatementCredits(
      pairs([[ACCT, CRV, 130n], [ACCT, CVX, 5n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toEqual([]);
    expect(deltas.get(ACCT)?.get(CRV)).toBe(30n);
    expect(deltas.get(ACCT)?.get(CVX)).toBe(5n);
  });

  it("refuses an entry whose credit exceeds the measured delta (ledger/artifact mismatch)", () => {
    const entry = writeLedger([[ACCT, CRV, 1000n]]);
    const violations: Violation[] = [];
    const { deltas, applied } = applyRestatementCredits(
      pairs([[ACCT, CRV, 40n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe("RESTATEMENT_CREDITS_INVALID");
    expect(violations[0].severity).toBe("CRITICAL");
    expect(applied).toEqual([]);
    expect(deltas.get(ACCT)?.get(CRV)).toBe(40n);
  });

  it("refuses an entry with a credited pair absent from the delta", () => {
    const entry = writeLedger([[ACCT, CRV, 100n], [OTHER, CVX, 5n]]);
    const violations: Violation[] = [];
    const { deltas } = applyRestatementCredits(
      pairs([[ACCT, CRV, 100n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe("RESTATEMENT_CREDITS_INVALID");
    expect(violations[0].detail).toContain(OTHER);
    expect(deltas.get(ACCT)?.get(CRV)).toBe(100n);
  });

  it("is inert outside its own epoch, target, and chain", () => {
    const delta = pairs([[ACCT, CRV, 100n]]);
    for (const overrides of [
      { epoch: 1785974400 },
      { target: "delegators" as const },
      { chainId: 8453 },
    ]) {
      const entry = writeLedger([[ACCT, CRV, 100n]], overrides);
      const violations: Violation[] = [];
      const { deltas, applied } = applyRestatementCredits(
        delta,
        [entry],
        SCOPE,
        violations
      );
      expect(violations).toEqual([]);
      expect(applied).toEqual([]);
      expect(deltas.get(ACCT)?.get(CRV)).toBe(100n);
    }
  });

  it("fails closed on a drifted ledger (pin mismatch) without applying credits", () => {
    const entry = writeLedger([[ACCT, CRV, 100n]], {
      creditsRoot:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    const violations: Violation[] = [];
    const { deltas } = applyRestatementCredits(
      pairs([[ACCT, CRV, 100n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe("RESTATEMENT_CREDITS_INVALID");
    expect(violations[0].severity).toBe("CRITICAL");
    expect(deltas.get(ACCT)?.get(CRV)).toBe(100n);
  });

  it("fails closed when the credits file is missing", () => {
    const entry = writeLedger([[ACCT, CRV, 100n]], {
      creditsFile: path.join(dir, "does-not-exist.json"),
    });
    const violations: Violation[] = [];
    const { deltas } = applyRestatementCredits(
      pairs([[ACCT, CRV, 100n]]),
      [entry],
      SCOPE,
      violations
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe("RESTATEMENT_CREDITS_INVALID");
    expect(deltas.get(ACCT)?.get(CRV)).toBe(100n);
  });

  it("applies multiple matching entries sequentially", () => {
    const first = writeLedger([[ACCT, CRV, 60n]]);
    const secondFile = path.join(dir, "credits2.json");
    fs.writeFileSync(
      secondFile,
      JSON.stringify({
        claims: { [ACCT]: { tokens: { [CRV]: { amount: "40" } } } },
      })
    );
    const second: RestatementEntry = {
      ...first,
      creditsFile: secondFile,
      creditsRoot: computeRoot(pairs([[ACCT, CRV, 40n]])).toLowerCase(),
    };
    const violations: Violation[] = [];
    const { deltas } = applyRestatementCredits(
      pairs([[ACCT, CRV, 100n]]),
      [first, second],
      SCOPE,
      violations
    );
    expect(violations).toEqual([]);
    expect(deltas.size).toBe(0);
  });
});

describe("clearJustifiedRemovals", () => {
  const SUPERSEDED =
    "0xd07fb1010000000000000000000000000000000000000000000000000000cafe";

  const entry = (removals: { account: string; token: string; amount: string }[]): RestatementEntry => ({
    target: "voters",
    chainId: 1,
    epoch: 1786579200,
    creditsFile: "unused.json",
    creditsRoot: "0x00",
    supersededRoot: SUPERSEDED,
    justifiedRemovals: removals,
    reason: "test",
    addedBy: "test",
    addedAt: "2026-08-18",
  });

  const removedViolation = (deficit: bigint): Violation & { deficit: bigint } => ({
    invariant: "PRESERVE_PAIR_REMOVED",
    severity: "CRITICAL",
    target: "voters",
    chainId: 1,
    subject: `${ACCT} / ${CRV}`,
    detail: "pair removed with unclaimed remainder",
    deficit,
  });

  /** Baseline holding ACCT/CRV at `amount`, root == the entry's superseded root. */
  const scope = (baselineAmount: bigint, baselineRoot = SUPERSEDED) => ({
    target: "voters" as const,
    chainId: 1,
    baselineRoot,
    baselinePairs: pairs([[ACCT, CRV, baselineAmount]]),
  });

  it("clears a removal when baseline root, baseline amount and deficit all match (claimed==0)", () => {
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(100n)],
      [entry([{ account: ACCT, token: CRV, amount: "100" }])],
      scope(100n)
    );
    expect(remaining).toEqual([]);
    expect(cleared).toHaveLength(1);
  });

  it("keeps the violation when the deficit differs (a claim happened in the window)", () => {
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(60n)], // union claimed 40 of the 100
      [entry([{ account: ACCT, token: CRV, amount: "100" }])],
      scope(100n)
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(1);
  });

  it("keeps the violation when the registry understates the baseline amount (codex P1)", () => {
    // Baseline held 100, claimed 20 → deficit 80. A registry row declaring 80
    // must NOT clear it: the declared amount has to equal the baseline amount.
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(80n)],
      [entry([{ account: ACCT, token: CRV, amount: "80" }])],
      scope(100n)
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(1);
  });

  it("keeps the violation when the baseline is not the entry's superseded tree (codex P2)", () => {
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(100n)],
      [entry([{ account: ACCT, token: CRV, amount: "100" }])],
      scope(100n, "0x" + "ab".repeat(32))
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(1);
  });

  it("an entry without supersededRoot never clears anything", () => {
    const e = entry([{ account: ACCT, token: CRV, amount: "100" }]);
    delete (e as any).supersededRoot;
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(100n)],
      [e],
      scope(100n)
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(1);
  });

  it("only clears PRESERVE_PAIR_REMOVED for the matching target and chain", () => {
    const reduced: Violation & { deficit: bigint } = {
      ...removedViolation(100n),
      invariant: "PRESERVE_AMOUNT_REDUCED",
    };
    const wrongChain = { ...removedViolation(100n), chainId: 8453 };
    const { remaining, cleared } = clearJustifiedRemovals(
      [reduced, wrongChain],
      [entry([{ account: ACCT, token: CRV, amount: "100" }])],
      scope(100n)
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(2);
  });

  it("a malformed registry row never clears anything", () => {
    const { remaining, cleared } = clearJustifiedRemovals(
      [removedViolation(100n)],
      [entry([{ account: "not-an-address", token: CRV, amount: "100" }])],
      scope(100n)
    );
    expect(cleared).toEqual([]);
    expect(remaining).toHaveLength(1);
  });
});

describe("loadRestatements", () => {
  it("returns [] for a missing registry", () => {
    expect(loadRestatements(path.join(dir, "nope.json"))).toEqual([]);
  });

  it("validates the committed vlCVX registry against the committed artifacts (repo self-check)", () => {
    const WEEK = 604800;
    const REL: Record<string, string> = {
      voters: path.join("vlCVX", "vlcvx_merkle.json"),
      delegators: path.join("vlCVX", "merkle_data_delegators.json"),
    };
    const registry = loadRestatements(
      path.join("script", "verify", "invariants", "restatements.vlcvx.json")
    );
    expect(registry.length).toBeGreaterThanOrEqual(1);
    for (const entry of registry) {
      const current = path.join("bounties-reports", String(entry.epoch), REL[entry.target]);
      const superseded = current.replace(/\.json$/, ".superseded.json");
      const previous = path.join("bounties-reports", String(entry.epoch - WEEK), REL[entry.target]);
      // Old weeks may eventually be pruned from the repo; the entry is inert
      // for any other epoch, so only the pin can still be checked then.
      if (!fs.existsSync(current)) continue;
      const toMap = (p: string): PairMap => {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        const m: PairMap = new Map();
        for (const [account, claim] of Object.entries<any>(data.claims ?? {})) {
          for (const [token, tc] of Object.entries<any>(claim?.tokens ?? {})) {
            const amount = BigInt(tc?.amount ?? "0");
            if (amount === 0n) continue;
            if (!m.has(getAddress(account))) m.set(getAddress(account), new Map());
            m.get(getAddress(account))!.set(getAddress(token), amount);
          }
        }
        return m;
      };
      const cur = toMap(current);
      // The runtime delta baseline while the restatement is unpublished is
      // the superseded sibling; afterwards (or once it is cleaned up) the
      // archived previous week. Validate against whichever exists.
      const basePath = fs.existsSync(superseded)
        ? superseded
        : fs.existsSync(previous)
          ? previous
          : null;
      if (basePath === null) continue;
      const base = toMap(basePath);
      const delta: PairMap = new Map();
      for (const [account, tokens] of cur) {
        for (const [token, amount] of tokens) {
          const p = base.get(account)?.get(token) ?? 0n;
          if (amount > p) {
            if (!delta.has(account)) delta.set(account, new Map());
            delta.get(account)!.set(token, amount - p);
          }
        }
      }
      const violations: Violation[] = [];
      const { applied } = applyRestatementCredits(
        delta,
        [entry],
        { target: entry.target, chainId: entry.chainId, epoch: entry.epoch },
        violations
      );
      // Proves: ledger loads, pin holds, and every credited pair fits inside
      // the real epoch delta (no ledger/artifact mismatch).
      expect(violations).toEqual([]);
      expect(applied).toHaveLength(1);

      if (!fs.existsSync(superseded)) continue;

      // Simulate the pending-publication preservation pass exactly as the
      // gate runs it (claimed == 0, the enforced precondition): the restated
      // tree vs the superseded baseline must yield ONLY removals justified by
      // the registry — nothing else may shrink or disappear.
      const preservationViolations: (Violation & { deficit?: bigint })[] = [];
      for (const [account, tokens] of base) {
        for (const [token, prevAmount] of tokens) {
          const currAmount = cur.get(account)?.get(token);
          if (currAmount === undefined) {
            preservationViolations.push({
              invariant: "PRESERVE_PAIR_REMOVED",
              severity: "CRITICAL",
              target: entry.target,
              chainId: entry.chainId,
              subject: `${account} / ${token}`,
              detail: "pair removed (self-check, claimed==0)",
              deficit: prevAmount,
            });
          } else if (currAmount < prevAmount) {
            preservationViolations.push({
              invariant: "PRESERVE_AMOUNT_REDUCED",
              severity: "CRITICAL",
              target: entry.target,
              chainId: entry.chainId,
              subject: `${account} / ${token}`,
              detail: "amount reduced (self-check)",
              deficit: prevAmount - currAmount,
            });
          }
        }
      }
      const { remaining, cleared } = clearJustifiedRemovals(
        preservationViolations,
        [entry],
        {
          target: entry.target,
          chainId: entry.chainId,
          baselineRoot: computeRoot(base).toLowerCase(),
          baselinePairs: base,
        }
      );
      expect(remaining).toEqual([]);
      expect(cleared).toHaveLength(entry.justifiedRemovals?.length ?? 0);
    }
  });
});
