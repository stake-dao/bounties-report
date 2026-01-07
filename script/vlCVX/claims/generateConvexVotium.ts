import { fetchVotiumClaimedBounties } from "../../utils/claims/votiumClaims";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  VOTIUM_FORWARDER,
  DELEGATION_ADDRESS,
  getClient,
  VOTIUM_FORWARDER_REGISTRY,
} from "../../utils/constants";
import { getGaugesInfos } from "../../utils/reportUtils";
import {
  getBlockNumberByTimestamp,
  getClosestBlockTimestamp,
} from "../../utils/chainUtils";
import {
  associateGaugesPerId,
  fetchLastProposalsIdsCurrentPeriod,
  getProposal,
  getVoters,
  getVotingPower,
} from "../../utils/snapshot";
import { getAllCurveGauges } from "../../utils/curveApi";
import {
  fetchDelegatorData,
  getForwardedDelegators,
} from "../../utils/delegationHelper";
import { processAllForwarders } from "../../utils/forwarderCacheUtils";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";
import { getTokenAddress as getTokenAddressFromService, getTokenDecimals as getTokenDecimalsFromService } from "../../utils/tokenService";
import { getTokenPrices, TokenIdentifier } from "../../utils/priceUtils";

const THE_UNION_ADDRESS = "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49";

interface Forwarder {
  address: string;
  type: "delegator" | "direct-voter";
  votingPower: number;
  delegatedTo?: string; // Track who they delegated to (e.g., The Union)
  isUnionDelegator?: boolean; // Flag to identify Union delegators
}

interface TokenAllocation {
  [token: string]: {
    amount: string; // Token amount as string to avoid precision issues
    usd: number; // USD value
  };
}

// ========== HELPER FUNCTIONS ==========

/**
 * Get token decimals with fallback to 18
 */
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  return getTokenDecimalsFromService(tokenAddress);
}

/**
 * Wrapper for token address lookup
 */
async function getTokenAddress(symbol: string): Promise<string | undefined> {
  return getTokenAddressFromService(symbol);
}

/**
 * Ensure directory exists
 */
function ensureDirExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Custom JSON replacer for BigInt
 */
