import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  WEEK,
  CVX_FXN_SPACE,
  VLCVX_ONCHAIN_DELEGATION_ADDRESS,
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
  CVX_GAUGE_DELEGATION,
} from "../../utils/constants";
import {
  getOnChainProposal,
  getOnChainVoters,
  associateGaugesPerIdOnChain,
} from "../../utils/gaugeVotePlatform";
import { getOnChainDelegators } from "../../utils/onChainDelegation";
import { extractCSV } from "../../utils/utils";
import * as moment from "moment";
import { getAllCurveGauges } from "../../utils/curveApi";
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
import { getGaugesInfos } from "../../utils/reportUtils";
import { getClient } from "../../utils/getClients";

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
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  
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

  // If FXN, normalize gauge entries before mapping
  if (gaugeType === "fxn") {
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  console.log("Fetching on-chain proposal and votes...");
  const publicClient = await getClient(1); // Use getClient to get a reliable Ethereum mainnet client

  const platform =
    gaugeType === "curve"
      ? CVX_GAUGE_VOTE_PLATFORM_CURVE
      : CVX_GAUGE_VOTE_PLATFORM_FXN;
  // VLCVX_ALLOW_ACTIVE_PROPOSAL=true is a TEST-ONLY escape hatch (fork /
  // virtual testnet): it skips the endTime+overtime finality guard. Never set
  // it in production — results read before endTime+600s are not final.
  const proposal = await getOnChainProposal(platform, space, publicClient, {
    requireFinal: process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL !== "true",
  });
  const proposalId = proposal.id;
  console.log(
    `on-chain proposalId ${proposalId} (vlCVX epoch ${proposal.snapshot})`
  );
  const gaugeMapping = associateGaugesPerIdOnChain(proposal, gauges);
  const votes = await getOnChainVoters(
    platform,
    Number(proposalId),
    proposal,
    publicClient
  );

  // --- 2) Process StakeDAO Delegators ---
  console.log("Fetching StakeDAO delegators...");
  // The on-chain seed remapped StakeDAO's delegate to a new address; the
  // legacy Snapshot delegate (0x52ea58f4…) has zero on-chain weight.
  const delegationAddress = VLCVX_ONCHAIN_DELEGATION_ADDRESS;
  const isDelegationAddressVoter = votes.some(
    (voter) => voter.voter.toLowerCase() === delegationAddress.toLowerCase()
  );

  let stakeDaoDelegators: string[] = [];
  if (isDelegationAddressVoter) {
    console.log(
      "Delegation address is among voters; fetching StakeDAO delegators..."
    );
    stakeDaoDelegators = await getOnChainDelegators(
      CVX_GAUGE_DELEGATION,
      delegationAddress,
      Number(proposal.snapshot), // vlCVX epoch
      publicClient
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
      if (voter.toLowerCase() === delegationAddress.toLowerCase()) {
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
  const snapshotBlock = Number(proposal.snapshot);

  // Save Non-Delegator Distributions by Chain
  Object.entries(distributionsByChain).forEach(
    ([chainId, chainDistribution]) => {
      const filename =
        chainId === "1" ? "repartition.json" : `repartition_${chainId}.json`;
      fs.writeFileSync(
        `${dirPath}/${filename}`,
        JSON.stringify(
          {
            proposalId,
            snapshotBlock,
            distribution: convertToJsonFormat(chainDistribution),
          },
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
          JSON.stringify(
            {
              proposalId,
              snapshotBlock,
              distribution: chainDelegationSummary,
            },
            null,
            2
          )
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
