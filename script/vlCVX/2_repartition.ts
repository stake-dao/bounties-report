import * as dotenv from "dotenv";
import fs from "fs";
import {
  CVX_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
  VOTIUM_FORWARDER,
} from "../utils/constants";
import { getForwardedDelegators } from "../utils/delegationHelper";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../utils/snapshot";
import { extractCSV } from "../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../utils/curveApi";
import { processAllDelegators } from "../utils/cacheUtils";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }
>;
type Distribution = Record<string, { tokens: Record<string, bigint> }>;

/**
 * Computes delegation distribution for StakeDAO delegators.
 * It stores the delegation voter's token totals unchanged and computes for each delegator:
 *   - share: the relative share (as a string)
 *   - shareNonForwarders: share if the delegator did NOT forward (otherwise "0")
 *   - shareForwarders: share if the delegator did forward (otherwise "0")
 */
const computeStakeDaoDelegation = async (
  proposal: any,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<
  Record<
    string,
    | { tokens: Record<string, bigint> }
    | { share: string; shareNonForwarders: string; shareForwarders: string }
  >
> => {
  const delegationDistribution: Record<
    string,
    | { tokens: Record<string, bigint> }
    | { share: string; shareNonForwarders: string; shareForwarders: string }
  > = {};

  // Store the delegation voter's full token distribution (total amounts)
  delegationDistribution[delegationVoter] = { tokens: { ...tokens } };

  // Get voting power for each delegator and compute total VP
  const vps = await getVotingPower(proposal, stakeDaoDelegators);
  const totalVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  // Get forwarded status for each delegator (via multicall)
  const forwardedArray = await getForwardedDelegators(stakeDaoDelegators);
  const forwardedMap: Record<string, string> = {};
  stakeDaoDelegators.forEach((delegator, idx) => {
    forwardedMap[delegator.toLowerCase()] = forwardedArray[idx].toLowerCase();
  });

  // For each delegator, compute the share and split it into forwarder / non-forwarder parts.
  stakeDaoDelegators.forEach((delegator) => {
    const delegatorVp = vps[delegator] || 0;
    const key = delegator.toLowerCase();
    if (delegatorVp > 0) {
      const share = (delegatorVp / totalVp).toString();
      const isForwarder =
        forwardedMap[key] === VOTIUM_FORWARDER.toLowerCase();
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
 *   totalForwardersShare: string,
 *   totalNonForwardersShare: string,
 *   forwarders: { [address: string]: share },
 *   nonForwarders: { [address: string]: share }
 * }
 *
 * The delegation voter entry (which holds the token totals) is used for totalTokens.
 */
const computeDelegationSummary = (
  delegationDistribution: Record<
    string,
    | { tokens: Record<string, bigint> }
    | { share: string; shareNonForwarders: string; shareForwarders: string }
  >
) => {
  let totalTokens: Record<string, string> = {};
  let totalForwardersShare = 0;
  let totalNonForwardersShare = 0;
  const forwarders: Record<string, string> = {};
  const nonForwarders: Record<string, string> = {};

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

  return {
    totalTokens,
    totalForwardersShare: totalForwardersShare.toString(),
    totalNonForwardersShare: totalNonForwardersShare.toString(),
    forwarders,
    nonForwarders,
  };
};

// ----------------------------------------------------------------------
// MAIN
const main = async () => {
  console.log("Starting vlCVX repartition generation...");
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // --- Gauge-based distribution (non-delegation part) ---
  console.log("Fetching Curve gauges...");
  const curveGauges = await getAllCurveGauges();
  console.log("Extracting CSV report...");
  const csvResult = (await extractCSV(currentPeriodTimestamp, CVX_SPACE)) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // (For debugging) Log total rewards per token in CSV
  const totalPerToken = Object.values(csvResult).reduce((acc, rewardArray) => {
    rewardArray.forEach(({ rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || BigInt(0)) + rewardAmount;
    });
    return acc;
  }, {} as Record<string, bigint>);
  console.log("Total rewards per token in CSV:", totalPerToken);

  console.log("Fetching proposal and votes...");
  const filter = "^(?!FXN ).*Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds([CVX_SPACE], now, filter);
  const proposalId = proposalIdPerSpace[CVX_SPACE];
  console.log("proposalId", proposalId);

  const proposal = await getProposal(proposalId);
  const gaugeMapping = associateGaugesPerId(proposal, curveGauges);
  const votes = await getVoters(proposalId);

  // --- Process StakeDAO Delegators ---
  console.log("Fetching StakeDAO delegators...");
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );
  let stakeDaoDelegators: string[] = [];
  if (isDelegationAddressVoter) {
    console.log("Delegation address is among voters; fetching StakeDAO delegators");
    stakeDaoDelegators = await processAllDelegators(CVX_SPACE, proposal.created, DELEGATION_ADDRESS);
    // Remove any delegator who voted by himself.
    for (const delegator of stakeDaoDelegators) {
      if (votes.some((voter) => voter.voter.toLowerCase() === delegator.toLowerCase())) {
        console.log("Removing delegator (voted by himself):", delegator);
        stakeDaoDelegators = stakeDaoDelegators.filter(
          (d) => d.toLowerCase() !== delegator.toLowerCase()
        );
      }
    }
    console.log("Final StakeDAO delegators:", stakeDaoDelegators);
  } else {
    console.log("Delegation address is not among voters; skipping StakeDAO delegators computation");
  }

  // --- Gauge-based rewards distribution ---
  console.log("Distributing rewards (gauge-based)...");
  const distribution: Distribution = {};
  Object.entries(csvResult).forEach(([gauge, rewardInfos]) => {
    const gaugeInfo = gaugeMapping[gauge.toLowerCase()];
    if (!gaugeInfo) throw new Error(`Choice ID not found for gauge: ${gauge}`);
    const choiceId = gaugeInfo.choiceId;
    let totalVp = 0;
    const voterVps: Record<string, number> = {};

    // Calculate total VP for this gauge.
    votes.forEach((voter) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      if (currentChoiceIndex === 0) return;
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      totalVp += (voter.vp * ratio) / 100;
    });

    // Calculate each voter's share.
    votes.forEach((voter) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      if (currentChoiceIndex === 0) return;
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      const voterShare = (voter.vp * ratio) / 100;
      voterVps[voter.voter] = voterShare / totalVp;
    });

    // Use 18-decimal precision.
    const totalVpBigInt = BigInt(Math.floor(totalVp * 1e18));
    rewardInfos.forEach(({ rewardAddress, rewardAmount }) => {
      let remainingRewards = rewardAmount;
      let processedVoters = 0;
      const totalVoters = Object.keys(voterVps).length;
      Object.entries(voterVps).forEach(([voter, share]) => {
        processedVoters++;
        let amount: bigint;
        if (processedVoters === totalVoters) {
          amount = remainingRewards; // last voter gets remaining to avoid dust.
        } else {
          amount = (rewardAmount * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
          remainingRewards -= amount;
        }
        if (amount > 0n) {
          if (!distribution[voter]) {
            distribution[voter] = { tokens: {} };
          }
          distribution[voter].tokens[rewardAddress] =
            (distribution[voter].tokens[rewardAddress] || 0n) + amount;
        }
      });
    });
  });

  // Remove any distribution entries with zero amounts.
  Object.keys(distribution).forEach((voter) => {
    const nonZeroTokens = Object.entries(distribution[voter].tokens).filter(
      ([, amount]) => amount > 0
    );
    if (nonZeroTokens.length === 0) {
      delete distribution[voter];
    } else {
      distribution[voter].tokens = Object.fromEntries(nonZeroTokens);
    }
  });

  // --- Compute Delegation Distribution & Summary ---
  console.log("Computing StakeDAO delegator rewards...");
  let delegationDistribution: Record<
    string,
    | { tokens: Record<string, bigint> }
    | { share: string; shareNonForwarders: string; shareForwarders: string }
  > = {};

  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    // Look for the delegation voter's entry in the gauge distribution.
    for (const [voter, { tokens }] of Object.entries(distribution)) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        // Compute delegation distribution based on the delegation voter's tokens.
        delegationDistribution = await computeStakeDaoDelegation(
          proposal,
          stakeDaoDelegators,
          tokens,
          voter
        );
        // Remove the delegation voter from the main (gauge) distribution.
        delete distribution[voter];
        break;
      }
    }
  }
  
  // Compute a delegation summary with total tokens and cumulative forwarder/non-forwarder shares.
  const delegationSummary = computeDelegationSummary(delegationDistribution);

  // --- Save gauge-based distributions (by chain) as before ---
  const distributionsByChain: Record<number, Distribution> = { 1: {} };
  const tokenChainIds: Record<string, number> = {};
  Object.values(csvResult).forEach((rewardInfos) => {
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1) { // Only track non-mainnet tokens if applicable.
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });
  Object.entries(distribution).forEach(([voter, { tokens }]) => {
    const tokensByChain: Record<number, Record<string, bigint>> = { 1: {} };
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const chainId = tokenChainIds[tokenAddress.toLowerCase()] || 1;
      if (!tokensByChain[chainId]) tokensByChain[chainId] = {};
      tokensByChain[chainId][tokenAddress] = amount;
    });
    Object.entries(tokensByChain).forEach(([chainId, chainTokens]) => {
      const numChainId = Number(chainId);
      if (!distributionsByChain[numChainId]) distributionsByChain[numChainId] = {};
      if (Object.keys(chainTokens).length > 0) {
        distributionsByChain[numChainId][voter] = { tokens: chainTokens };
      }
    });
  });

  // Define a helper to convert distributions to JSON-friendly format.
  const convertToJsonFormat = (dist: Distribution) => {
    return Object.entries(dist).reduce((acc, [voter, { tokens }]) => {
      acc[voter] = {
        tokens: Object.entries(tokens).reduce((tokenAcc, [token, amount]) => {
          tokenAcc[token] = amount.toString();
          return tokenAcc;
        }, {} as Record<string, string>),
      };
      return acc;
    }, {} as Record<string, { tokens: Record<string, string> }>);
  };

  // Save gauge-based distributions by chain.
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX`;
  fs.mkdirSync(dirPath, { recursive: true });
  Object.entries(distributionsByChain).forEach(([chainId, chainDistribution]) => {
    const filename = chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
    fs.writeFileSync(
      `${dirPath}/${filename}`,
      JSON.stringify({ distribution: convertToJsonFormat(chainDistribution) }, null, 2)
    );
  });

  // Save the delegation summary (new structure).
  fs.writeFileSync(
    `${dirPath}/repartition_delegation.json`,
    JSON.stringify({ distribution: delegationSummary }, null, 2)
  );

  console.log("vlCVX repartition generation completed successfully.");
};

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
