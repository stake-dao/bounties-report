import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  WEEK,
  DELEGATION_ADDRESS,
  CVX_FXN_SPACE,
} from "../../utils/constants";
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
import {
  computeNonDelegatorsDistribution,
  Distribution,
} from "./nonDelegators";
import { getGaugesInfos } from "../../utils/reportUtils";
import { http } from "viem";
import { createPublicClient } from "viem";
import { mainnet } from "viem/chains";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

const processGaugeProposal = async (
  space: string,
  gaugeType: "curve" | "fxn"
) => {
  console.log(`Starting ${gaugeType} repartition generation...`);

  // Calculate current "epoch"
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Check if files already exist
  const dirPath = `bounties-reports/${currentPeriodTimestamp}/vlCVX/${gaugeType}`;
  const repartitionFile = path.join(dirPath, "repartition.json");
  const delegationFile = path.join(dirPath, "repartition_delegation.json");
  
  if ((fs.existsSync(repartitionFile) || fs.existsSync(delegationFile)) && process.env.FORCE_UPDATE !== "true") {
    console.error(`⚠️  ERROR: Repartition files already exist for ${gaugeType} in period ${currentPeriodTimestamp}`);
    console.error(`   Files found in: ${dirPath}`);
    console.error(`   To force regeneration, run with FORCE_UPDATE=true`);
    return;
  }

  // --- 1) Gauge-based distribution (non-delegation) ---

  let gauges;
  if (gaugeType === "curve") {
    console.log("Fetching Curve gauges...");
    gauges = await getAllCurveGauges();
  } else {
    gauges = await getGaugesInfos("fxn");
  }

  console.log("Extracting CSV report...");
  const csvResult = (await extractCSV(
    currentPeriodTimestamp,
    gaugeType === "curve" ? CVX_SPACE : CVX_FXN_SPACE
  )) as CvxCSVType;
  if (!csvResult) throw new Error("No CSV report found");

  // Summarize total rewards per token for logging
  const totalPerToken = Object.values(csvResult).reduce((acc, rewardArray) => {
    rewardArray.forEach(({ rewardAddress, rewardAmount }) => {
      acc[rewardAddress] = (acc[rewardAddress] || BigInt(0)) + rewardAmount;
    });
    return acc;
  }, {} as Record<string, bigint>);
  console.log("Total rewards per token in CSV:", totalPerToken);

  console.log("Fetching proposal and votes...");
  // Set the filter depending on the gaugeType.
  // For fxn proposals, assume they start with "FXN", while for vlCVX, filter them out.
  const filter =
    gaugeType === "fxn"
      ? "^FXN.*Gauge Weight for Week of"
      : "^(?!FXN ).*Gauge Weight for Week of";

  const proposalIdPerSpace = await fetchLastProposalsIds([space], now, filter);
  const proposalId = proposalIdPerSpace[space];
  console.log("proposalId", proposalId);

  const proposal = await getProposal(proposalId);

  // Get snapshot block timestamp
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(),
  });
  const block = await publicClient.getBlock({
    blockNumber: BigInt(proposal.snapshot),
  });
  const snapshotBlockTimestamp = block.timestamp;

  // If FXN
  if (gaugeType === "fxn") {
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  const gaugeMapping = associateGaugesPerId(proposal, gauges);
  let votes = await getVoters(proposalId);

  // --- 2) Process StakeDAO Delegators ---
  console.log("Fetching StakeDAO delegators...");
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );

  let stakeDaoDelegators: string[] = [];
  if (isDelegationAddressVoter) {
    console.log(
      "Delegation address is among voters; fetching StakeDAO delegators..."
    );
    stakeDaoDelegators = await processAllDelegators(
      space,
      Number(snapshotBlockTimestamp),
      DELEGATION_ADDRESS
    );
    // Remove any delegator who voted directly.
    for (const delegator of stakeDaoDelegators) {
      if (
        votes.some(
          (voter) => voter.voter.toLowerCase() === delegator.toLowerCase()
        )
      ) {
        console.log("Removing delegator (voted by himself):", delegator);
        stakeDaoDelegators = stakeDaoDelegators.filter(
          (d) => d.toLowerCase() !== delegator.toLowerCase()
        );
      }
    }
    console.log("Final StakeDAO delegators:", stakeDaoDelegators);
  } else {
    console.log(
      "Delegation address is not among voters; skipping StakeDAO delegators computation"
    );
  }

  // --- 3) Compute Non-Delegators Distribution ---
  console.log("Computing non-delegators distribution...");
  const nonDelegatorsDistribution: Distribution =
    computeNonDelegatorsDistribution(csvResult, gaugeMapping, votes);

  // --- 4) Compute Delegation Distribution & Summary ---
  let delegationDistribution: DelegationDistribution = {};
  if (isDelegationAddressVoter && stakeDaoDelegators.length > 0) {
    for (const [voter, { tokens }] of Object.entries(
      nonDelegatorsDistribution
    )) {
      if (voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        delegationDistribution = await computeStakeDaoDelegation(
          proposal,
          stakeDaoDelegators,
          tokens,
          voter
        );
        delete nonDelegatorsDistribution[voter];
        break;
      }
    }
  }

  const delegationSummary: DelegationSummary = computeDelegationSummary(
    delegationDistribution
  );

  // --- 5) Break Down Distributions by Chain ---
  const distributionsByChain: Record<number, Distribution> = { 1: {} };
  const tokenChainIds: Record<string, number> = {};

  Object.values(csvResult).forEach((rewardInfos) => {
    rewardInfos.forEach(({ chainId, rewardAddress }) => {
      if (chainId !== 1 && chainId != null) {
        tokenChainIds[rewardAddress.toLowerCase()] = chainId;
      }
    });
  });

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

  const delegationSummaryByChain: Record<number, DelegationSummary> = {
    1: {} as DelegationSummary,
  };
  delegationSummaryByChain[1] = {
    totalTokens: {},
    totalPerGroup: {},
    totalForwardersShare: delegationSummary.totalForwardersShare,
    totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
    forwarders: delegationSummary.forwarders,
    nonForwarders: delegationSummary.nonForwarders,
  };

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

  Object.entries(delegationSummary.totalTokens).forEach(([token, amount]) => {
    const chainId = tokenChainIds[token.toLowerCase()] || 1;
    delegationSummaryByChain[chainId].totalTokens[token] = amount;
  });

  Object.entries(delegationSummary.totalPerGroup).forEach(
    ([token, groupData]) => {
      const chainId = tokenChainIds[token.toLowerCase()] || 1;
      delegationSummaryByChain[chainId].totalPerGroup[token] = groupData;
    }
  );

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

  // --- 6) Save Results to Files ---
  // Save Non-Delegator Distributions by Chain
  Object.entries(distributionsByChain).forEach(
    ([chainId, chainDistribution]) => {
      const filename =
        chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
      fs.writeFileSync(
        `${dirPath}/${filename}`,
        JSON.stringify(
          { distribution: convertToJsonFormat(chainDistribution) },
          null,
          2
        )
      );
    }
  );

  // Save Delegation Summaries by Chain
  Object.entries(delegationSummaryByChain).forEach(
    ([chainId, chainDelegationSummary]) => {
      if (Object.keys(chainDelegationSummary.totalTokens).length > 0) {
        const filename =
          chainId === "1"
            ? "repartition_delegation.json"
            : `repartition_delegation_${chainId}.json`;
        fs.writeFileSync(
          `${dirPath}/${filename}`,
          JSON.stringify({ distribution: chainDelegationSummary }, null, 2)
        );
      }
    }
  );

  console.log(`${gaugeType} repartition generation completed successfully.`);
};

// Main entry point that processes both proposal types
const main = async () => {
  // Process curve gauge weight proposal
  await processGaugeProposal(CVX_SPACE, "curve");

  // Process fxn gauge weight proposal
  await processGaugeProposal(CVX_SPACE, "fxn");
};

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
