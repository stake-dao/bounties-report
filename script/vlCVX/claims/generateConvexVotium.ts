import { fetchVotiumClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  DELEGATION_ADDRESS,
  VOTIUM_FORWARDER_REGISTRY,
} from "../../utils/constants";
import { getGaugesInfos } from "../../utils/reportUtils";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import {
  associateGaugesPerId,
  fetchLastProposalsIds,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { getAllCurveGauges } from "../../utils/curveApi";

const WEEK = 604800;

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

function customReplacer(key: string, value: any) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") {
      return value.value;
    }
    const newObj = {};
    for (const k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        newObj[k] = customReplacer(k, value[k]);
      }
    }
    return newObj;
  }
  return value;
}

// ---------------------------------------------------------------------
// fetchProposalVotes now returns ALL votes (without filtering by delegation)
// and attaches gauge info based on the proposal choices.
async function fetchProposalVotes(
  space,
  filter,
  gaugeFetcher,
  transformGauges = false
) {
  const now = Math.floor(Date.now() / 1000);
  const proposalIdPerSpace = await fetchLastProposalsIds([space], now, filter);
  const proposalId = proposalIdPerSpace[space];
  const proposal = await getProposal(proposalId);

  // Get gauges and optionally transform for uniform naming.
  let gauges = await gaugeFetcher();
  if (transformGauges) {
    gauges = gauges.map((gauge) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  // Associate gauges to the proposal’s choices.
  const gaugeMapping = associateGaugesPerId(proposal, gauges);
  const gaugeMappingWithInfos = {};
  for (const gaugeKey of Object.keys(gaugeMapping)) {
    const match = gauges.find(
      (g) =>
        g.gauge.toLowerCase() === gaugeKey.toLowerCase() ||
        (g.rootGauge && g.rootGauge.toLowerCase() === gaugeKey.toLowerCase())
    );
    if (match) {
      gaugeMappingWithInfos[gaugeKey] = {
        shortName: match.shortName,
        choiceId: gaugeMapping[gaugeKey].choiceId,
        gauge: match.gauge,
      };
    }
  }

  // Get all proposal votes (do NOT filter by delegation here)
  const votes = await getVoters(proposalId);

  // Attach gauge info for each vote's choices.
  const processedVotes = votes.map((vote) => {
    let choicesWithInfos = {};
    if (vote.choice && typeof vote.choice === "object") {
      Object.keys(vote.choice).forEach((choiceId) => {
        const gaugeKey = Object.keys(gaugeMappingWithInfos).find(
          (key) => gaugeMappingWithInfos[key].choiceId === parseInt(choiceId)
        );
        if (gaugeKey) {
          choicesWithInfos[choiceId] = {
            shortName: gaugeMappingWithInfos[gaugeKey].shortName,
            gauge: gaugeMappingWithInfos[gaugeKey].gauge,
            weight: vote.choice[choiceId],
          };
        }
      });
    }
    return {
      ...vote,
      choicesWithInfos,
    };
  });

  return {
    proposalId,
    proposal,
    votes: processedVotes,
    gaugeMapping: gaugeMappingWithInfos,
  };
}

// ---------------------------------------------------------------------
// Helper: Fetch bribes for a given chain (e.g. "cvx-crv" or "cvx-fxn")
async function fetchBribes(chain) {
  const roundsUrl = `https://api.llama.airforce/bribes/votium/${chain}/rounds`;
  const roundsData = await fetch(roundsUrl).then((res) => res.json());
  const lastRoundNumber = roundsData.rounds
    ? Math.max(...roundsData.rounds)
    : null;
  if (!lastRoundNumber) return null;
  const bribesUrl = `https://api.llama.airforce/bribes/votium/${chain}/${lastRoundNumber}`;
  const bribesData = await fetch(bribesUrl).then((res) => res.json());
  return bribesData;
}

// ---------------------------------------------------------------------
// Helper: Compute delegation's effective share for a given gauge across all votes
function computeDelegationShareForGauge(votes, gaugeChoiceId) {
  let totalEffectiveVp = 0;
  let delegationEffectiveVp = 0;
  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      let vpChoiceSum = 0;
      let gaugeChoiceValue = 0;
      Object.keys(vote.choice).forEach((choiceId) => {
        const val = vote.choice[choiceId];
        vpChoiceSum += val;
        if (parseInt(choiceId) === gaugeChoiceId) {
          gaugeChoiceValue = val;
        }
      });
      if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
        const effectiveVp = (vote.vp * gaugeChoiceValue) / vpChoiceSum;
        totalEffectiveVp += effectiveVp;
        if (vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
          delegationEffectiveVp += effectiveVp;
        }
      }
    }
  });
  return totalEffectiveVp > 0 ? delegationEffectiveVp / totalEffectiveVp : 0;
}

