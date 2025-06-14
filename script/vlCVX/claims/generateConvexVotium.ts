import { fetchVotiumClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  VOTIUM_FORWARDER_REGISTRY,
  VOTIUM_FORWARDER,
  clients,
} from "../../utils/constants";
import { getGaugesInfos, getTokenInfo } from "../../utils/reportUtils";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";
import { getBlockNumberByTimestamp, getClosestBlockTimestamp } from "../../utils/chainUtils";
import {
  associateGaugesPerId,
  fetchLastProposalsIdsCurrentPeriod,
  getProposal,
  getVoters,
} from "../../utils/snapshot";
import { getAllCurveGauges } from "../../utils/curveApi";
import {
  fetchDelegatorData,
  getForwardedDelegators,
} from "../../utils/delegationHelper";

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

// We'll override the default trackedAddresses with the delegation-based list.
let trackedAddresses: string[] = [];

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
async function getTokenSymbol(tokenAddress: string) {
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
function customReplacer(key: string, value: any) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") return value.value;
    const newObj: any = {};
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
function ensureDirExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------
// fetchProposalVotesWithAddressBreakdown returns votes (with gauge info)
// and also collects a breakdown of votes for each tracked address.
async function fetchProposalVotesWithAddressBreakdown(
  space: string,
  filter: string,
  gaugeFetcher: () => Promise<any>,
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
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  const gaugeMapping = associateGaugesPerId(proposal, gauges);
  const gaugeMappingWithInfos: any = {};
  for (const gaugeKey of Object.keys(gaugeMapping)) {
    const match = gauges.find(
      (g: any) =>
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

  // Build per-address vote breakdown using the trackedAddresses list
  const addressBreakdown: Record<string, any[]> = {};
  trackedAddresses.forEach((addr) => {
    addressBreakdown[addr] = [];
  });

  const processedVotes = votes.map((vote: any) => {
    let choicesWithInfos: any = {};
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
          const voter = vote.voter.toLowerCase();
          if (trackedAddresses.includes(voter)) {
            addressBreakdown[voter].push({
              proposalId,
              gauge: gaugeMappingWithInfos[gaugeKey].gauge,
              choiceId: gaugeMappingWithInfos[gaugeKey].choiceId,
              weight: vote.choice[choiceId],
            });
          }
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
    addressBreakdown,
  };
}

// ---------------------------------------------------------------------
// Helper: Fetch bribes for a given chain (e.g. "cvx-crv" or "cvx-fxn")
async function fetchBribes(chain: string) {
  const roundsUrl = `https://api.llama.airforce/bribes/votium/${chain}/rounds`;
  const roundsData = await fetch(roundsUrl).then((res) => res.json());
  const lastRoundNumber = roundsData.rounds
    ? Math.max(...roundsData.rounds)
    : null;
  if (!lastRoundNumber) return null;
  console.log("lastRoundNumber", lastRoundNumber);
  const bribesUrl = `https://api.llama.airforce/bribes/votium/${chain}/${lastRoundNumber}`;
  const bribesData = await fetch(bribesUrl).then((res) => res.json());
  return bribesData;
}

// ---------------------------------------------------------------------
// Helper: Compute overall delegation share for a given gauge.
function computeDelegationShareForGauge(votes: any[], gaugeChoiceId: number) {
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
        const voter = vote.voter.toLowerCase();
        if (trackedAddresses.includes(voter)) {
          delegationEffectiveVp += effectiveVp;
        }
      }
    }
  });
  return totalEffectiveVp > 0 ? delegationEffectiveVp / totalEffectiveVp : 0;
}

