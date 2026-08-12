/**
 * Reader for the per-delegate attribution in repartition_delegation.json.
 *
 * The `perDelegate` map is the payable data: for each delegate voter, its
 * pool's token totals and the wei-exact per-wallet per-token attribution of
 * that pool to ITS OWN delegators, grouped by Votium-forwarding status. The
 * scalar share fields also present in the file (forwarders / nonForwarders)
 * are membership and reporting data — a payer must never split a pot with
 * them.
 *
 * Group names are PAYMENT ROUTES, not registry facts. Only forwarders behind
 * a Stake DAO-operated delegate (VLCVX_POOLED_DELEGATES) are pooled into the
 * Tuesday sCRVUSD merkle — the "forwarders" group. Everyone else is paid raw
 * tokens in the Thursday combined merkle — the "nonForwarders" group, which
 * therefore also contains the forwarder-delegators of every OTHER delegate.
 * The per-delegate sections keep the registry facts (who actually forwards);
 * the routing is applied when flattening.
 *
 * Every accessor here re-validates conservation before returning: the
 * flattened per-wallet amounts must sum, token by token, to the file's
 * totalPerGroup. A mismatch means the file was hand-edited or produced by a
 * broken writer — throw rather than pay. Files written before the on-chain
 * cutover carry no `perDelegate` section; accessors refuse them and the
 * caller must regenerate the repartition.
 */

import { VLCVX_POOLED_DELEGATES } from "./constants";

type ExactGroup = Record<string, Record<string, string>>;

const POOLED_DELEGATES = new Set(
  VLCVX_POOLED_DELEGATES.map((address) => address.toLowerCase())
);

/**
 * True when `delegate` is operated by Stake DAO: its forwarder-delegators
 * settle through the pooled Tuesday sCRVUSD merkle instead of raw Thursday
 * leaves.
 */
export const isPooledDelegate = (delegate: string): boolean =>
  POOLED_DELEGATES.has(delegate.toLowerCase());

interface PerDelegateSection {
  poolTokens: Record<string, string>;
  forwarders: ExactGroup;
  nonForwarders: ExactGroup;
}

export interface DelegationSummaryLike {
  totalTokens?: Record<string, string>;
  totalPerGroup?: Record<string, { forwarders: string; nonForwarders: string }>;
  perDelegate?: Record<string, PerDelegateSection>;
}

/**
 * "forwarders"    → pooled Tuesday sCRVUSD (Stake DAO delegates' forwarders).
 * "nonForwarders" → raw Thursday leaves (everyone else, including forwarders
 *                   behind non-Stake-DAO delegates).
 */
export type GroupName = "forwarders" | "nonForwarders";

/** True when the summary carries the per-delegate attribution. */
export const hasPerDelegateAttribution = (
  summary: DelegationSummaryLike | null | undefined
): boolean => !!summary && typeof summary.perDelegate === "object" && summary.perDelegate !== null;

/**
 * Per-delegate conservation gate: within each delegate section, the
 * forwarder + non-forwarder wallet amounts must sum, token by token, EXACTLY
 * to that delegate's poolTokens (and attribute no token outside the pool).
 * The aggregate totalPerGroup check alone would accept two delegates with
 * offsetting errors — value silently moved between delegate pools.
 */
const assertDelegatePoolsConserve = (
  perDelegate: Record<string, PerDelegateSection>
): void => {
  for (const [delegate, section] of Object.entries(perDelegate)) {
    const attributed: Record<string, bigint> = {};
    for (const group of ["forwarders", "nonForwarders"] as const) {
      for (const tokens of Object.values(section[group] ?? {})) {
        for (const [token, amountStr] of Object.entries(tokens)) {
          const t = token.toLowerCase();
          const amount = BigInt(amountStr);
          if (amount < 0n) {
            throw new Error(
              `delegationExact: negative amount for token ${t} under delegate ${delegate}`
            );
          }
          attributed[t] = (attributed[t] ?? 0n) + amount;
        }
      }
    }
    const pool: Record<string, bigint> = {};
    for (const [token, amountStr] of Object.entries(section.poolTokens ?? {})) {
      pool[token.toLowerCase()] = BigInt(amountStr);
    }
    const tokens = new Set([...Object.keys(attributed), ...Object.keys(pool)]);
    for (const token of tokens) {
      if ((attributed[token] ?? 0n) !== (pool[token] ?? 0n)) {
        throw new Error(
          `delegationExact: delegate ${delegate} token ${token} — attributed ` +
            `${attributed[token] ?? 0n} != pool ${pool[token] ?? 0n}. ` +
            `Refusing to pay from an inconsistent file.`
        );
      }
    }
  }
};

