import type { PublicClient } from "viem";
import { formatUnits } from "viem";
import { VOTIUM_FORWARDER, CVX_GAUGE_VOTE_HELPER } from "../../utils/constants";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getContributingWeightsAtVoteRaw } from "../../utils/onChainDelegation";
import { getVoteOf } from "../../utils/gaugeVotePlatform";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";

export type DelegationDistribution = Record<
  string,
  | { tokens: Record<string, bigint> }
  | {
      share: string;
      shareNonForwarders: string;
      shareForwarders: string;
    }
>;

/**
 * Exact (wei-level) attribution of ONE delegate's pool to its own delegators.
 * All addresses lowercase. `exactByDelegator` conserves each pool token to the
 * wei: for every token, sum over delegators === poolTokens[token].
 */
export type PerDelegateExact = {
  delegate: string;
  poolTokens: Record<string, bigint>;
  exactByDelegator: Record<string, Record<string, bigint>>;
  forwarderFlags: Record<string, boolean>;
};

/**
 * The `distribution` object of repartition_delegation.json.
 *
 * `perDelegate` is the payable data: each delegate voter's pool token totals
 * and the wei-exact per-wallet per-token attribution of that pool to ITS OWN
 * delegators, grouped by Votium-forwarding status. totalTokens / totalPerGroup
 * are exact bigint sums over it.
 *
 * The scalar share fields (forwarders / nonForwarders / total*Share) are
 * membership and reporting data — VP shares flattened across delegates.
 * Several verifiers key on their address sets; nothing may pay from them.
 */
export type DelegationSummary = {
  totalTokens: Record<string, string>;
  totalPerGroup: Record<string, { forwarders: string; nonForwarders: string }>;
  totalForwardersShare: string;
  totalNonForwardersShare: string;
  forwarders: Record<string, string>;
  nonForwarders: Record<string, string>;
  perDelegate: Record<
    string,
    {
      poolTokens: Record<string, string>;
      forwarders: Record<string, Record<string, string>>;
      nonForwarders: Record<string, Record<string, string>>;
    }
  >;
};

/**
 * Splits `amount` among weighted recipients in exact integer math (largest
 * remainder): base_i = floor(amount * w_i / W), then the leftover wei go one
 * by one to the largest fractional remainders (ties broken by ascending
 * address for determinism). Conservation is exact: sum === amount. Zero
 * weights receive nothing.
 */
export const splitAmountByWeights = (
  amount: bigint,
  weightsWei: Record<string, bigint>
): Record<string, bigint> => {
  const entries = Object.entries(weightsWei).filter(([, w]) => w > 0n);
  const totalWeight = entries.reduce((acc, [, w]) => acc + w, 0n);
  if (amount < 0n) throw new Error(`splitAmountByWeights: negative amount ${amount}`);
  if (totalWeight <= 0n) {
    if (amount > 0n) {
      throw new Error(
        `splitAmountByWeights: amount ${amount} with no positive weight — no beneficiary`
      );
    }
    return {};
  }

  const result: Record<string, bigint> = {};
  let distributed = 0n;
  const remainders: { address: string; remainder: bigint }[] = [];
  for (const [address, w] of entries) {
    const product = amount * w;
    const base = product / totalWeight;
    result[address] = base;
    distributed += base;
    remainders.push({ address, remainder: product % totalWeight });
  }

  let leftover = amount - distributed;
  if (leftover > 0n) {
    remainders.sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.address < b.address ? -1 : 1;
    });
    for (const { address } of remainders) {
      if (leftover === 0n) break;
      result[address] += 1n;
      leftover -= 1n;
    }
  }
  return result;
};

/**
 * Splits the delegation voter's rewards. The delegate's vote earned tokens
 * with vp = baseWeight (its OWN vlCVX) + adjustedWeight (the delegation):
 * only the delegation portion belongs to the delegators — the baseWeight
 * portion is returned separately as delegateOwnTokens and must stay with the
 * delegate. (StakeDAO's delegate holds no vlCVX today, so delegateOwnTokens
 * is normally empty — this is a correctness guard, not a live path.)
 */
