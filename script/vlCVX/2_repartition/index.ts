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
  buildDelegationSummary,
  DelegationDistribution,
  DelegationSummary,
  PerDelegateExact,
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


  // --- 2) Derive delegate voters on-chain ---
  // Any voter carrying delegated weight at the epoch is a delegate: its vote
  // is split among ITS delegators. Nothing is declared in a list — a new
  // delegation wallet (ours or a third party's) is handled the round it
  // first votes, and its baseWeight share stays with the delegate itself.
  const delegationAddress = VLCVX_ONCHAIN_DELEGATION_ADDRESS;
  const delegatedWeights = (await publicClient.multicall({
    allowFailure: false,
    contracts: votes.map((voter) => ({
      address: CVX_GAUGE_DELEGATION as `0x${string}`,
      abi: [
        {
          inputs: [
            { name: "epoch", type: "uint256" },
            { name: "delegate", type: "address" },
          ],
          name: "balanceAtEpochOf",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function",
        },
      ] as const,
      functionName: "balanceAtEpochOf",
      args: [BigInt(proposal.snapshot), voter.voter],
    })),
  })) as bigint[];
  const delegateVoters = votes
    .filter((_, index) => delegatedWeights[index] > 0n)
    .map((voter) => voter.voter);
  console.log(
    `Delegate voters (on-chain delegated weight > 0): ${delegateVoters.length}`,
    delegateVoters
  );

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
  // Every delegate voter's pool splits among ITS OWN delegators only,
  // wei-conserving (perDelegate section — the payable data). Routing is per
  // delegator: forwarding to Stake DAO's Votium forwarder → Tuesday sCRVUSD;
  // otherwise raw tokens with the non-forwarders. The combined-VP scalar
  // share fields are membership/reporting data consumed by the verifiers.
  const delegationDistribution: DelegationDistribution = {};
  const mergedPoolTokens: Record<string, bigint> = {};
  const delegatorWeights: Record<
    string,
    { vp: number; forwarder: boolean }
  > = {};
  let combinedVp = 0;
  const perDelegateExact: PerDelegateExact[] = [];

  for (const delegate of delegateVoters) {
    const key = Object.keys(nonDelegatorsDistribution).find(
      (voter) => voter.toLowerCase() === delegate.toLowerCase()
    );
    if (!key) continue;

    const delegators = await getOnChainDelegators(
      CVX_GAUGE_DELEGATION,
      delegate,
      Number(proposal.snapshot),
      publicClient
    );
    if (delegators.length === 0) continue;

    const { distribution, delegateOwnTokens, totalDelegatedVp, exact } =
      await computeStakeDaoDelegation(
        proposal,
        delegators,
        nonDelegatorsDistribution[key].tokens,
        key,
        publicClient
      );
    perDelegateExact.push(exact);

    for (const [address, data] of Object.entries(distribution)) {
      if ("tokens" in data) {
        for (const [token, amount] of Object.entries(data.tokens)) {
          mergedPoolTokens[token] = (mergedPoolTokens[token] ?? 0n) + amount;
        }
      } else {
        const addr = address.toLowerCase();
        const vp = parseFloat(data.share) * totalDelegatedVp;
        const existing = delegatorWeights[addr] ?? { vp: 0, forwarder: false };
        delegatorWeights[addr] = {
          vp: existing.vp + vp,
          forwarder:
            existing.forwarder || parseFloat(data.shareForwarders) > 0,
        };
      }
    }
    combinedVp += totalDelegatedVp;

    if (Object.keys(delegateOwnTokens).length > 0) {
      // Share earned by the delegate's OWN vlCVX (baseWeight): it belongs
      // to the delegate, not to the delegation pool.
      console.log(
        `Delegate ${key} voted with own vlCVX — keeping its baseWeight share:`,
        delegateOwnTokens
      );
      nonDelegatorsDistribution[key] = { tokens: delegateOwnTokens };
    } else {
      delete nonDelegatorsDistribution[key];
    }
  }

  if (combinedVp > 0) {
    for (const [address, { vp, forwarder }] of Object.entries(
      delegatorWeights
    )) {
      const share = (vp / combinedVp).toString();
      delegationDistribution[address] = {
        share,
        shareNonForwarders: forwarder ? "0" : share,
        shareForwarders: forwarder ? share : "0",
      };
    }
    delegationDistribution[delegationAddress] = { tokens: mergedPoolTokens };
  }

  const delegationSummary: DelegationSummary = buildDelegationSummary(
    delegationDistribution,
    perDelegateExact
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

  const emptyChainSummary = (): DelegationSummary => ({
    totalTokens: {},
    totalPerGroup: {},
    totalForwardersShare: delegationSummary.totalForwardersShare,
    totalNonForwardersShare: delegationSummary.totalNonForwardersShare,
    forwarders: delegationSummary.forwarders,
    nonForwarders: delegationSummary.nonForwarders,
    perDelegate: {},
  });

  const delegationSummaryByChain: Record<number, DelegationSummary> = {
    1: emptyChainSummary(),
  };

  Object.keys(tokenChainIds).forEach((token) => {
    const chainId = tokenChainIds[token.toLowerCase()];
    if (!delegationSummaryByChain[chainId]) {
      delegationSummaryByChain[chainId] = emptyChainSummary();
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

  // Chain-split the per-delegate sections the same way totalTokens is split:
  // a token's full column (pool + every wallet amount) belongs to its token's
  // chain. Wallets/delegates with no token left on a chain are dropped from
  // that chain's file.
  const chainOfToken = (token: string): number =>
    tokenChainIds[token.toLowerCase()] || 1;
  Object.entries(delegationSummary.perDelegate).forEach(
    ([delegate, delegateData]) => {
      const filterTokenMap = (
        m: Record<string, string>,
        chainId: number
      ): Record<string, string> =>
        Object.fromEntries(
          Object.entries(m).filter(([token]) => chainOfToken(token) === chainId)
        );

      for (const chainIdStr of Object.keys(delegationSummaryByChain)) {
        const chainId = Number(chainIdStr);
        const poolTokens = filterTokenMap(delegateData.poolTokens, chainId);
        if (Object.keys(poolTokens).length === 0) continue;

        const filterGroup = (
          group: Record<string, Record<string, string>>
        ): Record<string, Record<string, string>> => {
          const out: Record<string, Record<string, string>> = {};
          for (const [addr, tokens] of Object.entries(group)) {
            const filtered = filterTokenMap(tokens, chainId);
            if (Object.keys(filtered).length > 0) out[addr] = filtered;
          }
          return out;
        };

        delegationSummaryByChain[chainId].perDelegate[delegate] = {
          poolTokens,
          forwarders: filterGroup(delegateData.forwarders),
          nonForwarders: filterGroup(delegateData.nonForwarders),
        };
      }
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
