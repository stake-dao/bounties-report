import type { PublicClient } from "viem";
import { formatUnits } from "viem";
import { VOTIUM_FORWARDER, CVX_GAUGE_VOTE_HELPER } from "../../utils/constants";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getContributingWeightsAtVote } from "../../utils/onChainDelegation";
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

export type DelegationSummary = {
  totalTokens: Record<string, string>;
  totalPerGroup: Record<string, { forwarders: string; nonForwarders: string }>;
  totalForwardersShare: string;
  totalNonForwardersShare: string;
  forwarders: Record<string, string>;
  nonForwarders: Record<string, string>;
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
}> => {
  const delegationDistribution: DelegationDistribution = {};

  // Weight of each delegator AS INCORPORATED IN THE DELEGATE'S VOTE, via
  // GaugeVoteHelper.getContributingWeights (proposal.author = the platform
  // this proposal lives on, so Curve and FXN resolve independently).
  // NOT userWeightAtEpochOf: that table stays mutable until the epoch rolls,
  // so a delegator syncing AFTER the delegate voted would be over-credited.
  // NOT the raw vlCVX balance either: the delegate votes with synced weights.
  const vps = await getContributingWeightsAtVote(
    CVX_GAUGE_VOTE_HELPER,
    proposal.author,
    Number(proposal.id),
    delegationVoter,
    stakeDaoDelegators,
    client
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
  stakeDaoDelegators.forEach((delegator) => {
    const delegatorVp = vps[delegator] || 0;
    const key = delegator.toLowerCase();
    if (delegatorVp > 0) {
      const share = (delegatorVp / totalVp).toString();
      const isForwarder = forwardedMap[key] === VOTIUM_FORWARDER.toLowerCase();
      delegationDistribution[delegator] = {
        share,
        shareNonForwarders: isForwarder ? "0" : share,
        shareForwarders: isForwarder ? share : "0",
      };
    }
  });
  return {
    distribution: delegationDistribution,
    delegateOwnTokens,
    totalDelegatedVp: totalVp,
  };
};

/**
 * Computes a delegation summary with the following structure:
 *
 * {
 *   totalTokens: { token: string, ... },
 *   totalPerGroup: { token: { forwarders: string, nonForwarders: string }, ... },
 *   totalForwardersShare: string,
 *   totalNonForwardersShare: string,
 *   forwarders: { [address: string]: share },
 *   nonForwarders: { [address: string]: share }
 * }
 *
 * The delegation voter entry (which holds the token totals) is used for totalTokens.
 */
export const computeDelegationSummary = (
  delegationDistribution: DelegationDistribution
): DelegationSummary => {
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