export const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string,
  client: PublicClient
): Promise<{
  distribution: DelegationDistribution;
  delegateOwnTokens: Record<string, bigint>;
  totalDelegatedVp: number;
  exact: PerDelegateExact;
}> => {
  const delegationDistribution: DelegationDistribution = {};

  // Weight of each delegator AS INCORPORATED IN THE DELEGATE'S VOTE, via
  // GaugeVoteHelper.getContributingWeights (proposal.author = the platform
  // this proposal lives on, so Curve and FXN resolve independently).
  // NOT userWeightAtEpochOf: that table stays mutable until the epoch rolls,
  // so a delegator syncing AFTER the delegate voted would be over-credited.
  // NOT the raw vlCVX balance either: the delegate votes with synced weights.
  // Raw wei weights: the pool is split in exact integer math — the float
  // shares derived below are membership/reporting data only.
  const vpsWei = await getContributingWeightsAtVoteRaw(
    CVX_GAUGE_VOTE_HELPER,
    proposal.author,
    Number(proposal.id),
    delegationVoter,
    stakeDaoDelegators,
    client
  );
  const vps: Record<string, number> = Object.fromEntries(
    Object.entries(vpsWei).map(([addr, wei]) => [addr, Number(formatUnits(wei, 18))])
  );
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Invariant: the helper's replay must reconcile with the vote the platform
  // actually applied — delegate baseWeight + sum(contributing weights) must
  // equal the delegate's effective voting weight (baseWeight + adjustedWeight).
  // A shortfall means contributing weights are missing (the found delegators
  // would silently absorb the missing ones' share); an excess means the
  // helper over-credited someone. Tolerance = 0.1 vlCVX per-delegator synced
  // weight granularity (assertDelegatorsCompleteness itself is exact-match).
  const delegateVote = await getVoteOf(
    proposal.author,
    Number(proposal.id),
    delegationVoter,
    client
  );
  if (!delegateVote.voted) {
    throw new Error(
      `computeStakeDaoDelegation: delegate ${delegationVoter} has no vote on ` +
        `proposal ${proposal.id} (platform ${proposal.author})`
    );
  }
  const delegateBaseWeight = Number(formatUnits(delegateVote.baseWeight, 18));
  const delegateEffectiveWeight = Number(
    formatUnits(delegateVote.baseWeight + delegateVote.adjustedWeight, 18)
  );
  const reconciliationTolerance = 0.1 * stakeDaoDelegators.length + 1;
  const drift = delegateBaseWeight + totalVp - delegateEffectiveWeight;
  if (Math.abs(drift) > reconciliationTolerance) {
    throw new Error(
      `computeStakeDaoDelegation: contributing weights do not reconcile with the ` +
        `delegate's applied vote on proposal ${proposal.id}: baseWeight ` +
        `(${delegateBaseWeight.toFixed(2)}) + sum(helper) (${totalVp.toFixed(2)}) ` +
        `differs from the effective voting weight (${delegateEffectiveWeight.toFixed(2)}) ` +
        `by ${drift.toFixed(2)} vlCVX (tolerance ±${reconciliationTolerance.toFixed(1)}) — aborting`
    );
  }

  // Split each token amount between the delegate's own share (earned by its
  // baseWeight) and the delegation pool (earned by adjustedWeight), exactly
  // in bigint: own = floor(amount * base / effective), pool = the remainder.
  // With baseWeight == 0 (StakeDAO today) the pool is the full amount.
  const baseWeightWei = delegateVote.baseWeight;
  const effectiveWeightWei = delegateVote.baseWeight + delegateVote.adjustedWeight;
  if (effectiveWeightWei <= 0n) {
    throw new Error(
      `computeStakeDaoDelegation: delegate ${delegationVoter} has non-positive ` +
        `effective weight (${effectiveWeightWei}) on proposal ${proposal.id} — ` +
        `it should not have received rewards, aborting`
    );
  }
  const delegationTokens: Record<string, bigint> = {};
  const delegateOwnTokens: Record<string, bigint> = {};
  for (const [token, amount] of Object.entries(tokens)) {
    const own = (amount * baseWeightWei) / effectiveWeightWei;
    const pool = amount - own;
    if (own > 0n) delegateOwnTokens[token] = own;
    if (pool > 0n) delegationTokens[token] = pool;
  }

  // A valid base-only vote (all contributing weights zero) leaves an empty
  // pool: nothing to split, all rewards stay with the delegate. But a
  // NON-empty pool with no contributing delegator would land in a group with
  // no beneficiary (an empty forwarders/nonForwarders map still receives the
  // full totalPerGroup amounts) — refuse to strand the funds.
  if (Object.keys(delegationTokens).length > 0 && totalVp <= 0) {
    throw new Error(
      `computeStakeDaoDelegation: no delegator has a contributing weight on ` +
        `proposal ${proposal.id} (sum = ${totalVp}) while the delegation pool is ` +
        `non-empty — it would have no beneficiary, aborting`
    );
  }

  // Store the delegation pool's token totals.
  delegationDistribution[delegationVoter] = { tokens: delegationTokens };

  // TEST-ONLY (fork / virtual testnet, see VLCVX_ALLOW_ACTIVE_PROPOSAL in
  // 2_repartition/index.ts): an active proposal has no block after its end
  // yet — approximate the Votium forwarding state with the latest block.
  const blockSnapshotEnd =
    process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL === "true"
      ? Number(await client.getBlockNumber())
      : await getBlockNumberByTimestamp(proposal.end, "after", 1);

  // Get forwarded status for each delegator (via multicall).
  const forwardedArray = await getForwardedDelegators(stakeDaoDelegators, blockSnapshotEnd);
  const forwardedMap: Record<string, string> = {};
  stakeDaoDelegators.forEach((delegator, idx) => {
    forwardedMap[delegator.toLowerCase()] = forwardedArray[idx].toLowerCase();
  });

  // For each delegator, compute the basic share and split into forwarder/non‑forwarder parts.
  const forwarderFlags: Record<string, boolean> = {};
  stakeDaoDelegators.forEach((delegator) => {
    const delegatorVp = vps[delegator] || 0;
    const key = delegator.toLowerCase();
    if (delegatorVp > 0) {
      const share = (delegatorVp / totalVp).toString();
      const isForwarder = forwardedMap[key] === VOTIUM_FORWARDER.toLowerCase();
      forwarderFlags[key] = isForwarder;
      delegationDistribution[delegator] = {
        share,
        shareNonForwarders: isForwarder ? "0" : share,
        shareForwarders: isForwarder ? share : "0",
      };
    }
  });

  // Exact attribution: split each pool token among THIS delegate's delegators
  // by raw contributing weight, wei-conserving. This is what the merkle
  // builders pay — the float shares above are informational only.
  const exactByDelegator: Record<string, Record<string, bigint>> = {};
  for (const [token, poolAmount] of Object.entries(delegationTokens)) {
    const split = splitAmountByWeights(poolAmount, vpsWei);
    for (const [addr, amt] of Object.entries(split)) {
      if (amt === 0n) continue;
      if (!exactByDelegator[addr]) exactByDelegator[addr] = {};
      exactByDelegator[addr][token] = amt;
    }
  }

  return {
    distribution: delegationDistribution,
    delegateOwnTokens,
    totalDelegatedVp: totalVp,
    exact: {
      delegate: delegationVoter.toLowerCase(),
      poolTokens: delegationTokens,
      exactByDelegator,
      forwarderFlags,
    },
  };
};

