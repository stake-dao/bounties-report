import {
  CVX_GAUGE_DELEGATION,
  CVX_GAUGE_VOTE_HELPER,
} from "../utils/constants";
import {
  getContributingWeightsAtVote,
  getOnChainDelegators,
} from "../utils/onChainDelegation";

const BALANCE_AT_EPOCH_ABI = [
  {
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "delegate", type: "address" },
    ],
    name: "balanceAtEpochOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type EffectiveVote = {
  voter: string;
  vp: number;
  choice: Record<string, number>;
  // Set when this vote is a delegator's slice of a delegate's vote.
  viaDelegate?: string;
};

/**
 * Expand every delegate vote into per-delegator virtual votes so downstream
 * consumers can treat ALL wallets as direct voters.
 *
 * Delegate voters are DERIVED on-chain (delegated weight at the epoch, no
 * maintained list). Each delegator's virtual vote carries the delegate's
 * gauge choices with vp = its weight AS COUNTED in that vote
 * (GaugeVoteHelper); the delegate keeps a residual virtual vote for its own
 * baseWeight. VP is conserved per delegate up to the helper's 0.1 vlCVX
 * granularity — a larger drift throws.
 */
export const expandDelegateVotes = async (
  votes: any[],
  proposal: any,
  client: any
): Promise<EffectiveVote[]> => {
  if (votes.length === 0) return [];
  const epoch = Number(proposal.snapshot);

  const delegatedWeights = (await client.multicall({
    allowFailure: false,
    contracts: votes.map((vote) => ({
      address: CVX_GAUGE_DELEGATION as `0x${string}`,
      abi: BALANCE_AT_EPOCH_ABI,
      functionName: "balanceAtEpochOf",
      args: [BigInt(epoch), vote.voter],
    })),
  })) as bigint[];

  const expanded: EffectiveVote[] = [];
  for (const [index, vote] of votes.entries()) {
    if (delegatedWeights[index] === 0n) {
      expanded.push({ voter: vote.voter, vp: vote.vp, choice: vote.choice });
      continue;
    }

    const delegators = await getOnChainDelegators(
      CVX_GAUGE_DELEGATION,
      vote.voter,
      epoch,
      client
    );
    const weights = await getContributingWeightsAtVote(
      CVX_GAUGE_VOTE_HELPER,
      proposal.author,
      Number(proposal.id),
      vote.voter,
      delegators,
      client
    );

    let delegatedVp = 0;
    for (const delegator of delegators) {
      const vp = weights[delegator.toLowerCase()] ?? 0;
      if (vp <= 0) continue;
      delegatedVp += vp;
      expanded.push({
        voter: delegator,
        vp,
        choice: vote.choice,
        viaDelegate: vote.voter,
      });
    }

    // Residual = the delegate's own baseWeight. Reconcile against the vote's
    // total VP: contributing weights are synced at 0.1 vlCVX granularity.
    const residual = vote.vp - delegatedVp;
    const tolerance = 0.1 * Math.max(delegators.length, 1);
    if (residual < -tolerance) {
      throw new Error(
        `expandDelegateVotes: delegator weights of ${vote.voter} exceed its ` +
          `vote VP by ${(-residual).toFixed(2)} vlCVX (tolerance ` +
          `${tolerance.toFixed(1)}) — refusing to over-attribute`
      );
    }
    if (residual > tolerance) {
      expanded.push({ voter: vote.voter, vp: residual, choice: vote.choice });
    }
  }

  return expanded;
};
