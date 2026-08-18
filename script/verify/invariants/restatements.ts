import fs from "fs";
import { getAddress } from "viem";
import { computeRoot, toPairMap } from "./artifact";
import { MerkleData } from "../../interfaces/MerkleData";
import { PairMap, TargetLabel, Violation } from "./types";

/**
 * Epoch-scoped restatement credits for the cross-merkle delta checks.
 *
 * A restatement rewrites a published cumulative tree in place: prior-round
 * entitlements move between accounts without any new value entering the epoch
 * (e.g. the ENG-1973 Union reassignment at 1786579200). The delta checks
 * measure THIS round's additions, so a restated amount surfaces as an
 * unattributable voters-side delta exactly once — in the epoch whose
 * committed artifact first carries the restatement — and would flag every
 * moved recipient who also gets a Tuesday payment.
 *
 * This module credits those amounts out of the delta before the exclusivity
 * checks, under the waivers trust model: the registry and the credit ledgers
 * it points to are repo-controlled and reviewed, each ledger is pinned by the
 * merkle root of its (account, token, amount) set, and any load/pin failure
 * is a CRITICAL violation, never a silent skip. A credit never exceeds the
 * measured delta, so value beyond the reviewed ledger still flags. Outside
 * its own epoch an entry is inert by construction: the following week the
 * restated artifact is itself the delta baseline, so the credited amounts no
 * longer appear as deltas.
 */
export interface RestatementEntry {
  target: TargetLabel;
  chainId: number;
  /** Epoch whose committed artifact first carries the restatement. */
  epoch: number;
  /** Repo-relative path to the credit ledger (MerkleData-shaped `claims`). */
  creditsFile: string;
  /** computeRoot() over the ledger's pair set — any drift fails closed. */
  creditsRoot: string;
  /**
   * Root of the pre-restatement tree (the on-chain root the restatement
   * replaces). Required with `justifiedRemovals`: removals are cleared only
   * while the resolved baseline IS that exact tree, so a justification can
   * never leak onto any other epoch's baseline.
   */
  supersededRoot?: string;
  /**
   * Pairs the restatement REMOVED from the tree (source side of the move).
   * While the pre-restatement root is still active on-chain, preservation
   * sees these as PRESERVE_PAIR_REMOVED; a violation is cleared only when
   * ALL of: the baseline root equals `supersededRoot`, the baseline holds
   * the pair at exactly `amount`, and the deficit equals `amount` — deficit
   * is prev − claimedOnChain, so with prev pinned to `amount` the equality
   * proves claimed == 0. Any claim in the window, any amount drift, or any
   * other baseline breaks the match and the gate goes red.
   */
  justifiedRemovals?: { account: string; token: string; amount: string }[];
  reason: string;
  addedBy: string;
  addedAt: string;
}

