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
import {
  computeStakeDaoDelegation,
  computeDelegationSummary,
  DelegationDistribution,
  DelegationSummary,
} from "./delegators";
import { computeNonDelegatorsDistribution, Distribution } from "./nonDelegators";

dotenv.config();

/**
 * Type representing CSV-based distribution data keyed by token,
 * where each token maps to an array of items containing the
 * reward address, reward amount, and (optionally) chainId.
 */
type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

/**
 * Main entry point for generating the weekly vlCVX "repartition":
 * 1. Loads gauge data from Curve.
 * 2. Extracts CSV data for the current epoch.
 * 3. Determines non-delegator distribution and delegation distribution.
 * 4. Persists data, split by chain (mainnet vs. other).
 */
const main = async () => {
  console.log("Starting vlCVX repartition generation...");

  // Calculate the current "epoch" timestamp by rounding down to the nearest week
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // --- 1) Gauge-based distribution (non-delegation) ---

  console.log("Fetching Curve gauges...");
  const curveGauges = await getAllCurveGauges();

  console.log("Extracting CSV report...");
  // Attempt to load the CSV data for the current week from the CVX_SPACE
  const csvResult = (await extractCSV(currentPeriodTimestamp, CVX_SPACE)) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // Summarize total rewards per token from the CSV for debugging/logging
  const totalPerToken = Object.values(csvResult).reduce((acc, rewardArray) => {
    rewardArray.forEach(({ rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || BigInt(0)) + rewardAmount;
    });
    return acc;
  }, {} as Record<string, bigint>);
  console.log("Total rewards per token in CSV:", totalPerToken);

  console.log("Fetching proposal and votes...");
  // Find the relevant proposal ID based on filter
  const filter = "^(?!FXN ).*Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds([CVX_SPACE], now, filter);
  const proposalId = proposalIdPerSpace[CVX_SPACE];
  console.log("proposalId", proposalId);

  // Retrieve the proposal details, map them to curve gauges, and then fetch voters
  const proposal = await getProposal(proposalId);
  const gaugeMapping = associateGaugesPerId(proposal, curveGauges);
  const votes = await getVoters(proposalId);

  // --- 2) Process StakeDAO Delegators ---

  console.log("Fetching StakeDAO delegators...");
  // Check if the special delegation address is in the list of voters
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );

  let stakeDaoDelegators: string[] = [];
  if (isDelegationAddressVoter) {
    console.log("Delegation address is among voters; fetching StakeDAO delegators...");
    // Retrieve the addresses that delegated to the special address
    stakeDaoDelegators = await processAllDelegators(
      CVX_SPACE,
      proposal.created,
      DELEGATION_ADDRESS
    );

    // Filter out any delegator who cast their own direct vote
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

  // --- 3) Compute Non-Delegators Distribution ---

  console.log("Computing non-delegators distribution...");
  // This calculates how each voter (who isn't delegating) should receive rewards,
  // based on the gaugeMapping and CSV results
  const nonDelegatorsDistribution: Distribution = computeNonDelegatorsDistribution(
    csvResult,
    gaugeMapping,
    votes
  );

  // --- 4) Compute Delegation Distribution & Summary ---

  let delegationDistribution: DelegationDistribution = {};
  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    // If the delegation address itself received tokens, we process them further
    for (const [voter, { tokens }] of Object.entries(nonDelegatorsDistribution)) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        // Compute how these tokens are sub-distributed among the delegators
        delegationDistribution = await computeStakeDaoDelegation(
          proposal,
          stakeDaoDelegators,
          tokens,
          voter
        );
        // Remove the delegation address from the non-delegators, since we'll handle it separately
        delete nonDelegatorsDistribution[voter];
        break;
      }
    }
  }

  // Summarize the delegation data (e.g. total forwarder / non-forwarder shares, etc.)
  const delegationSummary: DelegationSummary = computeDelegationSummary(delegationDistribution);

  // --- 5) Break Down Distributions by Chain ---

  // This object will store non-delegator distributions keyed by chain ID
  const distributionsByChain: Record<number, Distribution> = { 1: {} };

  // We'll track which token belongs to which chain (if chainId != 1)
  const tokenChainIds: Record<string, number> = {};

  // Identify tokens that belong to non-mainnet chains based on CSV data
  Object.values(csvResult).forEach((rewardInfos) => {
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1 && chainId != null) {
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });

  // Distribute each voter's tokens among the appropriate chain entries
  Object.entries(nonDelegatorsDistribution).forEach(([voter, { tokens }]) => {
    // Temporary map of chain => token => amount for the current voter
    const tokensByChain: Record<number, Record<string, bigint>> = { 1: {} };
    // For each token, see if it belongs to chain 1 or another chain
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const chainId = tokenChainIds[tokenAddress.toLowerCase()] || 1;
      if (!tokensByChain[chainId]) tokensByChain[chainId] = {};
      tokensByChain[chainId][tokenAddress] = amount;
    });

    // Merge tokens back into distributionsByChain
    Object.entries(tokensByChain).forEach(([chainId, chainTokens]) => {
      const numChainId = Number(chainId);
      if (!distributionsByChain[numChainId]) {
        distributionsByChain[numChainId] = {};
      }
      if (Object.keys(chainTokens).length > 0) {
        distributionsByChain[numChainId][voter] = { tokens: chainTokens };
      }
    });
  });

  // Store delegation summaries by chain ID
  const delegationSummaryByChain: Record<number, DelegationSummary> = {
    1: {} as DelegationSummary,
  };

  // Initialize a chain-specific DelegationSummary structure whenever we encounter a new chain
  Object.keys(tokenChainIds).forEach((token) => {
    const chainId = tokenChainIds[token.toLowerCase()];
    if (!delegationSummaryByChain[chainId]) {
      delegationSummaryByChain[chainId] = {
        totalTokens: {},
        totalPerGroup: {},
        totalForwardersShare: delegationSummary.totalForwardersShare,
        totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
        forwarders: delegationSummary.forwarders,
        nonForwarders: delegationSummary.nonForwarders,
      };
    }
  });

  // Add chain 1 (Ethereum mainnet) with the core delegation summary structure
  delegationSummaryByChain[1] = {
    totalTokens: {},
    totalPerGroup: {},
    totalSDTPerGroup: delegationSummary.totalSDTPerGroup,
    totalForwardersShare: delegationSummary.totalForwardersShare,
    totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
    forwarders: delegationSummary.forwarders,
    nonForwarders: delegationSummary.nonForwarders,
  };

  // Sort tokens into the correct chain's "totalTokens"
  Object.entries(delegationSummary.totalTokens).forEach(([token, amount]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    delegationSummaryByChain[chainId].totalTokens[token] = amount;
  });

  // Sort tokens into the correct chain's "totalPerGroup" 
  Object.entries(delegationSummary.totalPerGroup).forEach(([token, groupData]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    delegationSummaryByChain[chainId].totalPerGroup[token] = groupData;
  });

  /**
   * Convert the distribution BigInt amounts to string form,
   * so they can be readily serialized to JSON.
   */
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

  // Create the output directory if it doesn't exist
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX`;
  fs.mkdirSync(dirPath, { recursive: true });

  // 6) Save Non-Delegator Distributions by Chain
  Object.entries(distributionsByChain).forEach(([chainId, chainDistribution]) => {
    const filename = chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
    fs.writeFileSync(
      `${dirPath}/${filename}`,
      JSON.stringify({ distribution: convertToJsonFormat(chainDistribution) }, null, 2)
    );
  });

  // 7) Save Delegation Summaries by Chain
  Object.entries(delegationSummaryByChain).forEach(([chainId, chainDelegationSummary]) => {
    // Only save if there's actually some distribution for this chain
    if (Object.keys(chainDelegationSummary.totalTokens).length > 0) {
      const filename = chainId === "1"
        ? "repartition_delegation.json"
        : `repartition_delegation_${chainId}.json`;
      fs.writeFileSync(
        `${dirPath}/${filename}`,
        JSON.stringify({ distribution: chainDelegationSummary }, null, 2)
      );
    }
  });

  console.log("vlCVX repartition generation completed successfully.");
};

// Kick off the script
main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