function customReplacer(_key: string, value: any): any {
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

/**
 * Get all forwarders by:
 * 1. Loading indexed forwarders from parquet file
 * 2. Checking voters/delegators for forwarding status
 * 3. Merging both sources
 */
async function getAllForwarders(
  space: string,
  proposalId: string,
  blockSnapshotEnd: number,
  currentEpoch: number
): Promise<Forwarder[]> {
  const forwarders: Forwarder[] = [];
  const forwarderAddressSet = new Set<string>();

  // 1. Get ALL voters from the proposal
  const voters = await getVoters(proposalId);
  const proposal = await getProposal(proposalId);

  // Handle delegators who delegated to The Union
  const unionDelegatorsList = [
    { address: "0x5bfF1A68663ff91b0650327D83D4230Cd00023Ad", vp: 19955 },
    { address: "0x8Ac4c0630C5ed1636537924eC9B037fC652ADee8", vp: 214 }
  ];

  const unionDelegatorsMap = new Map<string, number>();
  for (const delegator of unionDelegatorsList) {
    unionDelegatorsMap.set(delegator.address.toLowerCase(), delegator.vp);
    voters.push({ voter: delegator.address, vp: delegator.vp });
  }

  // 2. Get delegation data to identify who are delegators
  const delegatorData = await fetchDelegatorData(space, proposal);
  const delegatorSet = new Set<string>();

  if (delegatorData && delegatorData.delegators.length > 0) {
    for (const delegator of delegatorData.delegators) {
      delegatorSet.add(delegator.toLowerCase());
    }
  }

  // 3. Load indexed forwarders from parquet file
  let indexedForwarders: string[] = [];
  try {
    indexedForwarders = await processAllForwarders(currentEpoch, VOTIUM_FORWARDER, "1");
  } catch (error) {
    console.warn("Could not load indexed forwarders, using on-chain only");
  }

  // 4. Prepare all addresses to check (voters + indexed forwarders)
  const voterAddresses = voters.map((v: any) => v.voter);
  const voterMap = new Map<string, any>();
  for (const v of voters) {
    voterMap.set(v.voter.toLowerCase(), v);
  }

  const additionalAddresses: string[] = [];
  for (const addr of indexedForwarders) {
    if (!voterMap.has(addr.toLowerCase())) {
      additionalAddresses.push(addr);
    }
  }

  const allAddressesToCheck = [...voterAddresses, ...additionalAddresses];

  // 5. Check forwarding status for ALL addresses in batches
  const batchSize = 50;
  const allForwardedStatuses: string[] = [];
  const totalBatches = Math.ceil(allAddressesToCheck.length / batchSize);

  for (let i = 0; i < allAddressesToCheck.length; i += batchSize) {
    const batch = allAddressesToCheck.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    process.stdout.write(`\r  Checking forwarding status... ${batchNum}/${totalBatches}`);

    try {
      const forwardedAddresses = await getForwardedDelegators(batch, blockSnapshotEnd);
      allForwardedStatuses.push(...forwardedAddresses);
    } catch (error) {
      for (const addr of batch) {
        try {
          const result = await getForwardedDelegators([addr], blockSnapshotEnd);
          allForwardedStatuses.push(result[0] || "");
        } catch (e) {
          allForwardedStatuses.push("");
        }
      }
    }
  }
  console.log(""); // New line after progress

  // 6. Get voting power for additional addresses (those not in voters)
  let additionalVotingPowers: Record<string, number> = {};
  if (additionalAddresses.length > 0) {
    try {
      additionalVotingPowers = await getVotingPower(proposal, additionalAddresses, "1");
    } catch (error) {
      // Silent fail - will use 0 VP
    }
  }

  // 7. Process results and identify forwarders
  for (let index = 0; index < allAddressesToCheck.length; index++) {
    const address = allAddressesToCheck[index];
    const forwardedTo = allForwardedStatuses[index]?.toLowerCase();
    const addrLower = address.toLowerCase();

    if (forwarderAddressSet.has(addrLower)) continue;

    if (forwardedTo === VOTIUM_FORWARDER.toLowerCase()) {
      const vote = voterMap.get(addrLower);
      const isDelegator = delegatorSet.has(addrLower);
      const isFromIndex = index >= voterAddresses.length;
      const isDirectVoter = !isDelegator && addrLower !== DELEGATION_ADDRESS.toLowerCase();

      let type: "delegator" | "direct-voter";
      let votingPower = vote ? vote.vp : 0;

      if (isFromIndex && !vote) {
        votingPower = additionalVotingPowers[address] || additionalVotingPowers[addrLower] || 0;
      }

      if (isDelegator) {
        type = "delegator";
        if (delegatorData?.votingPowers) {
          votingPower = delegatorData.votingPowers[address] || delegatorData.votingPowers[addrLower] || votingPower;
        }
      } else if (isDirectVoter) {
        type = "direct-voter";
      } else {
        continue;
      }

      const isUnionDelegator = unionDelegatorsMap.has(addrLower);

      forwarders.push({
        address: addrLower,
        type,
        votingPower: isUnionDelegator ? unionDelegatorsMap.get(addrLower) || votingPower : votingPower,
        delegatedTo: isUnionDelegator ? THE_UNION_ADDRESS : undefined,
        isUnionDelegator,
      });

      forwarderAddressSet.add(addrLower);
    }
  }

  forwarders.sort((a, b) => b.votingPower - a.votingPower);

  return forwarders;
}

/**
 * Compute vote shares for a gauge
 */
function computeVoteSharesForGauge(
  votes: any[],
  gaugeChoiceId: number,
  forwarders: Forwarder[],
  totalChoiceScore: number
): Map<string, number> {
  const shares = new Map<string, number>();
  const forwarderAddresses = new Set(forwarders.map((f) => f.address));
  const forwarderMap = new Map(forwarders.map((f) => [f.address, f]));

  // Create a map of Union delegators for quick lookup
  const unionDelegators = new Map<string, Forwarder>();
  forwarders.forEach((f) => {
    if (f.isUnionDelegator) {
      unionDelegators.set(f.address, f);
    }
  });

  const voterVp = new Map<string, number>();

  // Find The Union's vote for this gauge
  let unionVoteChoice: any = null;
  const unionVote = votes.find(
    (v) => v.voter.toLowerCase() === THE_UNION_ADDRESS.toLowerCase()
  );
  if (unionVote && unionVote.choice && unionVote.choice[gaugeChoiceId] !== undefined) {
    unionVoteChoice = unionVote.choice;
  }

  // Calculate effective VP for each forwarder on this gauge
  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();

      // Skip if not a forwarder AND not The Union
      if (!forwarderAddresses.has(voter) && voter !== THE_UNION_ADDRESS.toLowerCase()) return;

      // Handle Union delegators separately
      if (voter === THE_UNION_ADDRESS.toLowerCase() && unionDelegators.size > 0) {
        unionDelegators.forEach((delegator) => {
          let vpChoiceSum = 0;
          let gaugeChoiceValue = 0;

          Object.keys(unionVoteChoice).forEach((choiceId) => {
            const val = unionVoteChoice[choiceId];
            vpChoiceSum += val;
            if (parseInt(choiceId) === gaugeChoiceId) {
              gaugeChoiceValue = val;
            }
          });

          if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
            const effectiveVp = (delegator.votingPower * gaugeChoiceValue) / vpChoiceSum;
            voterVp.set(delegator.address, (voterVp.get(delegator.address) || 0) + effectiveVp);
          }
        });
        return;
      }

      // Skip Union delegators in regular vote processing
      if (unionDelegators.has(voter)) return;

      // Regular forwarder processing
      if (forwarderAddresses.has(voter)) {
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
          const forwarder = forwarderMap.get(voter);
          const forwarderVotingPower = forwarder ? forwarder.votingPower : vote.vp;
          const effectiveVp = (forwarderVotingPower * gaugeChoiceValue) / vpChoiceSum;
          voterVp.set(voter, (voterVp.get(voter) || 0) + effectiveVp);
        }
      }
    }
  });

  // Calculate shares based on total choice score from Snapshot
  forwarders.forEach((forwarder) => {
    const vp = voterVp.get(forwarder.address) || 0;
    const share = totalChoiceScore > 0 ? vp / totalChoiceScore : 0;
    shares.set(forwarder.address, share);
  });

  return shares;
}

/**
 * Aggregate bribes by token for overall distribution
 */
