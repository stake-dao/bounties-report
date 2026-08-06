import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  WEEK,
  CVX_FXN_SPACE,
  VLCVX_ONCHAIN_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
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
import type { PublicClient } from "viem";
import { getClient } from "../../utils/getClients";
import { Proposal } from "../../utils/types";

dotenv.config();

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

// VLCVX_TARGET_PERIOD overrides the distribution period used to SELECT the
// on-chain proposal (output files stay in the current period's directory):
// "next" = the upcoming period, or an explicit WEEK-aligned unix timestamp.
// Operational use: the pre-cutover dry run executes on Tuesday right after
// the round finalizes — two days before the Thursday period that round feeds
// — where the period binding would (correctly) refuse the just-finalized
// proposal. Unlike VLCVX_ALLOW_ACTIVE_PROPOSAL it does NOT bypass finality:
// only a real, final proposal can ever be selected.
const resolveTargetPeriod = (currentPeriodTimestamp: number): number => {
  const raw = process.env.VLCVX_TARGET_PERIOD;
  if (!raw) return currentPeriodTimestamp;
  const target = raw === "next" ? currentPeriodTimestamp + WEEK : Number(raw);
  if (!Number.isInteger(target) || target % WEEK !== 0) {
    throw new Error(
      `Invalid VLCVX_TARGET_PERIOD "${raw}": expected "next" or a WEEK-aligned unix timestamp`
    );
  }
  console.log(
    `VLCVX_TARGET_PERIOD override: selecting the proposal for period ${target} ` +
      `(files still written to period ${currentPeriodTimestamp})`
  );
  return target;
};