/**
 * Membership/reporting fields of the summary: per-wallet VP shares normalized
 * within each forwarding group, plus token totals taken from the merged pot
 * entry. The share values are NOT payable data — buildDelegationSummary
 * replaces the token totals with exact sums and attaches the payable
 * perDelegate attribution.
 */
const computeScalarShareFields = (
  delegationDistribution: DelegationDistribution
): Omit<DelegationSummary, "perDelegate"> => {
  let totalTokens: Record<string, string> = {};
  let totalForwardersShare = 0;
  let totalNonForwardersShare = 0;
  const forwarders: Record<string, string> = {};
  const nonForwarders: Record<string, string> = {};
  const totalPerGroup: Record<
    string,
    { forwarders: string; nonForwarders: string }
  > = {};

  // First pass: collect all shares and addresses
  for (const [address, data] of Object.entries(delegationDistribution)) {
    if ("tokens" in data) {
      totalTokens = Object.entries(data.tokens).reduce(
        (acc, [token, amount]) => {
          acc[token] = amount.toString();
          return acc;
        },
        {} as Record<string, string>
      );
    } else {
      const shareForward = parseFloat(data.shareForwarders);
      const shareNon = parseFloat(data.shareNonForwarders);
      totalForwardersShare += shareForward;
      totalNonForwardersShare += shareNon;
      if (shareForward > 0) {
        forwarders[address] = data.shareForwarders;
      }
      if (shareNon > 0) {
        nonForwarders[address] = data.shareNonForwarders;
      }
    }
  }

  // Second pass: normalize shares within each group
  if (totalForwardersShare > 0) {
    for (const address of Object.keys(forwarders)) {
      const normalizedShare = (
        parseFloat(forwarders[address]) / totalForwardersShare
      ).toString();
      forwarders[address] = normalizedShare;
    }
  }

  if (totalNonForwardersShare > 0) {
    for (const address of Object.keys(nonForwarders)) {
      const normalizedShare = (
        parseFloat(nonForwarders[address]) / totalNonForwardersShare
      ).toString();
      nonForwarders[address] = normalizedShare;
    }
  }

  // Calculate totalPerGroup for each token
  for (const [token, totalAmount] of Object.entries(totalTokens)) {
    totalPerGroup[token] = {
      forwarders: "0",
      nonForwarders: "0",
    };

    const tokenBigInt = BigInt(totalAmount);
    totalPerGroup[token].forwarders = (
      (tokenBigInt * BigInt(Math.floor(totalForwardersShare * 1e6))) /
      1000000n
    ).toString();

    totalPerGroup[token].nonForwarders = (
      tokenBigInt - BigInt(totalPerGroup[token].forwarders)
    ).toString();
  }

  return {
    totalTokens,
    totalPerGroup,
    totalForwardersShare: totalForwardersShare.toString(),
    totalNonForwardersShare: totalNonForwardersShare.toString(),
    forwarders,
    nonForwarders,
  };
};

