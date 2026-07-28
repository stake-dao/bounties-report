import { PairMap, Violation } from "./types";

/**
 * Delta-scoped cross-merkle exclusivity (Codex review finding #2).
 *
 * The voters and delegators trees are CUMULATIVE: an address that changed
 * forwarder/delegator status in the past legitimately keeps historical
 * entries in both trees forever. Membership intersection is therefore
 * meaningless — only pairs receiving value THIS epoch (positive delta vs
 * their own baseline) may not appear on both sides for the same token.
 *
 * This is the deterministic invariant for the "forwarders ended up in the
 * voters merkle" incident class.
 */
export function positiveDeltas(current: PairMap, baseline: PairMap): PairMap {
  const deltas: PairMap = new Map();
  for (const [account, tokens] of current) {
    for (const [token, amount] of tokens) {
      const prev = baseline.get(account)?.get(token) ?? 0n;
      if (amount > prev) {
        let t = deltas.get(account);
        if (!t) {
          t = new Map();
          deltas.set(account, t);
        }
        t.set(token, amount - prev);
      }
    }
  }
  return deltas;
}

export function checkDeltaExclusivity(
  chainId: number,
  votersDeltas: PairMap,
  delegatorsDeltas: PairMap,
  violations: Violation[]
): void {
  for (const [account, tokens] of votersDeltas) {
    const delegatorTokens = delegatorsDeltas.get(account);
    if (!delegatorTokens) continue;
    for (const [token, voterDelta] of tokens) {
      const delegatorDelta = delegatorTokens.get(token);
      if (delegatorDelta !== undefined) {
        violations.push({
          invariant: "EXCL_DELTA_OVERLAP",
          severity: "CRITICAL",
          target: "voters",
          chainId,
          subject: `${account} / ${token}`,
          detail:
            `address receives the same token in BOTH merkles this epoch: ` +
            `voters delta=${voterDelta}, delegators delta=${delegatorDelta} (double payment)`,
        });
      }
    }
  }
}
