import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  VLAURA_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
} from "../../utils/constants";
import {
  associateAuraGaugesPerId,
  fetchAuraGaugeChoices,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { extractCSV } from "../../utils/utils";
import * as moment from "moment";
import {
  getVlAuraDelegatorsAtTimestamp,
  getVlAuraDelegatorsFromParquet,
  getSnapshotBlocks,
} from "../../utils/vlAuraUtils";
import { getClient } from "../../utils/getClients";
import {
  computeStakeDaoDelegation,
  computeDelegationSummary,
  DelegationDistribution,
  DelegationSummary,
} from "./delegators";
import {
  computeNonDelegatorsDistribution,
  Distribution,
} from "../../shared/nonDelegators";

dotenv.config();

type VlAuraCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

const main = async () => {
  console.log("Starting vlAURA repartition generation...");

  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Check if files already exist
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlAURA`;
  const repartitionFile = path.join(dirPath, "repartition.json");
  const delegationFile = path.join(dirPath, "repartition_delegation.json");

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  if (
    (fs.existsSync(repartitionFile) || fs.existsSync(delegationFile)) &&
    process.env.FORCE_UPDATE !== "true"
  ) {
    console.error(
      `Repartition files already exist for period ${currentPeriodTimestamp}`
    );
    console.error(`To force regeneration, run with FORCE_UPDATE=true`);
    return;
  }

  // Extract CSV report
  console.log("Extracting CSV report...");
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    VLAURA_SPACE
  )) as VlAuraCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // Fetch proposal and votes
  console.log("Fetching proposal and votes...");
  const filter = "Gauge Weight for Week of";
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [VLAURA_SPACE],
    now,
    filter
  );
  const proposalId = proposalIdPerSpace[VLAURA_SPACE];
  console.log("proposalId", proposalId);

  const proposal = await getProposal(proposalId);

  // Get snapshot block timestamp (like vlCVX does)
  const publicClient = await getClient(1);
  const snapshotBlock = await publicClient.getBlock({
    blockNumber: BigInt(proposal.snapshot),
  });
  const snapshotBlockTimestamp = Number(snapshotBlock.timestamp);
  console.log(`Snapshot block ${proposal.snapshot} at timestamp ${snapshotBlockTimestamp}`);

  // Fetch Aura gauge choices mapping (from aura-contracts repo)
  console.log("Fetching Aura gauge choices mapping...");
  const auraGaugeChoices = await fetchAuraGaugeChoices();
  console.log(`Loaded ${Object.keys(auraGaugeChoices).length} Aura gauge choice mappings`);

  // Extract gauge addresses from the CSV data
  const gaugeAddresses = Object.keys(csvResult);
  console.log(`Found ${gaugeAddresses.length} gauges in CSV data`);

  // Map gauges using the official Aura gauge_choices.json
  const gaugeMapping = associateAuraGaugesPerId(proposal, gaugeAddresses, auraGaugeChoices);
  console.log(`Successfully mapped ${Object.keys(gaugeMapping).length} gauges to proposal choices`);
  const votes = await getVoters(proposalId);

  // Process StakeDAO delegators
  console.log("Fetching StakeDAO delegators...");
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );

  // Get snapshot blocks early - needed for both Parquet queries and balance queries
  console.log("Computing snapshot blocks for all chains...");
  const snapshotBlocks = await getSnapshotBlocks(BigInt(proposal.snapshot));

  let stakeDaoDelegators: string[] = [];
  if (isDelegationAddressVoter) {
    console.log("Delegation address voted; fetching on-chain delegators at proposal snapshot...");

    // Primary: Use Parquet cache (RPC-indexed, authoritative)
    // Fallback: GraphQL API (if cache stale/missing)
    stakeDaoDelegators = await getVlAuraDelegatorsFromParquet(snapshotBlocks);
    console.log(`Fetched ${stakeDaoDelegators.length} delegators from Parquet/RPC`);

    // Remove delegators who voted directly
    for (const delegator of stakeDaoDelegators) {
      if (
        votes.some(
          (voter) => voter.voter.toLowerCase() === delegator.toLowerCase()
        )
      ) {
        console.log("Removing delegator (voted directly):", delegator);
        stakeDaoDelegators = stakeDaoDelegators.filter(
          (d) => d.toLowerCase() !== delegator.toLowerCase()
        );
      }
    }
    console.log(`Final delegators after exclusions: ${stakeDaoDelegators.length}`);
  } else {
    console.log("Delegation address did not vote this period; skipping delegation distribution");
  }

  // Compute non-delegators distribution
  console.log("Computing non-delegators distribution...");
  const nonDelegatorsDistribution: Distribution =
    computeNonDelegatorsDistribution(csvResult, gaugeMapping, votes);

  // Compute delegation distribution
  let delegationDistribution: DelegationDistribution = {};
  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    // snapshotBlocks already computed above for Parquet queries
    for (const [voter, { tokens }] of Object.entries(
      nonDelegatorsDistribution
    )) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        delegationDistribution = await computeStakeDaoDelegation(
          snapshotBlocks,
          stakeDaoDelegators,
          tokens,
          voter
        );
        delete nonDelegatorsDistribution[voter];
        break;
      }
    }
  }

  const delegationSummary: DelegationSummary =
    computeDelegationSummary(delegationDistribution);

  if (Object.keys(delegationSummary.delegators).length > 0) {
    console.log(`Delegation summary: ${Object.keys(delegationSummary.delegators).length} delegators`);
    console.log(`Total tokens to distribute: ${Object.keys(delegationSummary.totalTokens).length} tokens`);
  }

  // --- Break Down Distributions by Chain ---
  const distributionsByChain: Record<number, Distribution> = { 1: {} };
  const tokenChainIds: Record<string, number> = {};

  // Build token -> chainId mapping from CSV
  Object.values(csvResult).forEach((rewardInfos) => {
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1 && chainId != null) {
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });

  // Split non-delegators distribution by chain
  Object.entries(nonDelegatorsDistribution).forEach(([voter, { tokens }]) => {
    const tokensByChain: Record<number, Record<string, bigint>> = { 1: {} };
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const chainId = tokenChainIds[tokenAddress.toLowerCase()] || 1;
      if (!tokensByChain[chainId]) tokensByChain[chainId] = {};
      tokensByChain[chainId][tokenAddress] = amount;
    });
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

  // Split delegation summary by chain
  const delegationSummaryByChain: Record<number, DelegationSummary> = {
    1: { totalTokens: {}, delegators: {} },
  };

  // Initialize chains from tokenChainIds
  Object.keys(tokenChainIds).forEach((token) => {
    const chainId = tokenChainIds[token.toLowerCase()];
    if (!delegationSummaryByChain[chainId]) {
      delegationSummaryByChain[chainId] = { totalTokens: {}, delegators: {} };
    }
  });

  // Copy delegators to all chains (same shares apply)
  Object.keys(delegationSummaryByChain).forEach((chainId) => {
    delegationSummaryByChain[Number(chainId)].delegators = {
      ...delegationSummary.delegators,
    };
  });

  // Split totalTokens by chain
  Object.entries(delegationSummary.totalTokens).forEach(([token, amount]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    if (!delegationSummaryByChain[chainId]) {
      delegationSummaryByChain[chainId] = {
        totalTokens: {},
        delegators: { ...delegationSummary.delegators },
      };
    }
    delegationSummaryByChain[chainId].totalTokens[token] = amount;
  });

  // Convert to JSON format
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

  // --- Save Results by Chain ---
  // Save Non-Delegator Distributions by Chain
  Object.entries(distributionsByChain).forEach(
    ([chainId, chainDistribution]) => {
      if (Object.keys(chainDistribution).length === 0) return;
      const filename =
        chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
      fs.writeFileSync(
        path.join(dirPath, filename),
        JSON.stringify(
          { distribution: convertToJsonFormat(chainDistribution) },
          null,
          2
        )
      );
      console.log(`Saved non-delegators repartition to ${filename}`);
    }
  );

  // Save Delegation Summaries by Chain
  Object.entries(delegationSummaryByChain).forEach(
    ([chainId, chainDelegationSummary]) => {
      if (Object.keys(chainDelegationSummary.totalTokens).length === 0) return;
      if (Object.keys(chainDelegationSummary.delegators).length === 0) return;
      const filename =
        chainId === "1"
          ? "repartition_delegation.json"
          : `repartition_delegation_${chainId}.json`;
      fs.writeFileSync(
        path.join(dirPath, filename),
        JSON.stringify({ distribution: chainDelegationSummary }, null, 2)
      );
      console.log(`Saved delegation repartition to ${filename}`);
    }
  );

  console.log("vlAURA repartition generation completed successfully.");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