const stringifyTokenMap = (m: Record<string, bigint>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([t, a]) => [t, a.toString()]));

/**
 * Builds the full delegation summary: scalar membership fields via
 * computeScalarShareFields, plus the exact `perDelegate` sections, with
 * totalTokens / totalPerGroup as exact bigint sums of the per-delegate
 * attributions.
 *
 * Throws when the exact data does not conserve:
 * - a delegator appears under two delegates (delegation is 1:1 per epoch),
 * - per delegate, group sums != poolTokens (wei-exact),
 * - across delegates, pool sums != the merged pot the scalar fields hold.
 */
export const buildDelegationSummary = (
  delegationDistribution: DelegationDistribution,
  perDelegate: PerDelegateExact[]
): DelegationSummary => {
  const scalarFields = computeScalarShareFields(delegationDistribution);

  const seenDelegators = new Map<string, string>();
  const totalTokens: Record<string, bigint> = {};
  const groupTotals: Record<string, { forwarders: bigint; nonForwarders: bigint }> = {};
  const perDelegateOut: DelegationSummary["perDelegate"] = {};

  for (const d of perDelegate) {
    const fwd: Record<string, Record<string, string>> = {};
    const nfwd: Record<string, Record<string, string>> = {};
    const groupSumPerToken: Record<string, bigint> = {};

    for (const [addr, tokens] of Object.entries(d.exactByDelegator)) {
      const prevOwner = seenDelegators.get(addr);
      if (prevOwner && prevOwner !== d.delegate) {
        throw new Error(
          `buildDelegationSummary: delegator ${addr} attributed to two delegates ` +
            `(${prevOwner} and ${d.delegate}) — delegation is 1:1 per epoch`
        );
      }
      seenDelegators.set(addr, d.delegate);

      const target = d.forwarderFlags[addr] ? fwd : nfwd;
      target[addr] = stringifyTokenMap(tokens);
      for (const [token, amount] of Object.entries(tokens)) {
        groupSumPerToken[token] = (groupSumPerToken[token] ?? 0n) + amount;
        const g = (groupTotals[token] ??= { forwarders: 0n, nonForwarders: 0n });
        if (d.forwarderFlags[addr]) g.forwarders += amount;
        else g.nonForwarders += amount;
      }
    }

    for (const [token, poolAmount] of Object.entries(d.poolTokens)) {
      totalTokens[token] = (totalTokens[token] ?? 0n) + poolAmount;
      const attributed = groupSumPerToken[token] ?? 0n;
      if (attributed !== poolAmount) {
        throw new Error(
          `buildDelegationSummary: delegate ${d.delegate} token ${token} — ` +
            `attributed ${attributed} != pool ${poolAmount} (must conserve to the wei)`
        );
      }
    }
    for (const token of Object.keys(groupSumPerToken)) {
      if (d.poolTokens[token] === undefined) {
        throw new Error(
          `buildDelegationSummary: delegate ${d.delegate} attributes token ${token} ` +
            `absent from its pool`
        );
      }
    }

    perDelegateOut[d.delegate] = {
      poolTokens: stringifyTokenMap(d.poolTokens),
      forwarders: fwd,
      nonForwarders: nfwd,
    };
  }

  // The scalar fields' totalTokens comes from the merged pot entry — the
  // exact per-delegate pools must sum to the same values.
  const potTotals = Object.entries(scalarFields.totalTokens);
  if (potTotals.length !== Object.keys(totalTokens).length) {
    throw new Error(
      `buildDelegationSummary: token set mismatch between merged pot ` +
        `(${potTotals.length}) and per-delegate pools (${Object.keys(totalTokens).length})`
    );
  }
  for (const [token, amountStr] of potTotals) {
    if ((totalTokens[token] ?? 0n) !== BigInt(amountStr)) {
      throw new Error(
        `buildDelegationSummary: token ${token} — merged pot ${amountStr} != ` +
          `sum of per-delegate pools ${totalTokens[token] ?? 0n}`
      );
    }
  }

  return {
    ...scalarFields,
    totalPerGroup: Object.fromEntries(
      Object.entries(groupTotals).map(([token, g]) => [
        token,
        {
          forwarders: g.forwarders.toString(),
          nonForwarders: g.nonForwarders.toString(),
        },
      ])
    ),
    perDelegate: perDelegateOut,
  };
};