// ---------------------------------------------------------------------
async function generateConvexVotiumBounties() {
  try {
    // Get current period from contract registry.
    const abi = [
      {
        name: "currentEpoch",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
    ];

    const currentEpoch = await ethereumClient.readContract({
      address: VOTIUM_FORWARDER_REGISTRY,
      abi,
      functionName: "currentEpoch",
    });

    const blockNumber1 = await getClosestBlockTimestamp(
      "ethereum",
      Number(currentEpoch)
    );
    const latestBlock = await ethereumClient.getBlockNumber();

    // This object will accumulate the delegation's claim (for each token) based on effective VP shares.
    const matchingBribesAggregated = {};

    // --------------------------
    // Process Curve Votes & Bribes
    // --------------------------
    let votesCurveResult;
    try {
      const curveFilter = "^(?!FXN ).*Gauge Weight for Week of";
      votesCurveResult = await fetchProposalVotes(
        CVX_SPACE,
        curveFilter,
        getAllCurveGauges
      );
    } catch (error) {
      console.error("Error processing Curve proposal:", error);
    }
    const curveVotes = votesCurveResult ? votesCurveResult.votes : [];
    const curveGaugeMapping = votesCurveResult
      ? votesCurveResult.gaugeMapping
      : {};

    const curveBribes = await fetchBribes("cvx-crv");

    // For each gauge in the Curve proposal, compute delegation's effective share
    for (const gaugeKey in curveGaugeMapping) {
      const gaugeInfo = curveGaugeMapping[gaugeKey];
      // Filter votes that have a choice for this gauge.
      const votesForGauge = curveVotes.filter(
        (vote) => vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
      );
      const delegationShare = computeDelegationShareForGauge(
        votesForGauge,
        gaugeInfo.choiceId
      );
      // For this gauge, filter matching Curve bribes.
      const matchingCurveBribes =
        curveBribes && curveBribes.epoch && curveBribes.epoch.bribes
          ? curveBribes.epoch.bribes.filter(
              (bribe) =>
                bribe.gauge.toLowerCase() === gaugeInfo.gauge.toLowerCase()
            )
          : [];
      matchingCurveBribes.forEach((bribe) => {
        // Calculate the delegation's claim for this bribe.
        const delegatedClaim = BigInt(
          Math.floor(Number(bribe.amount) * delegationShare)
        );
        if (!matchingBribesAggregated[bribe.token]) {
          matchingBribesAggregated[bribe.token] = {
            curveAmount: BigInt(0),
            fxnAmount: BigInt(0),
            bribes: [],
          };
        }
        matchingBribesAggregated[bribe.token].curveAmount += delegatedClaim;
        matchingBribesAggregated[bribe.token].bribes.push({
          ...bribe,
          delegationShare,
          computedFromGauge: gaugeInfo.gauge,
          type: "curve",
        });
      });
    }

    // --------------------------
    // Process FXN Votes & Bribes
    // --------------------------
    let votesFxnResult;
    try {
      const fxnFilter = "^FXN .*Gauge Weight for Week of";
      votesFxnResult = await fetchProposalVotes(
        CVX_SPACE,
        fxnFilter,
        () => getGaugesInfos("fxn"),
        true
      );
    } catch (error) {
      console.error("Error processing FXN proposal:", error);
    }
    const fxnVotes = votesFxnResult ? votesFxnResult.votes : [];
    const fxnGaugeMapping = votesFxnResult ? votesFxnResult.gaugeMapping : {};

    const fxnBribes = await fetchBribes("cvx-fxn");

    for (const gaugeKey in fxnGaugeMapping) {
      const gaugeInfo = fxnGaugeMapping[gaugeKey];
      const votesForGauge = fxnVotes.filter(
        (vote) => vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
      );
      const delegationShare = computeDelegationShareForGauge(
        votesForGauge,
        gaugeInfo.choiceId
      );
      const matchingFxnBribes =
        fxnBribes && fxnBribes.epoch && fxnBribes.epoch.bribes
          ? fxnBribes.epoch.bribes.filter(
              (bribe) =>
                bribe.gauge.toLowerCase() === gaugeInfo.gauge.toLowerCase()
            )
          : [];
      matchingFxnBribes.forEach((bribe) => {
        const delegatedClaim = BigInt(
          Math.floor(Number(bribe.amount) * delegationShare)
        );
        if (!matchingBribesAggregated[bribe.token]) {
          matchingBribesAggregated[bribe.token] = {
            curveAmount: BigInt(0),
            fxnAmount: BigInt(0),
            bribes: [],
          };
        }
        matchingBribesAggregated[bribe.token].fxnAmount += delegatedClaim;
        matchingBribesAggregated[bribe.token].bribes.push({
          ...bribe,
          delegationShare,
          computedFromGauge: gaugeInfo.gauge,
          type: "fxn",
        });
      });
    }

    // --------------------------
    // Compute final bounty distributions
    // --------------------------
    // Fetch claimed bounties from votium.
    let votiumConvexBounties = await fetchVotiumClaimedBounties(
      blockNumber1,
      Number(latestBlock)
    );

    // Split each reward amount by 2 (for two-week distribution)
    const splitBounties = votiumConvexBounties.votium.map((bounty) => ({
      rewardToken: bounty.rewardToken,
      amount: bounty.amount / BigInt(2),
    }));

    // Use matchingBribesAggregated to determine share percentages per token.
    const curveBounties = {};
    const fxnBounties = {};

    splitBounties.forEach((bounty) => {
      const matching = matchingBribesAggregated[bounty.rewardToken];
      let curveShare = 50;
      let fxnShare = 50;
      if (matching) {
        const total = Number(matching.curveAmount) + Number(matching.fxnAmount);
        if (total > 0) {
          curveShare = (Number(matching.curveAmount) / total) * 100;
          fxnShare = (Number(matching.fxnAmount) / total) * 100;
        }
      }
      const splitAmount = Number(bounty.amount);
      const amountCRV = BigInt(Math.floor(splitAmount * (curveShare / 100)));
      const amountFXN = BigInt(Math.floor(splitAmount * (fxnShare / 100)));

      curveBounties[bounty.rewardToken] = amountCRV;
      fxnBounties[bounty.rewardToken] = amountFXN;
    });

    console.log("Final Bounties (combined):", { curveBounties, fxnBounties });
    console.log("Curve Bounties:", curveBounties);
    console.log("FXN Bounties:", fxnBounties);

    // --------------------------
    // Write output to file and log to Telegram
    // --------------------------
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    if (!fs.existsSync(weeklyBountiesDir)) {
      fs.mkdirSync(weeklyBountiesDir, { recursive: true });
    }

    const nowTimestamp = Math.floor(Date.now() / 1000);
    const currentPeriodTimestamp = Math.floor(nowTimestamp / WEEK) * WEEK;

    const periodFolder = path.join(
      weeklyBountiesDir,
      currentPeriodTimestamp.toString(),
      "votium"
    );
    if (!fs.existsSync(periodFolder)) {
      fs.mkdirSync(periodFolder, { recursive: true });
    }

    const fileName = path.join(periodFolder, "claimed_bounties_convex.json");
    const jsonString = JSON.stringify(votiumConvexBounties, customReplacer, 2);
    fs.writeFileSync(fileName, jsonString);
    console.log(`Convex locker votium bounties saved to ${fileName}`);

    const telegramLogger = new ClaimsTelegramLogger();
    await telegramLogger.logClaims(
      "votium/claimed_bounties_convex.json",
      currentPeriodTimestamp,
      votiumConvexBounties
    );
  } catch (error) {
    console.error("Error generating votium bounties:", error);
    process.exit(1);
  }
}

generateConvexVotiumBounties();