/**
 * The per-delegate sections a routed group draws from. Pooled delegates
 * contribute their factual section 1:1; a non-pooled delegate's forwarders
 * are re-routed into the raw ("nonForwarders") group.
 */
const routedSections = (
  delegate: string,
  section: PerDelegateSection,
  group: GroupName
): ExactGroup[] => {
  if (group === "forwarders") {
    return isPooledDelegate(delegate) ? [section.forwarders ?? {}] : [];
  }
  return isPooledDelegate(delegate)
    ? [section.nonForwarders ?? {}]
    : [section.nonForwarders ?? {}, section.forwarders ?? {}];
};

/**
 * Flattens a routed group's exact amounts across all delegates:
 * lowercase wallet -> lowercase token -> wei. Delegator sets are disjoint
 * across delegates within one file (delegation is 1:1 per epoch), but the
 * merge sums defensively anyway.
 *
 * Throws if the summary has no per-delegate attribution, if any delegate
 * section does not conserve its own pool, or if the flattened sums do not
 * match totalPerGroup token by token (wei-exact).
 */
export const getExactGroupAmounts = (
  summary: DelegationSummaryLike,
  group: GroupName
): Record<string, Record<string, bigint>> => {
  if (!hasPerDelegateAttribution(summary)) {
    throw new Error(
      "getExactGroupAmounts: summary has no per-delegate attribution " +
        "(pre-cutover file?) — regenerate the repartition before paying"
    );
  }

  assertDelegatePoolsConserve(summary.perDelegate!);

  const out: Record<string, Record<string, bigint>> = {};
  const sums: Record<string, bigint> = {};

  for (const [delegate, section] of Object.entries(summary.perDelegate!)) {
    for (const groupMap of routedSections(delegate, section, group)) {
      for (const [addr, tokens] of Object.entries(groupMap)) {
        const wallet = addr.toLowerCase();
        for (const [token, amountStr] of Object.entries(tokens)) {
          const t = token.toLowerCase();
          const amount = BigInt(amountStr);
          if (amount < 0n) {
            throw new Error(
              `getExactGroupAmounts: negative amount for ${wallet}/${t} under delegate ${delegate}`
            );
          }
          (out[wallet] ??= {})[t] = (out[wallet][t] ?? 0n) + amount;
          sums[t] = (sums[t] ?? 0n) + amount;
        }
      }
    }
  }

  // Conservation gate against the file's own group totals.
  const totals: Record<string, bigint> = {};
  for (const [token, groupAmounts] of Object.entries(summary.totalPerGroup ?? {})) {
    totals[token.toLowerCase()] = BigInt(groupAmounts[group]);
  }
  const allTokens = new Set([...Object.keys(sums), ...Object.keys(totals)]);
  for (const token of allTokens) {
    const fromWallets = sums[token] ?? 0n;
    const declared = totals[token] ?? 0n;
    if (fromWallets !== declared) {
      throw new Error(
        `getExactGroupAmounts(${group}): token ${token} — per-wallet sum ${fromWallets} ` +
          `!= totalPerGroup ${declared}. Refusing to pay from an inconsistent file.`
      );
    }
  }

  return out;
};

/**
 * The group's per-token totals (lowercase token -> wei), validated against
 * the flattened per-wallet amounts.
 */
export const getExactGroupTokenTotals = (
  summary: DelegationSummaryLike,
  group: GroupName
): Record<string, bigint> => {
  // getExactGroupAmounts performs the validation; reuse its sums.
  const amounts = getExactGroupAmounts(summary, group);
  const totals: Record<string, bigint> = {};
  for (const tokens of Object.values(amounts)) {
    for (const [token, amount] of Object.entries(tokens)) {
      totals[token] = (totals[token] ?? 0n) + amount;
    }
  }
  return totals;
};