async function aggregateBribesByToken(
  gaugeBribes: any[],
  matchingBribesAggregated: any,
  delegationShare: number,
  bribesType: "curve" | "fxn"
) {
  for (const bribe of gaugeBribes) {
    // Convert token symbol to address if needed - fallback to symbol if address not found
    const tokenKey = (await getTokenAddress(bribe.token)) || bribe.token;



    if (!matchingBribesAggregated[tokenKey]) {
      matchingBribesAggregated[tokenKey] = {
        curveAmount: BigInt(0),
        fxnAmount: BigInt(0),
        bribes: [],
        symbol: bribe.token, // Keep the original symbol for reference
      };
    }

    // Check if bribe amount is already in wei or needs conversion
    const brideAmountNum = Number(bribe.amount);
    let delegatedClaimOverall: bigint;

    if (brideAmountNum > 1e10) {
      // Looks like wei already
      delegatedClaimOverall = BigInt(
        Math.floor(Number(bribe.amount) * delegationShare)
      );
    } else {
      // Convert bribe amount to wei
      const decimals = await getTokenDecimals(tokenKey);
      delegatedClaimOverall = BigInt(
        Math.floor(Number(bribe.amount) * delegationShare * 10 ** decimals)
      );
    }

    if (bribesType === "curve") {
      matchingBribesAggregated[tokenKey].curveAmount += delegatedClaimOverall;
    } else {
      matchingBribesAggregated[tokenKey].fxnAmount += delegatedClaimOverall;
    }

    matchingBribesAggregated[tokenKey].bribes.push({
      ...bribe,
      delegationShare,
      type: bribesType,
    });
  }
}

/**
 * Compute delegation share for a gauge based on forwarder votes
 */
function computeDelegationShareForGauge(
  votes: any[],
  gaugeChoiceId: number,
  forwarders: Forwarder[]
): number {
  const forwarderAddresses = new Set(forwarders.map((f) => f.address));
  const forwarderMap = new Map(forwarders.map((f) => [f.address, f]));

  // Create a map of Union delegators
  const unionDelegators = new Map<string, Forwarder>();
  forwarders.forEach((f) => {
    if (f.isUnionDelegator) {
      unionDelegators.set(f.address, f);
    }
  });

  let totalEffectiveVp = 0;
  let delegationEffectiveVp = 0;

  // Find The Union's vote
  const unionVote = votes.find(
    (v) => v.voter.toLowerCase() === THE_UNION_ADDRESS.toLowerCase()
  );
  let unionChoice: any = null;
  if (
    unionVote &&
    unionVote.choice &&
    unionVote.choice[gaugeChoiceId] !== undefined
  ) {
    unionChoice = unionVote.choice;
  }

  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();

      // Handle Union vote separately
      if (
        voter === THE_UNION_ADDRESS.toLowerCase() &&
        unionDelegators.size > 0
      ) {
        // Calculate effective VP for Union delegators
        unionDelegators.forEach((delegator) => {
          let vpChoiceSum = 0;
          let gaugeChoiceValue = 0;

          Object.keys(unionChoice).forEach((choiceId) => {
            const val = unionChoice[choiceId];
            vpChoiceSum += val;
            if (parseInt(choiceId) === gaugeChoiceId) {
              gaugeChoiceValue = val;
            }
          });

          if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
            const effectiveVp =
              (delegator.votingPower * gaugeChoiceValue) / vpChoiceSum;
            totalEffectiveVp += effectiveVp;
            delegationEffectiveVp += effectiveVp;
          }
        });
        return; // Don't count The Union's vote itself
      }

      // Skip Union delegators in regular processing
      if (unionDelegators.has(voter)) return;

      // Regular vote processing
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
        // Use actual voting power for forwarders
        let votingPower = vote.vp;
        if (forwarderAddresses.has(voter)) {
          const forwarder = forwarderMap.get(voter);
          if (forwarder) {
            votingPower = forwarder.votingPower;
          }
          delegationEffectiveVp +=
            (votingPower * gaugeChoiceValue) / vpChoiceSum;
        }
        totalEffectiveVp += (votingPower * gaugeChoiceValue) / vpChoiceSum;
      }
    }
  });

  return totalEffectiveVp > 0 ? delegationEffectiveVp / totalEffectiveVp : 0;
}

/**
 * Process gauge votes and distribute bribes
 */
