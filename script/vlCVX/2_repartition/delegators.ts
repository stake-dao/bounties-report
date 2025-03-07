import { SDT_DELEGATORS_REWARD, VOTIUM_FORWARDER } from "../../utils/constants";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getVotingPower } from "../../utils/snapshot";

export type DelegationDistribution = Record<
  string,
  | { tokens: Record<string, bigint> }
  | { share: string; shareNonForwarders: string; shareForwarders: string }
>;

/**
 * Computes vlcvx rewards distribution for StakeDAO delegators.
 *   - share: the relative share (as a string)
 *   - shareNonForwarders: share if the delegator did NOT forward on Votium (otherwise "0")
 *   - shareForwarders: share if the delegator did forward on Votium (otherwise "0")
 */
export const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<DelegationDistribution> => {
  const delegationDistribution: DelegationDistribution = {};

  // Store the delegation voter's token totals.
  delegationDistribution[delegationVoter] = { tokens: { ...tokens } };

  // Get voting power for each delegator.
  const vps = await getVotingPower(proposal, stakeDaoDelegators);
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Get forwarded status for each delegator (via multicall).
  const forwardedArray = await getForwardedDelegators(stakeDaoDelegators);
  const forwardedMap: Record<string, string> = {};
  stakeDaoDelegators.forEach((delegator, idx) => {
    forwardedMap[delegator.toLowerCase()] = forwardedArray[idx].toLowerCase();
  });

  // For each delegator, compute the share and split into forwarder/non‑forwarder parts.
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

  return delegationDistribution;
};

/**
 * Computes a delegation summary with the following structure:
 *
 * {
 *   totalTokens: { token: string, ... },
 *   totalSDTPerGroup: { forwarders: string, nonForwarders: string },
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
) => {
  let totalTokens: Record<string, string> = {};
  let totalForwardersShare = 0;
  let totalNonForwardersShare = 0;
  const forwarders: Record<string, string> = {};
  const nonForwarders: Record<string, string> = {};
  const totalSDTPerGroup: Record<string, string> = {
    forwarders: "0",
    nonForwarders: "0",
  };

  for (const [address, data] of Object.entries(delegationDistribution)) {
    if ("tokens" in data) {
      // This is the delegation voter: extract token totals.
      totalTokens = Object.entries(data.tokens).reduce((acc, [token, amount]) => {
        acc[token] = amount.toString();
        return acc;
      }, {} as Record<string, string>);
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

  // Calculate forwarders amount first
  totalSDTPerGroup.forwarders = (SDT_DELEGATORS_REWARD * BigInt(Math.floor(totalForwardersShare * 1e6)) / 1000000n).toString();
  
  // Calculate non-forwarders as the remainder to ensure exact total
  totalSDTPerGroup.nonForwarders = (SDT_DELEGATORS_REWARD - BigInt(totalSDTPerGroup.forwarders)).toString();

  return {
    totalTokens,
    totalSDTPerGroup,
    totalForwardersShare: totalForwardersShare.toString(),
    totalNonForwardersShare: totalNonForwardersShare.toString(),
    forwarders,
    nonForwarders,
  };
};
