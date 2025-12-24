import { getVotingPower } from "../../utils/snapshot";

export type DelegationDistribution = Record<
  string,
  | { tokens: Record<string, bigint> }
  | { share: string }
>;

export type DelegationSummary = {
  totalTokens: Record<string, string>;
  delegators: Record<string, string>; // address -> normalized share
};

/**
 * Compute delegation distribution for vlAURA.
 * Unlike vlCVX, there is no forwarder/non-forwarder split.
 * All delegators receive native tokens proportionally.
 */
export const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<DelegationDistribution> => {
  const delegationDistribution: DelegationDistribution = {};

  // Store the delegation voter's token totals
  delegationDistribution[delegationVoter] = { tokens: { ...tokens } };

  // Get voting power for each delegator
  const vps = await getVotingPower(proposal, stakeDaoDelegators);
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Compute each delegator's share
  stakeDaoDelegators.forEach((delegator) => {
    const delegatorVp = vps[delegator] || 0;
    if (delegatorVp > 0) {
      const share = (delegatorVp / totalVp).toString();
      delegationDistribution[delegator] = { share };
    }
  });

  return delegationDistribution;
};

/**
 * Compute delegation summary for vlAURA.
 */
export const computeDelegationSummary = (
  delegationDistribution: DelegationDistribution
): DelegationSummary => {
  let totalTokens: Record<string, string> = {};
  const delegators: Record<string, string> = {};

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
      delegators[address] = data.share;
    }
  }

  return { totalTokens, delegators };
};