async function processGaugeVotes(
  space: string,
  filter: string,
  gaugeFetcher: () => Promise<any>,
  bribesData: any,
  forwarders: Forwarder[],
  tokenAllocations: Record<string, TokenAllocation>,
  perAddressTokenAllocations: Record<string, Record<string, bigint>>,
  matchingBribesAggregated: any,
  bribesType: "curve" | "fxn",
  transformGauges = false
): Promise<number> {
  // Fetch proposal and votes
  const now = Math.floor(Date.now() / 1000);
  const proposalIdPerSpace = await fetchLastProposalsIdsCurrentPeriod(
    [space],
    now,
    filter
  );
  // For testing: Use the specific proposal IDs that match our test data
  let proposalId = proposalIdPerSpace[space];

  const proposal = await getProposal(proposalId);
  const votes = await getVoters(proposalId);

  // Fetch proposal scores from Snapshot
  const proposalData = await fetchProposalWithScores(proposalId);

  console.log(`\nUsing proposal: ${proposalId} (${votes.length} votes)`);

  // Get gauges
  let gauges = await gaugeFetcher();
  if (transformGauges) {
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  // Map gauges to proposal choices
  const gaugeMapping = associateGaugesPerId(proposal, gauges);
  let processedGauges = 0;

  // Process each gauge
  for (const gaugeAddress in gaugeMapping) {
    const gaugeInfo = gaugeMapping[gaugeAddress];

    // Debug: Log gauge 395
    if (gaugeInfo.choiceId === 395) {
      console.log(`\nProcessing gauge for choice 395: ${gaugeAddress}`);
    }

    // Find matching gauge details
    const gaugeDetails = gauges.find(
      (g: any) =>
        g.gauge.toLowerCase() === gaugeAddress.toLowerCase() ||
        (g.rootGauge &&
          g.rootGauge.toLowerCase() === gaugeAddress.toLowerCase())
    );

    if (!gaugeDetails) {
      // Skip known non-gauge choices silently
      const knownNonGauges = ["vefunder", "vecrv", "other"];
      const isKnownNonGauge = knownNonGauges.some((ng) =>
        gaugeInfo.shortName?.toLowerCase().includes(ng)
      );
      if (!isKnownNonGauge) {
        console.log(
          `Warning: No matching gauge found for choice: ${gaugeInfo.shortName}`
        );
      }
      continue;
    }

    // Get votes for this gauge
    const votesForGauge = votes.filter(
      (vote: any) =>
        vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
    );

    // Also check if we have bribes that match by choice ID (for gauge mismatches)
    const bribesMatchingByChoice =
      bribesData?.epoch?.bribes?.filter(
        (bribe: any) => bribe.choice === gaugeInfo.choiceId - 1
      ) || [];

    if (votesForGauge.length === 0) continue;

    // Get total score for this choice from Snapshot
    const totalChoiceScore = proposalData.scores[gaugeInfo.choiceId - 1] || 0; // Snapshot uses 0-based indexing

    // Compute vote shares for forwarders
    const voteShares = computeVoteSharesForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders,
      totalChoiceScore
    );

    // Get bribes for this gauge - Llama API uses choice index -1 compared to Snapshot
    const gaugeBribes =
      bribesData?.epoch?.bribes?.filter((bribe: any) => {
        const matchByGauge = bribe.gauge.toLowerCase() === gaugeAddress.toLowerCase();
        const matchByChoice = bribe.choice === gaugeInfo.choiceId - 1;
        return matchByGauge || matchByChoice;
      }) || [];

    // Aggregate bribes for overall distribution (matching working version)
    const delegationShare = computeDelegationShareForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders
    );

    aggregateBribesByToken(
      gaugeBribes,
      matchingBribesAggregated,
      delegationShare,
      bribesType
    );

    // Distribute bribes among forwarders for per-address tracking
    for (const bribe of gaugeBribes) {
      const amountInDollars = bribe.amountDollars || 0;

      // Calculate per-address shares for the aggregated claimed bounties
      const addressShares = computeVoteSharesForGauge(
        votesForGauge,
        gaugeInfo.choiceId,
        forwarders,
        totalChoiceScore
      );

      for (const forwarder of forwarders) {
        const share = addressShares.get(forwarder.address) || 0;
        if (share > 0) {
          const allocatedDollars = amountInDollars * share;
          const allocatedAmount = (Number(bribe.amount) * share).toFixed(6);

          if (!tokenAllocations[forwarder.address]) {
            tokenAllocations[forwarder.address] = {};
          }

          // Convert token symbol to address if needed
          const tokenKey = await getTokenAddress(bribe.token) || bribe.token;

          if (!tokenAllocations[forwarder.address][tokenKey]) {
            tokenAllocations[forwarder.address][tokenKey] = {
              amount: "0",
              usd: 0,
            };
          }

          // Add to existing allocation
          const existing = tokenAllocations[forwarder.address][tokenKey];
          tokenAllocations[forwarder.address][tokenKey] = {
            amount: (Number(existing.amount) + Number(allocatedAmount)).toFixed(6),
            usd: existing.usd + allocatedDollars,
          };

          // Also track for per-address token allocations (for claimed bounties)
          const tokenAddress = (await getTokenAddress(bribe.token)) || bribe.token;

          // Check if the bribe amount looks like it's already in wei
          const brideAmountNum = Number(bribe.amount);
          let amountInWei: bigint;

          if (brideAmountNum > 1e10) {
            amountInWei = BigInt(Math.floor(Number(bribe.amount) * share));
          } else {
            const decimals = await getTokenDecimals(tokenAddress);
            amountInWei = BigInt(Math.floor(Number(bribe.amount) * share * 10 ** decimals));
          }

          if (!perAddressTokenAllocations[forwarder.address][tokenAddress]) {
            perAddressTokenAllocations[forwarder.address][tokenAddress] = BigInt(0);
          }
          perAddressTokenAllocations[forwarder.address][tokenAddress] += amountInWei;
        }
      }
    }

    if (gaugeBribes.length > 0) {
      processedGauges++;
    }
  }

  return processedGauges;
}

/**
 * Clean per-address output to remove empty entries
 */
