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
  fetchLastProposalsIdsCurrentPeriod,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { getAllCurveGauges } from "../../utils/curveApi";

const WEEK = 604800;

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

// ERC20 ABI for symbol lookup
const erc20Abi = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
];

// Helper: Get token symbol using the ERC20 ABI.
async function getTokenSymbol(tokenAddress) {
  try {
    const symbol = await ethereumClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "symbol",
    });
    return symbol;
  } catch (error) {
    console.error(`Error fetching symbol for ${tokenAddress}:`, error);
    return null;
  }
}

// Helper: Custom replacer for JSON.stringify (handles BigInt)
function customReplacer(key, value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") return value.value;
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

// Helper: Ensure a directory exists (create if not)
function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------
// fetchProposalVotes returns all votes (without filtering by delegation)
// and attaches gauge info based on the proposal choices.
async function fetchProposalVotes(
  space,
  filter,
  gaugeFetcher,
  transformGauges = false
) {
  const now = Math.floor(Date.now() / 1000);
  const proposalIdPerSpace = await fetchLastProposalsIdsCurrentPeriod(
    [space],
    now,
    filter
  );
  const proposalId = proposalIdPerSpace[space];
  const proposal = await getProposal(proposalId);

  let gauges = await gaugeFetcher();
  if (transformGauges) {
    gauges = gauges.map((gauge) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

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

  const votes = await getVoters(proposalId);

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
    return { ...vote, choicesWithInfos };
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
// Helper: Compute delegation's effective share for a given gauge across all votes.
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
        if (
          vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase() ||
          vote.voter.toLowerCase() ===
            "0x717c4624365beb1aea1b1486d87372d488794a21".toLowerCase() // TODO: add all delegators who forwarded
        ) {
          delegationEffectiveVp += effectiveVp;
        }
      }
    }
  });
  return totalEffectiveVp > 0 ? delegationEffectiveVp / totalEffectiveVp : 0;
}

// ---------------------------------------------------------------------
// Main function: Generate Convex Votium Bounties
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

    for (const gaugeKey in curveGaugeMapping) {
      const gaugeInfo = curveGaugeMapping[gaugeKey];
      const votesForGauge = curveVotes.filter(
        (vote) => vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
      );
      const delegationShare = computeDelegationShareForGauge(
        votesForGauge,
        gaugeInfo.choiceId
      );
      const matchingCurveBribes =
        curveBribes && curveBribes.epoch && curveBribes.epoch.bribes
          ? curveBribes.epoch.bribes.filter(
              (bribe) =>
                bribe.gauge.toLowerCase() === gaugeInfo.gauge.toLowerCase()
            )
          : [];
      matchingCurveBribes.forEach((bribe) => {
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
    let votiumConvexBounties = await fetchVotiumClaimedBounties(
      blockNumber1,
      Number(latestBlock)
    );

    // Split each reward amount by 2 (for two-week distribution)
    const splitBounties = votiumConvexBounties.votium.map((bounty) => ({
      rewardToken: bounty.rewardToken,
      amount: bounty.amount / BigInt(2),
    }));

    // Create a mapping of token symbols to addresses concurrently.
    const tokenSymbolPairs = await Promise.all(
      splitBounties.map(async (bounty) => {
        const symbol = await getTokenSymbol(bounty.rewardToken);
        return symbol ? [symbol, bounty.rewardToken] : null;
      })
    );
    const tokenSymbolToAddress = Object.fromEntries(
      tokenSymbolPairs.filter((pair) => pair !== null)
    );

    // Map token addresses to bribes data using token symbols.
    const tokenAddressToBribes = {};
    for (const tokenSymbol in matchingBribesAggregated) {
      const matchingAddress = tokenSymbolToAddress[tokenSymbol];
      if (matchingAddress) {
        tokenAddressToBribes[matchingAddress] =
          matchingBribesAggregated[tokenSymbol];
      }
    }

    // Determine share percentages per token and compute final distributions.
    const curveBounties = {};
    const fxnBounties = {};

    splitBounties.forEach((bounty) => {
      const matching = tokenAddressToBribes[bounty.rewardToken];
      let curveShare = 0;
      let fxnShare = 0;

      if (matching) {
        const curveAmount = Number(matching.curveAmount);
        const fxnAmount = Number(matching.fxnAmount);
        const total = curveAmount + fxnAmount;
        if (total > 0) {
          curveShare = curveAmount / total;
          fxnShare = fxnAmount / total;
        } else {
          const hasCurveBribes = matching.bribes.some(
            (bribe) => bribe.type === "curve"
          );
          const hasFxnBribes = matching.bribes.some(
            (bribe) => bribe.type === "fxn"
          );
          if (hasCurveBribes && !hasFxnBribes) {
            curveShare = 1;
            fxnShare = 0;
          } else if (!hasCurveBribes && hasFxnBribes) {
            curveShare = 0;
            fxnShare = 1;
          } else if (hasCurveBribes && hasFxnBribes) {
            curveShare = 0.5;
            fxnShare = 0.5;
          }
        }
      } else {
        throw new Error(
          `Token ${bounty.rewardToken} not found in any bribes. Cannot determine allocation.`
        );
      }

      const splitAmount = Number(bounty.amount);
      const amountCRV = BigInt(Math.floor(splitAmount * curveShare));
      const amountFXN = BigInt(Math.floor(splitAmount * fxnShare));

      curveBounties[bounty.rewardToken] = amountCRV;
      fxnBounties[bounty.rewardToken] = amountFXN;
    });

    console.log("Curve Bounties:", curveBounties);
    console.log("FXN Bounties:", fxnBounties);

    // Add a protocol field to each bounty based on the split.
    votiumConvexBounties.votium = votiumConvexBounties.votium.map((bounty) => {
      const protocol =
        fxnBounties[bounty.rewardToken] > BigInt(0) &&
        curveBounties[bounty.rewardToken] > BigInt(0)
          ? "both"
          : fxnBounties[bounty.rewardToken] > BigInt(0)
          ? "fxn"
          : "curve";
      return { ...bounty, protocol };
    });

    // --------------------------
    // Write output to file and log to Telegram
    // --------------------------
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    ensureDirExists(weeklyBountiesDir);

    const nowTimestamp = Math.floor(Date.now() / 1000);
    const currentPeriodTimestamp = Math.floor(nowTimestamp / WEEK) * WEEK;
    const periodFolder = path.join(
      weeklyBountiesDir,
      currentPeriodTimestamp.toString(),
      "votium"
    );
    ensureDirExists(periodFolder);

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