const processGaugeProposal = async (
  gaugeType: "curve" | "fxn",
  proposal: Proposal,
  currentPeriodTimestamp: number,
  publicClient: PublicClient
): Promise<void> => {
  console.log(`Starting ${gaugeType} repartition generation...`);

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

  // Invalidate previous outputs BEFORE computing: on a re-run where a
  // computation is skipped (delegate without vote, gauge not voted), a stale
  // repartition_delegation.json / repartition_<chainId>.json would otherwise
  // survive and be consumed by the merkle step.
  for (const file of fs.readdirSync(dirPath)) {
    if (/^repartition.*\.json$/.test(file)) {
      fs.rmSync(path.join(dirPath, file), { force: true });
    }
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

  console.log("Fetching on-chain votes...");
  const platform =
    gaugeType === "curve"
      ? CVX_GAUGE_VOTE_PLATFORM_CURVE
      : CVX_GAUGE_VOTE_PLATFORM_FXN;
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
  // Two StakeDAO delegate wallets can cast a delegation vote: the on-chain
  // delegation voter (the seed's remap target) and the legacy Snapshot
  // delegate (0x52ea58f4…), which still carries weight from delegators who
  // never re-delegated (4,368 vlCVX at epoch 230). Each delegate vote is
  // split among ITS OWN delegators; the sets are disjoint (one delegate per
  // wallet per epoch).
  const delegationAddresses = [
    VLCVX_ONCHAIN_DELEGATION_ADDRESS,
    DELEGATION_ADDRESS,
  ];
  const delegatorsByDelegate: Record<string, string[]> = {};
  for (const delegate of delegationAddresses) {
    const isVoter = votes.some(
      (voter) => voter.voter.toLowerCase() === delegate.toLowerCase()
    );
    if (!isVoter) continue;

    console.log(`Delegate ${delegate} is among voters; fetching its delegators...`);
    const delegators = await getOnChainDelegators(
      CVX_GAUGE_DELEGATION,
      delegate,
      Number(proposal.snapshot), // vlCVX epoch
      publicClient
    );
    // Delegators who voted directly are NOT blanket-removed here: their
    // contribution to the delegate's vote is resolved per-address by
    // GaugeVoteHelper.getContributingWeights in computeStakeDaoDelegation —
    // 0 for a full direct vote, or only the delta that stayed with the
    // delegate (sync landed between their own vote and the delegate's).
    const directVoters = delegators.filter((delegator) =>
      votes.some((voter) => voter.voter.toLowerCase() === delegator.toLowerCase())
    );
    if (directVoters.length > 0) {
      console.log(
        `${directVoters.length} delegator(s) also voted directly — contributing ` +
          `weights resolved on-chain via GaugeVoteHelper:`,
        directVoters
      );
    }
    delegatorsByDelegate[delegate.toLowerCase()] = delegators;
    console.log(`Final delegators of ${delegate}: ${delegators.length}`);
  }
  if (Object.keys(delegatorsByDelegate).length === 0) {
    console.log(
      "No delegation address among voters; skipping StakeDAO delegators computation"
    );
  }

  // --- 3) Compute Non-Delegators Distribution ---
  console.log("Computing non-delegators distribution...");
  const nonDelegatorsDistribution: Distribution =
    computeNonDelegatorsDistribution(
      csvResult,
      gaugeMapping,
      votes,
      proposal.choices
    );

  // --- 4) Compute Delegation Distribution & Summary ---
  const delegationDistribution: DelegationDistribution = {};
  for (const [voter, { tokens }] of Object.entries(nonDelegatorsDistribution)) {
    const delegators = delegatorsByDelegate[voter.toLowerCase()];
    if (!delegators || delegators.length === 0) continue;

    const { distribution, delegateOwnTokens } = await computeStakeDaoDelegation(
      proposal,
      delegators,
      tokens,
      voter,
      publicClient
    );
    // Disjoint delegator sets: plain assignment cannot collide.
    for (const [delegator, entry] of Object.entries(distribution)) {
      delegationDistribution[delegator] = entry;
    }
    if (Object.keys(delegateOwnTokens).length > 0) {
      // Share earned by the delegate's OWN vlCVX (baseWeight): it belongs
      // to the delegate, not to the delegation pool.
      console.log(
        `Delegate ${voter} voted with own vlCVX — keeping its baseWeight share:`,
        delegateOwnTokens
      );
      nonDelegatorsDistribution[voter] = { tokens: delegateOwnTokens };
    } else {
      delete nonDelegatorsDistribution[voter];
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
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;
  const publicClient = await getClient(1);

  // VLCVX_ALLOW_ACTIVE_PROPOSAL=true is a TEST-ONLY escape hatch (fork /
  // virtual testnet): it skips the endTime+overtime finality guard. Never set
  // it in production — results read before endTime+600s are not final.
  // targetPeriod pins the proposals to the period being distributed, so a
  // late retry (FORCE_UPDATE after the next round finalized) cannot silently
  // switch the vote source of already-published files.
  const requireFinal = process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL !== "true";
  const targetPeriod = resolveTargetPeriod(currentPeriodTimestamp);

  // Resolve BOTH platforms' proposals and validate their coherence BEFORE any
  // file is written — including reruns where one platform's artifacts already
  // exist (crash-resume): the pair is validated regardless of what is skipped.
  console.log("Fetching on-chain proposals...");
  const curveProposal = await getOnChainProposal(
    CVX_GAUGE_VOTE_PLATFORM_CURVE,
    CVX_SPACE,
    publicClient,
    { requireFinal, targetPeriod }
  );
  const fxnProposal = await getOnChainProposal(
    CVX_GAUGE_VOTE_PLATFORM_FXN,
    CVX_FXN_SPACE,
    publicClient,
    { requireFinal, targetPeriod }
  );
  // Same round = same vlCVX epoch. End times are operator-supplied per
  // platform (createProposal takes free timestamps), so exact equality is not
  // guaranteed on-chain — tolerate small skew; rounds are 2 weeks apart, so
  // 6h cannot confuse two rounds.
  const CROSS_PLATFORM_END_TOLERANCE = 6 * 3600;
  if (
    Number(curveProposal.snapshot) !== Number(fxnProposal.snapshot) ||
    Math.abs(curveProposal.end - fxnProposal.end) > CROSS_PLATFORM_END_TOLERANCE
  ) {
    throw new Error(
      `Round mismatch between gauge platforms: curve proposal ${curveProposal.id} ` +
        `(vlCVX epoch ${curveProposal.snapshot}, end ${curveProposal.end}) vs ` +
        `fxn proposal ${fxnProposal.id} (vlCVX epoch ${fxnProposal.snapshot}, ` +
        `end ${fxnProposal.end}) — refusing to mix rounds`
    );
  }

  await processGaugeProposal(
    "curve",
    curveProposal,
    currentPeriodTimestamp,
    publicClient
  );
  await processGaugeProposal(
    "fxn",
    fxnProposal,
    currentPeriodTimestamp,
    publicClient
  );
};

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