function cleanPerAddressOutput(perAddressOutput: any) {
  const cleaned: any = {};

  // Clean votes sections: remove addresses with empty vote objects
  ["curveVotes", "fxnVotes"].forEach((section) => {
    if (perAddressOutput[section]) {
      const newSection: any = {};
      for (const addr in perAddressOutput[section]) {
        const entry = perAddressOutput[section][addr];
        // Only keep if the object has at least one property
        if (entry && Object.keys(entry).length > 0) {
          newSection[addr] = entry;
        }
      }
      if (Object.keys(newSection).length > 0) {
        cleaned[section] = newSection;
      }
    }
  });

  // Clean tokenAllocations: for each address, remove tokens with a zero allocation
  if (perAddressOutput.tokenAllocations) {
    const cleanedAllocations: any = {};
    for (const addr in perAddressOutput.tokenAllocations) {
      const tokens = perAddressOutput.tokenAllocations[addr];
      const newTokens: any = {};
      for (const token in tokens) {
        const allocation = tokens[token];
        // Convert allocation to a number and skip if zero
        if (Number(allocation) === 0) continue;
        // Token should already be an address, but keep as is
        const newTokenKey = token;
        newTokens[newTokenKey] = allocation;
      }
      // Only include this address if there's at least one token with nonzero allocation
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

/**
 * Process votes with address breakdown
 */
async function fetchProposalVotesWithAddressBreakdown(
  space: string,
  filter: string,
  gaugeFetcher: () => Promise<any>,
  forwarders: Forwarder[],
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
  const forwarderAddresses = new Set(forwarders.map((f) => f.address));

  // Build per-address vote breakdown using the forwarders list
  const addressBreakdown: Record<string, any[]> = {};
  forwarders.forEach((forwarder) => {
    addressBreakdown[forwarder.address] = [];
  });

  // Create a map to track Union delegators (those who delegated to The Union)
  const unionDelegators = new Map<string, Forwarder>();

  // Use the isUnionDelegator flag to identify Union delegators
  for (const forwarder of forwarders) {
    if (forwarder.isUnionDelegator) {
      unionDelegators.set(forwarder.address.toLowerCase(), forwarder);
    }
  }



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

          // Check if this is The Union's vote
          if (voter === THE_UNION_ADDRESS.toLowerCase()) {
            // Distribute The Union's votes to delegators who delegated to them
            for (const [delegatorAddress] of unionDelegators) {
              if (forwarderAddresses.has(delegatorAddress)) {
                // Add the vote to the delegator's breakdown
                addressBreakdown[delegatorAddress].push({
                  proposalId,
                  gauge: gaugeMappingWithInfos[gaugeKey].gauge,
                  choiceId: gaugeMappingWithInfos[gaugeKey].choiceId,
                  weight: vote.choice[choiceId],
                  viaUnion: true, // Mark that this came via The Union
                });
              }
            }
          } else if (forwarderAddresses.has(voter)) {
            // Regular forwarder vote
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

/**
 * Fetch proposal data with scores from Snapshot GraphQL API
 */
async function fetchProposalWithScores(
  proposalId: string
): Promise<{ choices: string[]; scores: number[] }> {
  const query = `
    query Proposal {
      proposal(id: "${proposalId}") {
        choices,
        scores
      }
    }
  `;

  try {
    const response = await fetch("https://hub.snapshot.org/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return {
      choices: data.data.proposal.choices,
      scores: data.data.proposal.scores,
    };
  } catch (error) {
    console.error("Error fetching proposal from Snapshot:", error);
    throw error;
  }
}

/**
 * Fetch bribes from Llama Airforce with timeout handling
 */
async function fetchBribes(chain: string) {
  try {
    // Add timeout to fetch requests
    const fetchWithTimeout = async (url: string, timeout = 30000) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    };

    const roundsUrl = `https://api.llama.airforce/bribes/votium/${chain}/rounds`;
    const roundsResponse = await fetchWithTimeout(roundsUrl);
    const roundsData = await roundsResponse.json();

    const lastRoundNumber = roundsData.rounds
      ? Math.max(...roundsData.rounds) // Use the last completed round # TODO: Fetch correctly , if round is current
      : null;

    if (!lastRoundNumber) {
      console.warn(`No rounds found for ${chain}`);
      return null;
    }

    console.log(`Fetching bribes for ${chain} round ${lastRoundNumber}`);

    const bribesUrl = `https://api.llama.airforce/bribes/votium/${chain}/${lastRoundNumber}`;
    const bribesResponse = await fetchWithTimeout(bribesUrl);
    const bribesData = await bribesResponse.json();

    return bribesData;
  } catch (error) {
    console.error(`Error fetching bribes for ${chain}:`, error);
    return null;
  }
}

/**
 * Fetch and process claimed bounties from the blockchain
 * This replicates the logic from the working version
 */
async function fetchAndProcessClaimedBounties(
  blockStart: number,
  blockEnd: number,
  matchingBribesAggregated: any
): Promise<{ votiumConvexBounties: any; protocolBounties: any }> {
  const votiumConvexBounties = await fetchVotiumClaimedBounties(
    blockStart,
    Number(blockEnd)
  );

  if (
    !votiumConvexBounties.votiumBounties ||
    votiumConvexBounties.votiumBounties.length === 0
  ) {
    console.warn("No claimed Votium bounties found");
    return {
      votiumConvexBounties,
      protocolBounties: { curve: {}, fxn: {} },
    };
  }

  // Map token addresses to overall bribes data
  const tokenAddressToBribes = matchingBribesAggregated;

  // Group by protocol with proper amount splitting
  const protocolBountiesArrays = {
    curve: [] as any[],
    fxn: [] as any[],
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
        protocolBountiesArrays.curve.push({
          ...bounty,
          amount: BigInt(Math.floor(Number(bounty.amount) * curveShare)),
        });
      }

      // Add to fxn bounties if there's an fxn share
      if (fxnShare > 0) {
        protocolBountiesArrays.fxn.push({
          ...bounty,
          amount: BigInt(Math.floor(Number(bounty.amount) * fxnShare)),
        });
      }
    }
  });

  // Convert arrays to objects with numbered keys (matching the working version format)
  const protocolBounties = {
    curve: {} as any,
    fxn: {} as any,
  };

  protocolBountiesArrays.curve.forEach((bounty, index) => {
    protocolBounties.curve[index.toString()] = bounty;
  });

  protocolBountiesArrays.fxn.forEach((bounty, index) => {
    protocolBounties.fxn[index.toString()] = bounty;
  });

  return { votiumConvexBounties, protocolBounties };
}

/**
 * Main function to generate Convex Votium bounties
 */
export async function generateConvexVotiumBounties(): Promise<void> {
  try {
    console.log("\nGenerating Convex Votium Bounties...");

    // Initialize client
    const ethereumClient = (await getClient(1)) as any;

    // Get current epoch
    const epochAbi = [
      {
        name: "currentEpoch",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const;

    let currentEpoch = await ethereumClient.readContract({
      address: VOTIUM_FORWARDER_REGISTRY as `0x${string}`,
      abi: epochAbi,
      functionName: "currentEpoch",
    });

    const now = Math.floor(Date.now() / 1000);
    /*
    // If we are on an even week, take the prev round epoch
    if (!isOddWeek(now)) {
      console.log("using prev round epoch");
      currentEpoch = currentEpoch - BigInt(2 * WEEK)
    }
    */

    console.log(`Epoch: ${currentEpoch} (${new Date(Number(currentEpoch) * 1000).toLocaleDateString('en-GB')})`);

    // Get Curve proposal for reference
    const curveProposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"
    );
    const curveProposalId = curveProposalIds[CVX_SPACE];
    const curveProposal = await getProposal(curveProposalId);

    // Get block for snapshot
    let blockSnapshotEnd: number;
    try {
      const proposalSnapshotBlock = parseInt(curveProposal.snapshot);
      if (!isNaN(proposalSnapshotBlock) && proposalSnapshotBlock > 0) {
        blockSnapshotEnd = proposalSnapshotBlock;
      } else {
        blockSnapshotEnd = await getBlockNumberByTimestamp(curveProposal.end, "after", 1);
      }
    } catch (error) {
      const latestBlock = await ethereumClient.getBlockNumber();
      blockSnapshotEnd = Number(latestBlock) - 50400;
    }

    // Get all forwarders (delegators + direct voters)
    console.log("Fetching forwarders...");
    const forwarders = await getAllForwarders(
      CVX_SPACE,
      curveProposalId,
      blockSnapshotEnd,
      Number(currentEpoch)
    );

    if (forwarders.length === 0) {
      console.warn("No forwarders found!");
      return;
    }

    // Initialize tracking structures
    const tokenAllocations: Record<string, TokenAllocation> = {};
    const perAddressTokenAllocations: Record<
      string,
      Record<string, bigint>
    > = {};
    const matchingBribesAggregated: any = {};

    forwarders.forEach((f) => {
      tokenAllocations[f.address] = {};
      perAddressTokenAllocations[f.address] = {};
    });

    // Process Curve votes and bribes
    console.log("Processing Curve gauges...");
    const curveBribes = await fetchBribes("cvx-crv");

    // Process Curve votes to get address breakdown
    const votesCurveResult = await fetchProposalVotesWithAddressBreakdown(
      CVX_SPACE,
      "^(?!FXN ).*Gauge Weight for Week of",
      getAllCurveGauges,
      forwarders,
      false
    );
    const curveAddressBreakdown = votesCurveResult
      ? votesCurveResult.addressBreakdown
      : {};

    const curveGaugesProcessed = await processGaugeVotes(
      CVX_SPACE,
      "^(?!FXN ).*Gauge Weight for Week of",
      getAllCurveGauges,
      curveBribes,
      forwarders,
      tokenAllocations,
      perAddressTokenAllocations,
      matchingBribesAggregated,
      "curve",
      false
    );

    // Process FXN votes and bribes
    console.log("Processing FXN gauges...");
    const fxnBribes = await fetchBribes("cvx-fxn");
    let fxnGaugesProcessed = 0;
    let fxnAddressBreakdown: any = {};

    try {
      // Process FXN votes to get address breakdown
      const votesFxnResult = await fetchProposalVotesWithAddressBreakdown(
        CVX_SPACE,
        "^FXN.*Gauge Weight for Week of",
        () => getGaugesInfos("fxn"),
        forwarders,
        true
      );
      fxnAddressBreakdown = votesFxnResult
        ? votesFxnResult.addressBreakdown
        : {};

      fxnGaugesProcessed = await processGaugeVotes(
        CVX_SPACE,
        "^FXN.*Gauge Weight for Week of",
        () => getGaugesInfos("fxn"),
        fxnBribes,
        forwarders,
        tokenAllocations,
        perAddressTokenAllocations,
        matchingBribesAggregated,
        "fxn",
        true
      );
    } catch (error) {
      console.error("Error processing FXN gauges:", error);
    }

    // Store original tokenAllocations for USD values
    const originalTokenAllocations = JSON.parse(JSON.stringify(tokenAllocations));

    // Use the period from VOTIUM_FORWARDER_REGISTRY + one week (bc distribution is done on thursday) instead of current timestamp
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    ensureDirExists(weeklyBountiesDir);

    const periodFolder = path.join(
      weeklyBountiesDir,
      (Number(currentEpoch) + 604800).toString(),
      "votium"
    );
    ensureDirExists(periodFolder);
    const outputDir = periodFolder;

    // Initialize variables outside try block so they're accessible in summary
    let claimedTokenAmounts: Record<string, bigint> = {};
    let tokenPrices: Record<string, number> = {};

    // Fetch and save claimed bounties
    try {
      // Get block range for claimed bounties
      const blockNumber1 = await getClosestBlockTimestamp(
        "ethereum",
        Number(currentEpoch)
      );
      const latestBlock = await ethereumClient.getBlockNumber();

      // Fetch and process claimed bounties using the aggregated bribes
      const { votiumConvexBounties, protocolBounties } =
        await fetchAndProcessClaimedBounties(
          blockNumber1,
          Number(latestBlock),
          matchingBribesAggregated
        );

      // Save claimed bounties
      const claimedBountiesPath = path.join(
        outputDir,
        "claimed_bounties_convex.json"
      );
      fs.writeFileSync(
        claimedBountiesPath,
        JSON.stringify(protocolBounties, customReplacer, 2)
      );

      // Process all votium bounties to get actual claimed amounts
      for (const bounty of votiumConvexBounties.votiumBounties) {
        const token = bounty.rewardToken;
        if (!claimedTokenAmounts[token]) {
          claimedTokenAmounts[token] = 0n;
        }
        claimedTokenAmounts[token] += BigInt(bounty.amount);
      }

      // Remove any tokens from allocations that weren't actually claimed
      const tokensToRemove: string[] = [];
      for (const voter in perAddressTokenAllocations) {
        for (const token in perAddressTokenAllocations[voter]) {
          if (!claimedTokenAmounts[token]) {
            tokensToRemove.push(token);
          }
        }
      }

      const uniqueTokensToRemove = [...new Set(tokensToRemove)];

      for (const token of uniqueTokensToRemove) {
        for (const voter in perAddressTokenAllocations) {
          if (perAddressTokenAllocations[voter][token]) {
            delete perAddressTokenAllocations[voter][token];
          }
        }
        for (const voter in tokenAllocations) {
          if (tokenAllocations[voter][token]) {
            delete tokenAllocations[voter][token];
          }
        }
      }

      // Calculate total theoretical amounts per token (only for claimed tokens)
      const theoreticalTotals: Record<string, bigint> = {};
      for (const voter in perAddressTokenAllocations) {
        for (const token in perAddressTokenAllocations[voter]) {
          if (!theoreticalTotals[token]) {
            theoreticalTotals[token] = 0n;
          }
          theoreticalTotals[token] += perAddressTokenAllocations[voter][token];
        }
      }

      // Calculate total USD value per user
      const userTotalUsd: Record<string, number> = {};
      let grandTotalUsd = 0;

      for (const voter in originalTokenAllocations) {
        userTotalUsd[voter] = 0;
        for (const token in originalTokenAllocations[voter]) {
          if (claimedTokenAmounts[token]) {
            userTotalUsd[voter] += originalTokenAllocations[voter][token].usd;
          }
        }
        grandTotalUsd += userTotalUsd[voter];
      }

      // Get token prices for claimed tokens
      tokenPrices = {};
      const tokenIdentifiers: TokenIdentifier[] = [];

      for (const token of Object.keys(claimedTokenAmounts)) {
        tokenIdentifiers.push({ chainId: 1, address: token.toLowerCase() });
      }

      try {
        const prices = await getTokenPrices(tokenIdentifiers);
        for (const [key, price] of Object.entries(prices)) {
          const address = key.split(':')[1];
          tokenPrices[address] = price;
        }
      } catch (error) {
        console.error("Error fetching token prices:", error);
      }

      // Calculate token amounts based on USD values
      for (const token in claimedTokenAmounts) {
        const tokenPrice = tokenPrices[token.toLowerCase()];
        const actualTotal = claimedTokenAmounts[token];

        if (!tokenPrice || tokenPrice === 0) {
          // Fallback to proportional distribution if no price
          const theoreticalTotal = theoreticalTotals[token] || 0n;
          if (theoreticalTotal > 0n) {
            for (const voter in perAddressTokenAllocations) {
              if (perAddressTokenAllocations[voter][token]) {
                const theoreticalAmount = perAddressTokenAllocations[voter][token];
                const adjustedAmount = (theoreticalAmount * actualTotal) / theoreticalTotal;
                perAddressTokenAllocations[voter][token] = adjustedAmount;
              }
            }
          }
          continue;
        }

        // Calculate total USD value that should be distributed for this token
        let tokenUsdTotal = 0;
        for (const voter in originalTokenAllocations) {
          if (originalTokenAllocations[voter][token]) {
            tokenUsdTotal += originalTokenAllocations[voter][token].usd;
          }
        }

        // Calculate total token amount needed based on USD value
        const decimals = await getTokenDecimals(token);
        const totalTokensNeeded = BigInt(Math.floor((tokenUsdTotal / tokenPrice) * (10 ** decimals)));

        // Distribute tokens based on each user's USD share
        const tokensToDistribute = totalTokensNeeded > actualTotal ? actualTotal : totalTokensNeeded;
        let distributedAmount = 0n;

        // Sort voters deterministically for consistent distribution
        const votersWithAllocation = Object.keys(perAddressTokenAllocations)
          .filter(voter => originalTokenAllocations[voter] && originalTokenAllocations[voter][token])
          .sort();

        // Process all voters except the last one
        for (let i = 0; i < votersWithAllocation.length - 1; i++) {
          const voter = votersWithAllocation[i];
          const userUsdForToken = originalTokenAllocations[voter][token].usd;
          const userShare = tokenUsdTotal > 0 ? userUsdForToken / tokenUsdTotal : 0;
          const userTokenAmount = BigInt(Math.floor(Number(tokensToDistribute) * userShare));

          perAddressTokenAllocations[voter][token] = userTokenAmount;
          distributedAmount += userTokenAmount;

          if (tokenAllocations[voter] && tokenAllocations[voter][token]) {
            tokenAllocations[voter][token] = {
              amount: (Number(userTokenAmount) / (10 ** decimals)).toFixed(6),
              usd: originalTokenAllocations[voter][token].usd,
            };
          }
        }

        // Give the last voter exactly the remaining amount (with safety checks)
        if (votersWithAllocation.length > 0) {
          const lastVoter = votersWithAllocation[votersWithAllocation.length - 1];
          const remainingAmount = tokensToDistribute - distributedAmount;
          
          // Safety check: remaining amount should be small (just rounding dust)
          const lastVoterExpectedAmount = originalTokenAllocations[lastVoter][token] 
            ? BigInt(Math.floor(Number(tokensToDistribute) * (originalTokenAllocations[lastVoter][token].usd / tokenUsdTotal)))
            : 0n;
          
          const dustThreshold = lastVoterExpectedAmount / 1000n; // 0.1% tolerance
          const dustAmount = remainingAmount > lastVoterExpectedAmount 
            ? remainingAmount - lastVoterExpectedAmount 
            : lastVoterExpectedAmount - remainingAmount;
          
          if (dustAmount > dustThreshold && dustThreshold > 0n) {
            throw new Error(`Token distribution error: Remaining amount too large for ${token}`);
          }
          
          perAddressTokenAllocations[lastVoter][token] = remainingAmount;
          distributedAmount += remainingAmount;

          if (tokenAllocations[lastVoter] && tokenAllocations[lastVoter][token]) {
            tokenAllocations[lastVoter][token] = {
              amount: (Number(remainingAmount) / (10 ** decimals)).toFixed(6),
              usd: originalTokenAllocations[lastVoter][token].usd,
            };
          }
        }
      }

      // Add Telegram logger
      const telegramLogger = new ClaimsTelegramLogger();
      await telegramLogger.logClaims(
        "votium/claimed_bounties_convex.json",
        Number(currentEpoch) + 604800,
        votiumConvexBounties
      );
    } catch (error) {
      console.error("Error fetching claimed bounties:", error);
      console.warn("Continuing without claimed bounties file...");
    }

    // Recalculate total allocations after adjustments to only include claimed tokens
    const totalAllocations: TokenAllocation = {};
    Object.values(tokenAllocations).forEach((userTokens) => {
      Object.entries(userTokens).forEach(([token, allocation]) => {
        if (!totalAllocations[token]) {
          totalAllocations[token] = {
            amount: "0",
            usd: 0,
          };
        }
        totalAllocations[token] = {
          amount: (
            Number(totalAllocations[token].amount) + Number(allocation.amount)
          ).toFixed(6),
          usd: totalAllocations[token].usd + allocation.usd,
        };
      });
    });

    // Format per-address allocations
    let allTokens: string[] = [];

    // Build a list of unique token addresses from per-address allocations
    for (const voter in perAddressTokenAllocations) {
      for (const token in perAddressTokenAllocations[voter]) {
        if (!allTokens.includes(token)) {
          allTokens.push(token);
        }
      }
    }

    // Format amounts properly using token info
    const formattedPerAddressAllocations: Record<
      string,
      Record<string, string>
    > = {};
    for (const voter in perAddressTokenAllocations) {
      formattedPerAddressAllocations[voter] = {};
      for (const token of allTokens) {
        const rawAmount = perAddressTokenAllocations[voter][token];
        if (rawAmount && rawAmount > 0n) {
          // The amounts in perAddressTokenAllocations are already adjusted to match claimed amounts
          // They are already in the smallest unit (e.g., wei for 18 decimal tokens)
          // So we can use them directly for the merkle tree
          formattedPerAddressAllocations[voter][token] = rawAmount.toString();
        }
      }
    }

    // Prepare per-address output with both formats
    // For the merkle tree, we need wei amounts (from formattedPerAddressAllocations)
    // But we also want to keep the USD values for the combined merkle script
    const tokenAllocationsWithWei: Record<string, Record<string, { amount: string; amountWei: string; usd: number }>> = {};

    for (const voter in tokenAllocations) {
      tokenAllocationsWithWei[voter] = {};
      for (const token in tokenAllocations[voter]) {
        if (formattedPerAddressAllocations[voter] && formattedPerAddressAllocations[voter][token]) {
          tokenAllocationsWithWei[voter][token] = {
            amount: tokenAllocations[voter][token].amount, // Human readable with decimals
            amountWei: formattedPerAddressAllocations[voter][token], // Wei amount as string
            usd: tokenAllocations[voter][token].usd
          };
        }
      }
    }

    const perAddressOutput = {
      curveVotes: curveAddressBreakdown,
      fxnVotes: fxnAddressBreakdown,
      tokenAllocations: tokenAllocationsWithWei,
    };

    // Clean the per-address data
    const cleanedPerAddressOutput = cleanPerAddressOutput(perAddressOutput);

    // Save the cleaned per-address data
    const perAddressPath = path.join(
      outputDir,
      "forwarders_voted_rewards.json"
    );

    fs.writeFileSync(
      perAddressPath,
      JSON.stringify(cleanedPerAddressOutput, customReplacer)
    );

    // Calculate distribution efficiency
    let totalClaimedUsd = 0;
    let totalDistributedUsd = 0;

    for (const [token, claimedAmount] of Object.entries(claimedTokenAmounts)) {
      const decimals = await getTokenDecimals(token);
      const distributedWei = Object.values(perAddressTokenAllocations).reduce(
        (sum, userAllocs) => sum + (userAllocs[token] || 0n),
        0n
      );
      const tokenPrice = tokenPrices?.[token.toLowerCase()] || 0;

      if (tokenPrice > 0) {
        totalClaimedUsd += (Number(claimedAmount) / (10 ** decimals)) * tokenPrice;
        totalDistributedUsd += (Number(distributedWei) / (10 ** decimals)) * tokenPrice;
      }
    }

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    
    const delegatorCount = forwarders.filter((f) => f.type === "delegator").length;
    const directVoterCount = forwarders.filter((f) => f.type === "direct-voter").length;
    
    console.log(`Forwarders: ${forwarders.length} (${delegatorCount} delegators, ${directVoterCount} direct voters)`);
    console.log(`Claimed tokens: ${Object.keys(claimedTokenAmounts).length}`);
    console.log(`Total claimed: $${totalClaimedUsd.toFixed(2)}`);
    console.log(`Total distributed: $${totalDistributedUsd.toFixed(2)}`);
    console.log(`Efficiency: ${(totalDistributedUsd * 100 / totalClaimedUsd).toFixed(2)}%`);
    console.log(`Output: ${perAddressPath}`);
    console.log("=".repeat(60));

  } catch (error) {
    console.error("Error generating Convex Votium bounties:", error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  generateConvexVotiumBounties()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}