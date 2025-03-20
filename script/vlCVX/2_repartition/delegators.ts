import { getAddress } from "viem";
import { SDT_DELEGATORS_REWARD, VOTIUM_FORWARDER } from "../../utils/constants";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getVotingPower } from "../../utils/snapshot";

export type DelegationDistribution = Record<
  string,
  | { tokens: Record<string, bigint> }
  | {
      share: string;
      shareSDT: string;
      shareNonForwarders: string;
      shareForwarders: string;
      shareSDTForwarders: string;
      shareSDTNonForwarders: string;
    }
>;

export type DelegationSummary = {
  totalTokens: Record<string, string>;
  totalPerGroup: Record<string, { forwarders: string; nonForwarders: string }>;
  totalSDTPerGroup?: { forwarders: string; nonForwarders: string };
  totalForwardersShare: string;
  totalNonForwardersShare: string;
  forwarders: Record<string, string>;
  nonForwarders: Record<string, string>;
};

export const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<DelegationDistribution> => {
  const delegationDistribution: DelegationDistribution = {};

  // Define the set of skipped users (whose SDT shares will be 0)
  const skippedUsers = new Set([
    getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"),
  ]);

  // Store the delegation voter's token totals.
  delegationDistribution[delegationVoter] = { tokens: { ...tokens } };

  // Get voting power for each delegator.
  const vps = await getVotingPower(proposal, stakeDaoDelegators);
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Get total VP without skipped users
  const totalVpWithoutSkippedUsers = Object.entries(vps).reduce(
    (acc, [delegator, vp]) => 
      skippedUsers.has(getAddress(delegator)) ? acc : acc + vp,
    0
  );

  // Get forwarded status for each delegator (via multicall).
  const forwardedArray = await getForwardedDelegators(stakeDaoDelegators);
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
      const sdtShare = (delegatorVp / totalVpWithoutSkippedUsers).toString();
      const isForwarder = forwardedMap[key] === VOTIUM_FORWARDER.toLowerCase();
      delegationDistribution[delegator] = {
        share,
        shareSDT: sdtShare,
        shareNonForwarders: isForwarder ? "0" : share,
        shareForwarders: isForwarder ? share : "0",
        shareSDTForwarders: isForwarder ? sdtShare : "0",
        shareSDTNonForwarders: isForwarder ? "0" : sdtShare,
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
 *   totalPerGroup: { token: { forwarders: string, nonForwarders: string }, ... },
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
): DelegationSummary => {
  let totalTokens: Record<string, string> = {};
  let totalForwardersShare = 0;
  let totalNonForwardersShare = 0;
  let totalSDTForwardersShare = 0;
  let totalSDTNonForwardersShare = 0;
  const forwarders: Record<string, string> = {};
  const nonForwarders: Record<string, string> = {};
  const forwardersSDT: Record<string, string> = {};
  const nonForwardersSDT: Record<string, string> = {};
  const totalSDTPerGroup: { forwarders: string; nonForwarders: string } = {
    forwarders: "0",
    nonForwarders: "0",
  };
  const totalPerGroup: Record<
    string,
    { forwarders: string; nonForwarders: string }
  > = {};

  // First pass: collect all shares and addresses
  for (const [address, data] of Object.entries(delegationDistribution)) {
    if ("tokens" in data) {
      // This is the delegation voter: extract token totals.
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
      const shareSDTForward = parseFloat(data.shareSDTForwarders);
      const shareSDTNon = parseFloat(data.shareSDTNonForwarders);
      totalForwardersShare += shareForward;
      totalNonForwardersShare += shareNon;
      totalSDTForwardersShare += shareSDTForward;
      totalSDTNonForwardersShare += shareSDTNon;
      if (shareForward > 0) {
        forwarders[address] = data.shareForwarders;
      }
      if (shareNon > 0) {
        nonForwarders[address] = data.shareNonForwarders;
      }
      if (shareSDTForward > 0) {
        forwardersSDT[address] = data.shareSDTForwarders;
      }
      if (shareSDTNon > 0) {
        nonForwardersSDT[address] = data.shareSDTNonForwarders;
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

      const normalizedShareSDT = (
        parseFloat(forwardersSDT[address]) / totalSDTForwardersShare
      ).toString();
      forwardersSDT[address] = normalizedShareSDT;
    }
  }

  if (totalNonForwardersShare > 0) {
    for (const address of Object.keys(nonForwarders)) {
      const normalizedShare = (
        parseFloat(nonForwarders[address]) / totalNonForwardersShare
      ).toString();
      nonForwarders[address] = normalizedShare;

      const normalizedShareSDT = (
        parseFloat(nonForwardersSDT[address]) / totalSDTNonForwardersShare
      ).toString();
      nonForwardersSDT[address] = normalizedShareSDT;
    }
  }

  // Calculate forwarders amount first for SDT
  totalSDTPerGroup.forwarders = (
    (SDT_DELEGATORS_REWARD * BigInt(Math.floor(totalSDTForwardersShare * 1e6))) /
    1000000n
  ).toString();

  // Calculate non-forwarders as the remainder to ensure exact total for SDT
  totalSDTPerGroup.nonForwarders = (
    SDT_DELEGATORS_REWARD - BigInt(totalSDTPerGroup.forwarders)
  ).toString();

  // Calculate totalPerGroup for each token
  for (const [token, totalAmount] of Object.entries(totalTokens)) {
    totalPerGroup[token] = {
      forwarders: "0",
      nonForwarders: "0",
    };

    // Calculate forwarders amount first
    const tokenBigInt = BigInt(totalAmount);
    totalPerGroup[token].forwarders = (
      (tokenBigInt * BigInt(Math.floor(totalForwardersShare * 1e6))) /
      1000000n
    ).toString();

    // Calculate non-forwarders as the remainder to ensure exact total
    totalPerGroup[token].nonForwarders = (
      tokenBigInt - BigInt(totalPerGroup[token].forwarders)
    ).toString();
  }

  return {
    totalTokens,
    totalPerGroup,
    totalSDTPerGroup,
    totalForwardersShare: totalForwardersShare.toString(),
    totalNonForwardersShare: totalNonForwardersShare.toString(),
    forwarders,
    nonForwarders,
  };
};
