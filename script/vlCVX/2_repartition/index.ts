import * as dotenv from "dotenv";
import fs from "fs";
import { CVX_SPACE, WEEK, DELEGATION_ADDRESS } from "../../utils/constants";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { extractCSV } from "../../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../../utils/curveApi";
import { processAllDelegators } from "../../utils/cacheUtils";
import { computeStakeDaoDelegation, computeDelegationSummary } from "./delegators";
import { computeNonDelegatorsDistribution, Distribution } from "./nonDelegators";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }
>;

/**
 * Entry point to generate weekly vlCVX repartition.
 */
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

  // (For debugging) Log total rewards per token.
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

  // --- Compute vlcvx distribution for non-delegators ---
  console.log("Computing non-delegators distribution...");
  const nonDelegatorsDistribution: Distribution = computeNonDelegatorsDistribution(csvResult, gaugeMapping, votes);

  // --- Compute delegation distribution & summary ---
  let delegationDistribution: any = {};
  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    // Find the delegation voter's entry in the gauge distribution.
    for (const [voter, { tokens }] of Object.entries(nonDelegatorsDistribution)) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        delegationDistribution = await computeStakeDaoDelegation(proposal, stakeDaoDelegators, tokens, voter);
        // Remove the delegation voter from the non-delegators distribution.
        delete nonDelegatorsDistribution[voter];
        break;
      }
    }
  }
  const delegationSummary = computeDelegationSummary(delegationDistribution);

  // --- Save gauge-based distributions (by chain) ---
  const distributionsByChain: Record<number, Distribution> = { 1: {} };
  const tokenChainIds: Record<string, number> = {};
  Object.values(csvResult).forEach((rewardInfos) => {
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1) {
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });
  
  // Process non-delegator distributions by chain
  Object.entries(nonDelegatorsDistribution).forEach(([voter, { tokens }]) => {
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

  // --- Process delegation summary by chain ---
  const delegationSummaryByChain: Record<number, any> = { 1: {} };
  
  // Initialize with the base structure for each chain
  Object.keys(tokenChainIds).forEach(token => {
    const chainId = tokenChainIds[token.toLowerCase()];
    if (!delegationSummaryByChain[chainId]) {
      delegationSummaryByChain[chainId] = {
        totalTokens: {},
        totalPerGroup: {},
        totalForwardersShare: delegationSummary.totalForwardersShare,
        totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
        forwarders: delegationSummary.forwarders,
        nonForwarders: delegationSummary.nonForwarders
      };
    }
  });
  
  // Add Ethereum (chain 1) with the same structure
  delegationSummaryByChain[1] = {
    totalTokens: {},
    totalPerGroup: {},
    totalSDTPerGroup: delegationSummary.totalSDTPerGroup,
    totalForwardersShare: delegationSummary.totalForwardersShare,
    totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
    forwarders: delegationSummary.forwarders,
    nonForwarders: delegationSummary.nonForwarders
  };
  
  // Distribute tokens by chain
  Object.entries(delegationSummary.totalTokens).forEach(([token, amount]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    delegationSummaryByChain[chainId].totalTokens[token] = amount;
  });
  
  // Distribute totalPerGroup by chain
  Object.entries(delegationSummary.totalPerGroup).forEach(([token, groupData]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    delegationSummaryByChain[chainId].totalPerGroup[token] = groupData;
  });

  // Helper to convert distributions to JSON-friendly format.
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

  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX`;
  fs.mkdirSync(dirPath, { recursive: true });
  
  // Save non-delegator distributions by chain
  Object.entries(distributionsByChain).forEach(([chainId, chainDistribution]) => {
    const filename = chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
    fs.writeFileSync(
      `${dirPath}/${filename}`,
      JSON.stringify({ distribution: convertToJsonFormat(chainDistribution) }, null, 2)
    );
  });

  // Save delegation summaries by chain
  Object.entries(delegationSummaryByChain).forEach(([chainId, chainDelegationSummary]) => {
    // Only save if there are tokens for this chain
    if (Object.keys(chainDelegationSummary.totalTokens).length > 0) {
      const filename = chainId === "1" ? 
        "repartition_delegation.json" : 
        `repartition_delegation_${chainId}.json`;
      
      fs.writeFileSync(
        `${dirPath}/${filename}`,
        JSON.stringify({ distribution: chainDelegationSummary }, null, 2)
      );
    }
  });

  console.log("vlCVX repartition generation completed successfully.");
};

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