// ---------------------------------------------------------------------
// Helper: Compute per-address effective vote shares for a given gauge.
function computeAddressSharesForGauge(
  votes: any[],
  gaugeChoiceId: number
): Record<string, number> {
  let totalEffectiveVp = 0;
  const addressVp: Record<string, number> = {};
  trackedAddresses.forEach((addr) => (addressVp[addr] = 0));

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
        const voter = vote.voter.toLowerCase();
        if (trackedAddresses.includes(voter)) {
          addressVp[voter] += effectiveVp;
        }
      }
    }
  });
  const addressShares: Record<string, number> = {};
  trackedAddresses.forEach((addr) => {
    addressShares[addr] =
      totalEffectiveVp > 0 ? addressVp[addr] / totalEffectiveVp : 0;
  });
  return addressShares;
}

// ---------------------------------------------------------------------
// Main function: Generate Convex Votium Bounties including per-address details.
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

    // ---------------------------------------------------------------------
    // Fetch delegation data and forwarded status for CVX_SPACE.
    // (We use the Curve proposal for context.)
    const now = Math.floor(Date.now() / 1000);
    const curveProposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"
    );
    const curveProposalId = curveProposalIds[CVX_SPACE];
    const curveProposal = await getProposal(curveProposalId);
    const votersCurve = (await getVoters(curveProposalId)).map((v: any) =>
      v.voter.toLowerCase()
    );

    const blockSnapshotEnd = await getBlockNumberByTimestamp(curveProposal.end, "after", 1);

    // Fetch delegation data for the space.
    const delegatorData = await fetchDelegatorData(CVX_SPACE, curveProposal);
    let forwardedMap: Record<string, string> = {};
    if (
      CVX_SPACE === "cvx.eth" &&
      delegatorData &&
      delegatorData.delegators.length > 0
    ) {
      const forwardedAddresses = await getForwardedDelegators(
        delegatorData.delegators,
        blockSnapshotEnd
      );
      // Build mapping from delegator to its forwarded address.
      delegatorData.delegators.forEach((delegator: string, index: number) => {
        forwardedMap[delegator.toLowerCase()] =
          forwardedAddresses[index].toLowerCase();
      });
    }

    // Filter and sort delegators with nonzero voting power.
    const totalVotingPower = delegatorData.totalVotingPower;
    const sortedDelegators = delegatorData.delegators
      .filter((delegator: string) => delegatorData.votingPowers[delegator] > 0)
      .sort(
        (a: string, b: string) =>
          (delegatorData.votingPowers[b] || 0) -
          (delegatorData.votingPowers[a] || 0)
      );
    const filteredDelegators = sortedDelegators.filter(
      (delegator: string) =>
        delegatorData.votingPowers[delegator] > totalVotingPower * 0.00000002
    );

    // Only keep delegators whose forwarded address matches VOTIUM_FORWARDER.
    const newTrackedAddresses = filteredDelegators
      .filter((delegator: string) => {
        return (
          forwardedMap[delegator.toLowerCase()] &&
          forwardedMap[delegator.toLowerCase()] ===
          VOTIUM_FORWARDER.toLowerCase()
        );
      })
      .map((addr: string) => addr.toLowerCase());

    // Update trackedAddresses with the delegation-based list.
    trackedAddresses = newTrackedAddresses;
    console.log(
      "Tracked Addresses (delegators with forwarded):",
      trackedAddresses
    );

    // ---------------------------------------------------------------------
    // Declare matchingBribesAggregated once for aggregate reporting.
    const matchingBribesAggregated: any = {};

    // Process Curve Votes & Bribes (with address breakdown)
    let votesCurveResult;
    try {
      const curveFilter = "^(?!FXN ).*Gauge Weight for Week of";
      votesCurveResult = await fetchProposalVotesWithAddressBreakdown(
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
    const curveAddressBreakdown = votesCurveResult
      ? votesCurveResult.addressBreakdown
      : {};

    const curveBribes = await fetchBribes("cvx-crv");

    // Prepare per-address token allocations
    const perAddressTokenAllocations: Record<
      string,
      Record<string, bigint>
    > = {};
    trackedAddresses.forEach((addr) => {
      perAddressTokenAllocations[addr] = {};
    });

    // Recompute gauge-bribe allocations for Curve
    for (const gaugeKey in curveGaugeMapping) {
      const gaugeInfo = curveGaugeMapping[gaugeKey];
      const votesForGauge = curveVotes.filter(
        (vote: any) =>
          vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
      );
      // Compute per-address shares for this gauge
      const addressShares = computeAddressSharesForGauge(
        votesForGauge,
        gaugeInfo.choiceId
      );
      const matchingCurveBribes =
        curveBribes && curveBribes.epoch && curveBribes.epoch.bribes
          ? curveBribes.epoch.bribes.filter(
            (bribe: any) =>
              bribe.gauge.toLowerCase() === gaugeInfo.gauge.toLowerCase()
          )
          : [];

      matchingCurveBribes.forEach((bribe: any) => {
        trackedAddresses.forEach((addr) => {
          const share = addressShares[addr];
          const delegatedClaim = BigInt(
            Math.floor(Number(bribe.amount) * share)
          );
          if (!perAddressTokenAllocations[addr][bribe.token]) {
            perAddressTokenAllocations[addr][bribe.token] = BigInt(0);
          }
          perAddressTokenAllocations[addr][bribe.token] += delegatedClaim;
        });
        // Aggregate overall (for later split)
        if (!matchingBribesAggregated[bribe.token]) {
          matchingBribesAggregated[bribe.token] = {
            curveAmount: BigInt(0),
            fxnAmount: BigInt(0),
            bribes: [],
          };
        }
        const delegationShare = computeDelegationShareForGauge(
          votesForGauge,
          gaugeInfo.choiceId
        );
        const delegatedClaimOverall = BigInt(
          Math.floor(Number(bribe.amount) * delegationShare)
        );
        matchingBribesAggregated[bribe.token].curveAmount +=
          delegatedClaimOverall;
        matchingBribesAggregated[bribe.token].bribes.push({
          ...bribe,
          delegationShare,
          computedFromGauge: gaugeInfo.gauge,
          type: "curve",
        });
      });
    }

    // ---------------------------------------------------------------------
    // Process FXN Votes & Bribes (with address breakdown)
    let votesFxnResult;
    try {
      const fxnFilter = "^FXN .*Gauge Weight for Week of";
      votesFxnResult = await fetchProposalVotesWithAddressBreakdown(
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
    const fxnAddressBreakdown = votesFxnResult
      ? votesFxnResult.addressBreakdown
      : {};

    const fxnBribes = await fetchBribes("cvx-fxn");

    for (const gaugeKey in fxnGaugeMapping) {
      const gaugeInfo = fxnGaugeMapping[gaugeKey];
      const votesForGauge = fxnVotes.filter(
        (vote: any) =>
          vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
      );
      const addressShares = computeAddressSharesForGauge(
        votesForGauge,
        gaugeInfo.choiceId
      );
      const matchingFxnBribes =
        fxnBribes && fxnBribes.epoch && fxnBribes.epoch.bribes
          ? fxnBribes.epoch.bribes.filter(
            (bribe: any) =>
              bribe.gauge.toLowerCase() === gaugeInfo.gauge.toLowerCase()
          )
          : [];
      matchingFxnBribes.forEach((bribe: any) => {
        trackedAddresses.forEach((addr) => {
          const share = addressShares[addr];
          const delegatedClaim = BigInt(
            Math.floor(Number(bribe.amount) * share)
          );
          if (!perAddressTokenAllocations[addr][bribe.token]) {
            perAddressTokenAllocations[addr][bribe.token] = BigInt(0);
          }
          perAddressTokenAllocations[addr][bribe.token] += delegatedClaim;
        });
        if (!matchingBribesAggregated[bribe.token]) {
          matchingBribesAggregated[bribe.token] = {
            curveAmount: BigInt(0),
            fxnAmount: BigInt(0),
            bribes: [],
          };
        }
        const delegationShare = computeDelegationShareForGauge(
          votesForGauge,
          gaugeInfo.choiceId
        );
        const delegatedClaimOverall = BigInt(
          Math.floor(Number(bribe.amount) * delegationShare)
        );
        matchingBribesAggregated[bribe.token].fxnAmount +=
          delegatedClaimOverall;
        matchingBribesAggregated[bribe.token].bribes.push({
          ...bribe,
          delegationShare,
          computedFromGauge: gaugeInfo.gauge,
          type: "fxn",
        });
      });
    }

    // ---------------------------------------------------------------------
    // Compute final bounty distributions (aggregate)
    let votiumConvexBounties = await fetchVotiumClaimedBounties(
      blockNumber1,
      Number(latestBlock)
    );

    // Create a mapping of token symbols to addresses concurrently.
    const tokenSymbolPairs = await Promise.all(
      votiumConvexBounties.votiumBounties.map(async (bounty: any) => {
        const symbol = await getTokenSymbol(bounty.rewardToken);
        return symbol ? [symbol, bounty.rewardToken] : null;
      })
    );
    const tokenSymbolToAddress = Object.fromEntries(
      tokenSymbolPairs.filter((pair) => pair !== null)
    );

    // Map token addresses to overall bribes data using token symbols.
    const tokenAddressToBribes: any = {};
    for (const tokenSymbol in matchingBribesAggregated) {
      const matchingAddress = tokenSymbolToAddress[tokenSymbol];
      if (matchingAddress) {
        tokenAddressToBribes[matchingAddress] =
          matchingBribesAggregated[tokenSymbol];
      }
    }

    // Group by protocol with proper amount splitting
    const protocolBounties = {
      curve: [],
      fxn: []
    };

    votiumConvexBounties.votiumBounties.forEach((bounty: any) => {
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
            (bribe: any) => bribe.type === "curve"
          );
          const hasFxnBribes = matching.bribes.some(
            (bribe: any) => bribe.type === "fxn"
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

        // Add to curve bounties if there's a curve share
        if (curveShare > 0) {
          protocolBounties.curve.push({
            ...bounty,
            amount: BigInt(Math.floor(Number(bounty.amount) * curveShare))
          });
        }

        // Add to fxn bounties if there's an fxn share
        if (fxnShare > 0) {
          protocolBounties.fxn.push({
            ...bounty,
            amount: BigInt(Math.floor(Number(bounty.amount) * fxnShare))
          });
        }
      } else {
        throw new Error(
          `Token ${bounty.rewardToken} not found in any bribes. Cannot determine allocation.`
        );
      }
    });

    // ---------------------------------------------------------------------
    // Write output to file.
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    ensureDirExists(weeklyBountiesDir);

    // Use the period from VOTIUM_FORWARDER_REGISTRY + one week (bc distribution is done on thursday) instead of current timestamp
    const periodFolder = path.join(
      weeklyBountiesDir,
      (Number(currentEpoch) + 604800).toString(),
      "votium"
    );
    ensureDirExists(periodFolder);

    // ----------------------
    // File 1: Totals claimed (protocolBounties)
    const totalsFileName = path.join(periodFolder, "claimed_bounties_convex.json");
    fs.writeFileSync(
      totalsFileName,
      JSON.stringify(protocolBounties, customReplacer, 2) // pretty printed
    );
    console.log(`Protocol bounties saved to ${totalsFileName}`);

    // ----------------------
    // File 2: Per-address breakdown (cleaned up)
    // Before writing, clean the per-address data to remove entries that are empty or have only zero values.
    // ----------------------
    function cleanPerAddressOutput(perAddressOutput, tokenSymbolToAddress) {
      const cleaned = {};

      // Clean votes sections: remove addresses with empty vote objects.
      ["curveVotes", "fxnVotes"].forEach((section) => {
        if (perAddressOutput[section]) {
          const newSection = {};
          for (const addr in perAddressOutput[section]) {
            const entry = perAddressOutput[section][addr];
            // Only keep if the object has at least one property.
            if (entry && Object.keys(entry).length > 0) {
              newSection[addr] = entry;
            }
          }
          if (Object.keys(newSection).length > 0) {
            cleaned[section] = newSection;
          }
        }
      });

      // Clean tokenAllocations: for each address, remove tokens with a zero allocation.

      if (perAddressOutput.tokenAllocations) {
        const cleanedAllocations = {};
        for (const addr in perAddressOutput.tokenAllocations) {
          const tokens = perAddressOutput.tokenAllocations[addr];
          const newTokens = {};
          for (const token in tokens) {
            const allocation = tokens[token];
            // Convert allocation to a number and skip if zero.
            if (Number(allocation) === 0) continue;
            // Use token address if available.
            const newTokenKey =
              tokenSymbolToAddress && tokenSymbolToAddress[token]
                ? tokenSymbolToAddress[token]
                : token;
            newTokens[newTokenKey] = allocation;
          }
          // Only include this address if there's at least one token with nonzero allocation.
          if (Object.keys(newTokens).length > 0) {
            cleanedAllocations[addr] = newTokens;
          }
        }
        if (Object.keys(cleanedAllocations).length > 0) {
          cleaned.tokenAllocations = cleanedAllocations;
        }
      }
      return cleaned;
    }

    // --- Usage when writing the per-address breakdown file ---

    const perAddressOutput = {
      curveVotes: curveAddressBreakdown,
      fxnVotes: fxnAddressBreakdown,
      tokenAllocations: perAddressTokenAllocations,
    };

    // Clean the data.
    const cleanedPerAddressOutput = cleanPerAddressOutput(perAddressOutput, tokenSymbolToAddress);

    // Format amounts properly using tokens infos
    const publicClient = clients[mainnet.id];

    let allTokens: string[] = [];

    // Build a list of unique token addresses present in the allocations.
    for (const voter in cleanedPerAddressOutput.tokenAllocations) {
      for (const token in cleanedPerAddressOutput.tokenAllocations[voter]) {
        if (!allTokens.includes(token)) {
          allTokens.push(token);
        }
      }
    }

    // Create an output object for formatted token allocations.
    const formattedOutput = {
      tokenAllocations: {} as Record<string, Record<string, string>>
    };

    // For each voter, format each token amount by multiplying with 10**decimals.
    for (const voter in cleanedPerAddressOutput.tokenAllocations) {
      formattedOutput.tokenAllocations[voter] = {};
      for (const token of allTokens) {
        const rawAmount = cleanedPerAddressOutput.tokenAllocations[voter][token];
        if (rawAmount) {
          const tokenInfo = await getTokenInfo(publicClient, token);
          // Multiply the raw amount by 10**decimals using BigInt arithmetic.
          const multiplier = 10n ** BigInt(tokenInfo.decimals);
          const fullAmount = (rawAmount * multiplier).toString();
          formattedOutput.tokenAllocations[voter][token] = fullAmount;

          cleanedPerAddressOutput.tokenAllocations[voter][token] = fullAmount;
        }
      }
    }

    // Write the cleaned output in compact form.
    const perAddressFileName = path.join(periodFolder, "forwarders_voted_rewards.json");
    fs.writeFileSync(
      perAddressFileName,
      JSON.stringify(cleanedPerAddressOutput, customReplacer)
    );
    console.log(`Cleaned per-address breakdown saved to ${perAddressFileName}`);

    const telegramLogger = new ClaimsTelegramLogger();
    await telegramLogger.logClaims("votium/claimed_bounties_convex.json", Number(currentEpoch) + 604800, votiumConvexBounties);
  } catch (error) {
    console.error("Error generating votium bounties:", error);
    process.exit(1);
  }
}

// Wrap top-level await inside an async IIFE
(async () => {
  try {
    await generateConvexVotiumBounties();
  } catch (error) {
    console.error("Error in generateConvexVotiumBounties:", error);
    process.exit(1);
  }
})();