export function loadRestatements(path: string): RestatementEntry[] {
  // Mirrors loadWaivers: an absent registry is a valid state (no
  // restatements). Losing a configured registry cannot open the gate — the
  // uncredited deltas then flag via the EXCL_* checks — and a present but
  // malformed registry throws, which the runner treats as fail-closed.
  if (!fs.existsSync(path)) return [];
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

export interface RestatementApplication {
  entry: RestatementEntry;
  creditedPairs: number;
  creditedAddresses: number;
}

/**
 * Subtract every matching entry's credits from `deltas` (per pair, capped at
 * the measured delta). Returns the reduced map; `deltas` is not mutated.
 */
export function applyRestatementCredits(
  deltas: PairMap,
  entries: RestatementEntry[],
  scope: { target: TargetLabel; chainId: number; epoch: number },
  violations: Violation[]
): { deltas: PairMap; applied: RestatementApplication[] } {
  const applied: RestatementApplication[] = [];
  let result = deltas;

  for (const entry of entries) {
    if (
      entry.target !== scope.target ||
      entry.chainId !== scope.chainId ||
      entry.epoch !== scope.epoch
    ) {
      continue;
    }

    let credits: PairMap;
    try {
      const raw: MerkleData = JSON.parse(
        fs.readFileSync(entry.creditsFile, "utf8")
      );
      credits = toPairMap(raw);
      const pin = computeRoot(credits).toLowerCase();
      if (pin !== entry.creditsRoot.toLowerCase()) {
        throw new Error(
          `credit ledger drifted: computed ${pin}, pinned ${entry.creditsRoot}`
        );
      }
    } catch (err) {
      violations.push({
        invariant: "RESTATEMENT_CREDITS_INVALID",
        severity: "CRITICAL",
        target: scope.target,
        chainId: scope.chainId,
        subject: entry.creditsFile,
        detail:
          `restatement credits could not be loaded/verified ` +
          `(${err instanceof Error ? err.message : String(err)}) — ` +
          `failing closed, no credits applied for this entry`,
      });
      continue;
    }

    // Validate before applying: in every healthy state the delta contains
    // each credited pair in full (current = baseline + credit + weekly
    // additions, and cumulative amounts never shrink outside a restatement).
    // A credit exceeding the measured delta means the ledger and the artifact
    // disagree — applying it could erase a genuine current-week payment, so
    // the whole entry is refused instead.
    const mismatches: string[] = [];
    for (const [account, tokens] of credits) {
      for (const [token, credit] of tokens) {
        const delta = result.get(account)?.get(token) ?? 0n;
        if (delta < credit) {
          mismatches.push(`${account}/${token} delta=${delta} credit=${credit}`);
        }
      }
    }
    if (mismatches.length > 0) {
      violations.push({
        invariant: "RESTATEMENT_CREDITS_INVALID",
        severity: "CRITICAL",
        target: scope.target,
        chainId: scope.chainId,
        subject: entry.creditsFile,
        detail:
          `${mismatches.length} credited pair(s) exceed the measured delta ` +
          `(ledger/artifact mismatch, e.g. ${mismatches.slice(0, 3).join("; ")}) — ` +
          `failing closed, no credits applied for this entry`,
      });
      continue;
    }

    const next: PairMap = new Map();
    let creditedPairs = 0;
    const creditedAccounts = new Set<string>();
    for (const [account, tokens] of result) {
      const credit = credits.get(account);
      const rest = new Map<string, bigint>();
      for (const [token, amount] of tokens) {
        const c = credit?.get(token) ?? 0n;
        if (c > 0n) {
          creditedPairs++;
          creditedAccounts.add(account);
        }
        const remainder = amount - c;
        if (remainder > 0n) rest.set(token, remainder);
      }
      if (rest.size > 0) next.set(account, rest);
    }
    result = next;
    applied.push({
      entry,
      creditedPairs,
      creditedAddresses: creditedAccounts.size,
    });
  }

  return { deltas: result, applied };
}

/**
 * Clear PRESERVE_PAIR_REMOVED violations proven to be a restatement's own
 * removals. A violation is cleared only when every bound holds:
 *   1. the resolved baseline IS the entry's pre-restatement tree
 *      (baselineRoot === entry.supersededRoot) — a justification can never
 *      leak onto another epoch's baseline;
 *   2. the baseline holds the pair at EXACTLY the declared amount — the
 *      registry cannot understate what disappeared;
 *   3. the deficit equals the declared amount — with (2) this proves
 *      claimedOnChain == 0; any claim in the window breaks the match.
 * Wrong registry data can therefore only cause a false RED, never a false
 * green.
 *
 * Deliberately NOT scoped to the run epoch: the pending window legitimately
 * spans multiple weekly runs (every later tree still omits the moved pairs,
 * measured against the same root-pinned baseline). Within those coordinates
 * a "different" removal of the same pair is not expressible — the baseline
 * is an immutable tree, so the pair's baseline amount is the restatement's
 * own move, and claimed == 0 is re-proven on every run.
 */
export function clearJustifiedRemovals(
  violations: (Violation & { deficit?: bigint })[],
  entries: RestatementEntry[],
  scope: {
    target: TargetLabel;
    chainId: number;
    /** Recomputed root of the resolved baseline (lowercase). */
    baselineRoot: string;
    /** Pairs of the resolved baseline the violations were measured against. */
    baselinePairs: PairMap;
  }
): {
  remaining: Violation[];
  cleared: { violation: Violation; entry: RestatementEntry }[];
} {
  const remaining: Violation[] = [];
  const cleared: { violation: Violation; entry: RestatementEntry }[] = [];

  for (const v of violations) {
    if (
      v.invariant !== "PRESERVE_PAIR_REMOVED" ||
      v.target !== scope.target ||
      v.chainId !== scope.chainId ||
      v.deficit === undefined
    ) {
      remaining.push(v);
      continue;
    }
    const match = entries.find(
      (entry) =>
        entry.target === scope.target &&
        entry.chainId === scope.chainId &&
        entry.supersededRoot?.toLowerCase() === scope.baselineRoot &&
        (entry.justifiedRemovals ?? []).some((r) => {
          try {
            const account = getAddress(r.account);
            const token = getAddress(r.token);
            const amount = BigInt(r.amount);
            return (
              v.subject === `${account} / ${token}` &&
              scope.baselinePairs.get(account)?.get(token) === amount &&
              v.deficit === amount
            );
          } catch {
            return false; // malformed registry row can never clear anything
          }
        })
    );
    if (match) cleared.push({ violation: v, entry: match });
    else remaining.push(v);
  }
  return { remaining, cleared };
}
