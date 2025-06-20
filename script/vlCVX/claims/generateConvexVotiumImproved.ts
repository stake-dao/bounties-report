import { fetchVotiumClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  VOTIUM_FORWARDER_REGISTRY,
  VOTIUM_FORWARDER,
  DELEGATION_ADDRESS,
  getOptimizedClient,
} from "../../utils/constants";
import { getGaugesInfos, ensureDirExists, getTokenSymbol } from "../../utils/reportUtils";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
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

interface Forwarder {
  address: string;
  type: "delegator" | "direct-voter";
  votingPower: number;
}

interface TokenAllocation {
  [token: string]: {
    amount: string;  // Token amount as string to avoid precision issues
    usd: number;     // USD value
  };
}

interface ForwarderRewards {
  forwarders: Forwarder[];
  tokenAllocations: Record<string, TokenAllocation>;
  totalAllocations: TokenAllocation;
  metadata: {
    proposalId: string;
    timestamp: number;
    curveGauges: number;
    fxnGauges: number;
  };
}

// ERC20 ABI for symbol lookup
const erc20Abi = [
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// Helper: Get token symbol
async function getTokenSymbol(tokenAddress: string, client: any): Promise<string> {
  try {
    const symbol = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: "symbol",
    });
    return symbol;
  } catch (error) {
    console.error(`Error fetching symbol for ${tokenAddress}:`, error);
    return "UNKNOWN";
  }
}

// Helper: Ensure directory exists
function ensureDirExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Helper: Custom JSON replacer for BigInt
function customReplacer(key: string, value: any): any {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

/**
 * Get all forwarders by checking contract directly for ALL voters
 */
async function getAllForwarders(
  space: string,
  proposalId: string,
  blockSnapshotEnd: number
): Promise<Forwarder[]> {
  const forwarders: Forwarder[] = [];
  
  // 1. Get ALL voters from the proposal
  console.log("Fetching all voters from proposal...");
  const voters = await getVoters(proposalId);
  const proposal = await getProposal(proposalId);
  
  console.log(`Total voters in proposal: ${voters.length}`);
  
  // 2. Get delegation data to identify who are delegators
  const delegatorData = await fetchDelegatorData(space, proposal);
  const delegatorSet = new Set<string>();
  
  if (delegatorData && delegatorData.delegators.length > 0) {
    delegatorData.delegators.forEach((delegator: string) => {
      delegatorSet.add(delegator.toLowerCase());
    });
  }
  
  // 3. Prepare all voter addresses to check
  const voterAddresses = voters.map((v: any) => v.voter);
  const voterMap = new Map<string, any>();
  voters.forEach((v: any) => {
    voterMap.set(v.voter.toLowerCase(), v);
  });
  
  console.log(`\nChecking forwarding status on-chain for ${voterAddresses.length} voters...`);
  
  // 4. Check forwarding status for ALL voters in batches
  const batchSize = 50; // Smaller batches to avoid timeouts
  const allForwardedStatuses: string[] = [];
  
  for (let i = 0; i < voterAddresses.length; i += batchSize) {
    const batch = voterAddresses.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(voterAddresses.length / batchSize);
    
    console.log(`Processing batch ${batchNum}/${totalBatches} (${batch.length} addresses)...`);
    
    try {
      const forwardedAddresses = await getForwardedDelegators(batch, blockSnapshotEnd);
      allForwardedStatuses.push(...forwardedAddresses);
    } catch (error) {
      console.error(`Error processing batch ${batchNum}:`, error);
      // If batch fails, try one by one
      console.log(`Retrying batch ${batchNum} one by one...`);
      for (const addr of batch) {
        try {
          const result = await getForwardedDelegators([addr], blockSnapshotEnd);
          allForwardedStatuses.push(result[0] || "");
        } catch (e) {
          console.error(`Failed to check ${addr}:`, e);
          allForwardedStatuses.push("");
        }
      }
    }
  }
  
  // 5. Process results and identify forwarders
  voterAddresses.forEach((voterAddress: string, index: number) => {
    const forwardedTo = allForwardedStatuses[index]?.toLowerCase();
    const voterLower = voterAddress.toLowerCase();
    
    // Check if they forward to Votium
    if (forwardedTo === VOTIUM_FORWARDER.toLowerCase()) {
      const vote = voterMap.get(voterLower);
      const isDelegator = delegatorSet.has(voterLower);
      const isDirectVoter = !isDelegator && voterLower !== DELEGATION_ADDRESS.toLowerCase();
      
      // Determine type
      let type: "delegator" | "direct-voter";
      let votingPower = vote ? vote.vp : 0;
      
      if (isDelegator) {
        type = "delegator";
        // For delegators, check delegation VP with multiple possible keys
        if (delegatorData && delegatorData.votingPowers) {
          // Try original case first, then lowercase
          votingPower = delegatorData.votingPowers[voterAddress] || 
                       delegatorData.votingPowers[voterLower] ||
                       votingPower;
        }
      } else if (isDirectVoter) {
        type = "direct-voter";
        // Direct voters use their vote VP
      } else {
        // Skip delegation address itself
        return;
      }
      
      // Debug log
      console.log(`Found forwarder: ${voterAddress} (${type}) - VP from vote: ${vote?.vp}, final VP: ${votingPower}`);
      
      forwarders.push({
        address: voterLower,
        type,
        votingPower,
      });
    }
  });
  
  // Sort by voting power
  forwarders.sort((a, b) => b.votingPower - a.votingPower);
  
  console.log(`\n✅ Found ${forwarders.length} forwarders:`);
  console.log(`   - Delegator forwarders: ${forwarders.filter(f => f.type === "delegator").length}`);
  console.log(`   - Direct voter forwarders: ${forwarders.filter(f => f.type === "direct-voter").length}`);
  
  // Log all forwarders with details
  console.log("\nAll forwarders:");
  forwarders.forEach((f, idx) => {
    console.log(`${idx + 1}. ${f.address} (${f.type}) - VP: ${f.votingPower.toLocaleString()}`);
  });
  
  // Highlight direct voter forwarders
  const directVoterForwarders = forwarders.filter(f => f.type === "direct-voter");
  if (directVoterForwarders.length > 0) {
    console.log("\n🎯 Direct voter forwarders (non-delegators who forward):");
    directVoterForwarders.forEach(f => {
      console.log(`   - ${f.address} (VP: ${f.votingPower.toLocaleString()})`);
    });
  }

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
  const forwarderAddresses = new Set(forwarders.map(f => f.address));
  const forwarderMap = new Map(forwarders.map(f => [f.address, f]));
  
  const voterVp = new Map<string, number>();
  
  // Debug for choice 395
  if (gaugeChoiceId === 395) {
    console.log(`\n  Computing vote shares for choice ${gaugeChoiceId}:`);
    console.log(`  Forwarder addresses: ${Array.from(forwarderAddresses).join(', ')}`);
    console.log(`  Total choice score from Snapshot: ${totalChoiceScore}`);
    console.log(`  Total votes to check: ${votes.length}`);
  }
  
  // Calculate effective VP for each forwarder on this gauge
  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();
      
      // Debug for choice 395
      if (gaugeChoiceId === 395) {
        console.log(`  Vote from ${voter} for choice ${gaugeChoiceId}: ${vote.choice[gaugeChoiceId]}%`);
        console.log(`    Is forwarder? ${forwarderAddresses.has(voter)}`);
      }
      
      // Skip if not a forwarder
      if (!forwarderAddresses.has(voter)) return;
      
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
        // Use the forwarder's actual voting power instead of vote.vp
        const forwarder = forwarderMap.get(voter);
        const forwarderVotingPower = forwarder ? forwarder.votingPower : vote.vp;
        
        const effectiveVp = (forwarderVotingPower * gaugeChoiceValue) / vpChoiceSum;
        voterVp.set(voter, (voterVp.get(voter) || 0) + effectiveVp);
        
        // Debug for choice 395
        if (gaugeChoiceId === 395) {
          console.log(`    Using forwarder VP: ${forwarderVotingPower} (vs vote VP: ${vote.vp})`);
          console.log(`    Effective VP for this choice: ${effectiveVp.toFixed(2)}`);
        }
      }
    }
  });
  
  // Calculate shares based on total choice score from Snapshot
  forwarders.forEach(forwarder => {
    const vp = voterVp.get(forwarder.address) || 0;
    const share = totalChoiceScore > 0 ? vp / totalChoiceScore : 0;
    shares.set(forwarder.address, share);
    
    // Debug log if forwarder has votes for this gauge
    if (vp > 0) {
      console.log(`    Forwarder ${forwarder.address} has ${vp.toFixed(2)} effective VP (${(share * 100).toFixed(2)}%) for gauge choice ${gaugeChoiceId} (total: ${totalChoiceScore})`);
    }
  });
  
  return shares;
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
  
  // Override for testing to use proposals with forwarder votes
  console.log(`Filter: "${filter}"`);
  if (filter.startsWith("^FXN")) {
    // Use the FXN proposal as-is
    proposalId = proposalIdPerSpace[space];
    console.log("Using FXN proposal");
  } else {
    // Use the Curve proposal that has our forwarder's votes
    proposalId = "0x662c82169a3e7c0ff0baeb3ceb20f9d76115b2cd2d9b138cee48d8f8f80812b0";
    console.log("Using hardcoded Curve proposal for testing");
  }
  
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
        (g.rootGauge && g.rootGauge.toLowerCase() === gaugeAddress.toLowerCase())
    );
    
    if (!gaugeDetails) {
      // Skip known non-gauge choices silently
      const knownNonGauges = ["vefunder", "vecrv", "other"];
      const isKnownNonGauge = knownNonGauges.some(ng => 
        gaugeInfo.shortName?.toLowerCase().includes(ng)
      );
      if (!isKnownNonGauge) {
        console.log(`Warning: No matching gauge found for choice: ${gaugeInfo.shortName}`);
      }
      continue;
    }
    
    // Get votes for this gauge
    const votesForGauge = votes.filter(
      (vote: any) =>
        vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
    );
    
    // Also check if we have bribes that match by choice ID (for gauge mismatches)
    const bribesMatchingByChoice = bribesData?.epoch?.bribes?.filter(
      (bribe: any) => bribe.choice === (gaugeInfo.choiceId - 1)
    ) || [];
    
    if (bribesMatchingByChoice.length > 0 && votesForGauge.length > 0) {
      // We have votes for this choice and bribes that match by choice
      // This handles gauge address mismatches between our data and Llama
      console.log(`\nFound ${bribesMatchingByChoice.length} bribes matching choice ${gaugeInfo.choiceId} with ${votesForGauge.length} votes`);
    }
    
    if (votesForGauge.length === 0) continue;
    
    // Debug: Check if our forwarders voted for this gauge
    const forwarderVotes = votesForGauge.filter(v => 
      forwarders.some(f => f.address === v.voter.toLowerCase())
    );
    if (forwarderVotes.length > 0) {
      console.log(`\nDEBUG: Gauge ${gaugeAddress} (choice ${gaugeInfo.choiceId}) has ${forwarderVotes.length} forwarder votes`);
      if (gaugeInfo.choiceId === 395 || gaugeAddress.toLowerCase() === '0xaf01d68714e7ea67f43f08b5947e367126b889b1') {
        console.log('  This is the gauge we are tracking!');
        forwarderVotes.forEach(v => {
          console.log(`  ${v.voter}: choice ${JSON.stringify(v.choice)}`);
        });
      }
    }
    
    // Get total score for this choice from Snapshot
    const totalChoiceScore = proposalData.scores[gaugeInfo.choiceId - 1] || 0; // Snapshot uses 0-based indexing
    
    // Compute vote shares for forwarders
    const voteShares = computeVoteSharesForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders,
      totalChoiceScore
    );
    
    // Debug: Check vote shares for this gauge
    if (voteShares.size > 0 && gaugeInfo.choiceId === 395) {
      console.log(`  Vote shares for gauge ${gaugeAddress}:`);
      voteShares.forEach((share, address) => {
        console.log(`    ${address}: ${(share * 100).toFixed(2)}%`);
      });
    }
    
    // Get bribes for this gauge - Llama API uses choice index -1 compared to Snapshot
    const gaugeBribes = bribesData?.epoch?.bribes?.filter(
      (bribe: any) => {
        // Primary match by gauge address
        const matchByGauge = bribe.gauge.toLowerCase() === gaugeAddress.toLowerCase();
        
        // Secondary match by choice ID (Llama uses -1 offset)
        const matchByChoice = bribe.choice === (gaugeInfo.choiceId - 1);
        
        if (!matchByGauge && matchByChoice) {
          console.log(`Note: Bribe for ${bribe.pool} matches by choice ${bribe.choice} (Snapshot ${gaugeInfo.choiceId})`);
          console.log(`  Llama gauge: ${bribe.gauge}, Our gauge: ${gaugeAddress}`);
          // Accept the match by choice even if gauge addresses don't match
          // This handles cases where Llama API has different gauge addresses
          return true;
        }
        
        return matchByGauge;
      }
    ) || [];
    
    // Debug: Log gauge and bribes info
    if (gaugeBribes.length > 0) {
      console.log(`\nGauge ${gaugeAddress} (choice ${gaugeInfo.choiceId}) has ${gaugeBribes.length} bribes`);
    }
    
    // Distribute bribes among forwarders
    gaugeBribes.forEach((bribe: any) => {
      const amountInDollars = bribe.amountDollars || 0;
      console.log(`  Distributing bribe: $${amountInDollars.toFixed(2)} (${bribe.amount} ${bribe.token}) from ${bribe.pool}`);
      
      forwarders.forEach(forwarder => {
        const share = voteShares.get(forwarder.address) || 0;
        if (share > 0) {
          const allocatedDollars = amountInDollars * share;
          const allocatedAmount = (Number(bribe.amount) * share).toFixed(6);
          
          console.log(`    Allocating to ${forwarder.address}: ${(share * 100).toFixed(2)}% = $${allocatedDollars.toFixed(2)} (${allocatedAmount} ${bribe.token})`);
          
          if (!tokenAllocations[forwarder.address]) {
            tokenAllocations[forwarder.address] = {};
          }
          
          // Use token symbol as the key
          const tokenKey = bribe.token;
          
          if (!tokenAllocations[forwarder.address][tokenKey]) {
            tokenAllocations[forwarder.address][tokenKey] = {
              amount: "0",
              usd: 0
            };
          }
          
          // Add to existing allocation
          const existing = tokenAllocations[forwarder.address][tokenKey];
          tokenAllocations[forwarder.address][tokenKey] = {
            amount: (Number(existing.amount) + Number(allocatedAmount)).toFixed(6),
            usd: existing.usd + allocatedDollars
          };
        }
      });
    });
    
    if (gaugeBribes.length > 0) {
      processedGauges++;
    }
  }
  
  return processedGauges;
}

/**
 * Fetch proposal data with scores from Snapshot GraphQL API
 */
async function fetchProposalWithScores(proposalId: string): Promise<{ choices: string[], scores: number[] }> {
  const query = `
    query Proposal {
      proposal(id: "${proposalId}") {
        choices,
        scores
      }
    }
  `;

  try {
    const response = await fetch('https://hub.snapshot.org/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return {
      choices: data.data.proposal.choices,
      scores: data.data.proposal.scores
    };
  } catch (error) {
    console.error('Error fetching proposal from Snapshot:', error);
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
      ? Math.max(...roundsData.rounds) - 1 // Use the last completed round
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
 * Fetch claimed Votium bounties and split them between curve and fxn
 */
async function fetchAndSplitClaimedBounties(
  blockStart: number,
  blockEnd: number,
  curveBribes: any,
  fxnBribes: any
): Promise<{ curve: any[], fxn: any[] }> {
  console.log("\n📋 Fetching actual claimed Votium bounties...");
  
  const votiumConvexBounties = await fetchVotiumClaimedBounties(blockStart, blockEnd);
  
  if (!votiumConvexBounties.votiumBounties || votiumConvexBounties.votiumBounties.length === 0) {
    console.warn("No claimed Votium bounties found");
    return { curve: [], fxn: [] };
  }
  
  console.log(`Found ${votiumConvexBounties.votiumBounties.length} claimed bounties`);
  
  // Create a mapping of token symbols to addresses
  const tokenSymbolPairs = await Promise.all(
    votiumConvexBounties.votiumBounties.map(async (bounty: any) => {
      const symbol = await getTokenSymbol(bounty.rewardToken);
      return symbol ? [symbol, bounty.rewardToken] : null;
    })
  );
  const tokenSymbolToAddress = Object.fromEntries(
    tokenSymbolPairs.filter(pair => pair !== null)
  );
  
  // Aggregate bribes by token symbol and type
  const allBribes = [...(curveBribes?.bribes || []), ...(fxnBribes?.bribes || [])];
  const bribesAggregated: Record<string, { curveAmount: number, fxnAmount: number, bribes: any[] }> = {};
  
  allBribes.forEach((bribe: any) => {
    const tokenSymbol = bribe.token;
    if (!bribesAggregated[tokenSymbol]) {
      bribesAggregated[tokenSymbol] = {
        curveAmount: 0,
        fxnAmount: 0,
        bribes: []
      };
    }
    
    const amountDollars = bribe.amountDollars || 0;
    if (curveBribes?.bribes?.includes(bribe)) {
      bribesAggregated[tokenSymbol].curveAmount += amountDollars;
    } else if (fxnBribes?.bribes?.includes(bribe)) {
      bribesAggregated[tokenSymbol].fxnAmount += amountDollars;
    }
    
    bribesAggregated[tokenSymbol].bribes.push({
      ...bribe,
      type: curveBribes?.bribes?.includes(bribe) ? "curve" : "fxn"
    });
  });
  
  // Map token addresses to aggregated bribe data
  const tokenAddressToBribes: Record<string, any> = {};
  Object.entries(bribesAggregated).forEach(([tokenSymbol, aggregated]) => {
    const matchingAddress = tokenSymbolToAddress[tokenSymbol];
    if (matchingAddress) {
      tokenAddressToBribes[matchingAddress] = aggregated;
    }
  });
  
  // Split claimed bounties between curve and fxn
  const protocolBounties = {
    curve: [] as any[],
    fxn: [] as any[]
  };
  
  votiumConvexBounties.votiumBounties.forEach((bounty: any) => {
    const matching = tokenAddressToBribes[bounty.rewardToken];
    let curveShare = 0;
    let fxnShare = 0;
    
    if (matching) {
      const curveAmount = matching.curveAmount;
      const fxnAmount = matching.fxnAmount;
      const total = curveAmount + fxnAmount;
      
      if (total > 0) {
        curveShare = curveAmount / total;
        fxnShare = fxnAmount / total;
      } else {
        // Fallback: check if there are bribes for each protocol
        const hasCurveBribes = matching.bribes.some((bribe: any) => bribe.type === "curve");
        const hasFxnBribes = matching.bribes.some((bribe: any) => bribe.type === "fxn");
        
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
      console.warn(`Token ${bounty.rewardToken} not found in bribe data. Assigning equally to curve and fxn.`);
      // If no matching bribe data, split equally
      protocolBounties.curve.push({
        ...bounty,
        amount: BigInt(Math.floor(Number(bounty.amount) * 0.5))
      });
      protocolBounties.fxn.push({
        ...bounty,
        amount: BigInt(Math.floor(Number(bounty.amount) * 0.5))
      });
    }
  });
  
  console.log(`Split bounties: ${protocolBounties.curve.length} curve, ${protocolBounties.fxn.length} fxn`);
  return protocolBounties;
}

/**
 * Main function to generate Convex Votium bounties
 */
export async function generateConvexVotiumBountiesImproved(): Promise<void> {
  try {
    console.log("=".repeat(80));
    console.log("Generating Convex Votium Bounties (Improved)");
    console.log("=".repeat(80));
    
    // Initialize client
    const ethereumClient = (await getOptimizedClient(1) || createPublicClient({
      chain: mainnet,
      transport: http(),
    })) as any;
    
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
    
    const currentEpoch = 1749686400
    
    /*await ethereumClient.readContract({
      address: VOTIUM_FORWARDER_REGISTRY as `0x${string}`,
      abi: epochAbi,
      functionName: "currentEpoch",
    });
    */
    
    console.log(`Current Votium epoch: ${currentEpoch}`);
    
    // Get Curve proposal for reference
    const now = Math.floor(Date.now() / 1000);
    const curveProposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"
    );
    const curveProposalId = "0x662c82169a3e7c0ff0baeb3ceb20f9d76115b2cd2d9b138cee48d8f8f80812b0";//curveProposalIds[CVX_SPACE];
    const curveProposal = await getProposal(curveProposalId);

    console.log(`Curve proposal ID: ${curveProposalId}`);
    
    // Get block for snapshot - use proposal snapshot block if available
    let blockSnapshotEnd: number;
    try {
      // First try to get from proposal snapshot
      const proposalSnapshotBlock = parseInt(curveProposal.snapshot);
      if (!isNaN(proposalSnapshotBlock) && proposalSnapshotBlock > 0) {
        console.log(`Using proposal snapshot block: ${proposalSnapshotBlock}`);
        blockSnapshotEnd = proposalSnapshotBlock;
      } else {
        // Fallback to timestamp-based lookup
        blockSnapshotEnd = await getBlockNumberByTimestamp(
          curveProposal.end,
          "after",
          1
        );
      }
    } catch (error) {
      console.error("Error getting snapshot block:", error);
      // Use a reasonable fallback - current block minus ~1 week of blocks
      const latestBlock = await ethereumClient.getBlockNumber();
      blockSnapshotEnd = Number(latestBlock) - 50400; // ~1 week at 12s/block
      console.warn(`Using fallback block: ${blockSnapshotEnd}`);
    }
    
    // Get all forwarders (delegators + direct voters)
    console.log("\n📋 Fetching forwarders...");
    const forwarders = await getAllForwarders(
      CVX_SPACE,
      curveProposalId,
      blockSnapshotEnd
    );
    
    if (forwarders.length === 0) {
      console.warn("No forwarders found!");
      return;
    }
    
    // Initialize token allocations
    const tokenAllocations: Record<string, TokenAllocation> = {};
    forwarders.forEach(f => {
      tokenAllocations[f.address] = {};
    });
    
    // Process Curve votes and bribes
    console.log("\n🔷 Processing Curve gauge votes...");
    const curveBribes = await fetchBribes("cvx-crv");
    const curveGaugesProcessed = await processGaugeVotes(
      CVX_SPACE,
      "^(?!FXN ).*Gauge Weight for Week of",
      getAllCurveGauges,
      curveBribes,
      forwarders,
      tokenAllocations,
      false
    );
    console.log(`Processed ${curveGaugesProcessed} Curve gauges with bribes`);
    
    // Process FXN votes and bribes
    console.log("\n🔶 Processing FXN gauge votes...");
    const fxnBribes = await fetchBribes("cvx-fxn");
    let fxnGaugesProcessed = 0;
    
    try {
      fxnGaugesProcessed = await processGaugeVotes(
        CVX_SPACE,
        "^FXN.*Gauge Weight for Week of",
        () => getGaugesInfos("fxn"),
        fxnBribes,
        forwarders,
        tokenAllocations,
        true
      );
      console.log(`Processed ${fxnGaugesProcessed} FXN gauges with bribes`);
    } catch (error) {
      console.error("Error processing FXN gauges:", error);
      console.log("Continuing without FXN gauge processing...");
    }
    
    // Calculate total allocations
    const totalAllocations: TokenAllocation = {};
    Object.values(tokenAllocations).forEach(userTokens => {
      Object.entries(userTokens).forEach(([token, allocation]) => {
        if (!totalAllocations[token]) {
          totalAllocations[token] = {
            amount: "0",
            usd: 0
          };
        }
        totalAllocations[token] = {
          amount: (Number(totalAllocations[token].amount) + Number(allocation.amount)).toFixed(6),
          usd: totalAllocations[token].usd + allocation.usd
        };
      });
    });
    
    // All amounts are now in USD
    console.log("\n💰 Token allocations complete (amounts in USD)");
    
    // Prepare output
    const output: ForwarderRewards = {
      forwarders,
      tokenAllocations,
      totalAllocations,
      metadata: {
        proposalId: curveProposalId,
        timestamp: Number(currentEpoch),
        curveGauges: curveGaugesProcessed,
        fxnGauges: fxnGaugesProcessed,
      },
    };
    
    // Save results
    const outputDir = path.join(
      "weekly-bounties",
      currentEpoch.toString(),
      "votium"
    );
    ensureDirExists(outputDir);
    
    const outputPath = path.join(outputDir, "forwarders_voted_rewards.json");
    fs.writeFileSync(
      outputPath,
      JSON.stringify(output, null, 2)
    );
    
    console.log(`\n✅ Results saved to: ${outputPath}`);
    
    // Fetch and save claimed bounties
    try {
      // Get block range for the current period
      const blockStart = await getBlockNumberByTimestamp(
        curveProposal.start,
        "after",
        1
      );
      
      const protocolBounties = await fetchAndSplitClaimedBounties(
        blockStart,
        blockSnapshotEnd,
        curveBribes,
        fxnBribes
      );
      
      // Save claimed bounties
      const claimedBountiesPath = path.join(outputDir, "claimed_bounties_convex.json");
      fs.writeFileSync(
        claimedBountiesPath,
        JSON.stringify(protocolBounties, customReplacer, 2)
      );
      
      console.log(`\n📋 Claimed bounties saved to: ${claimedBountiesPath}`);
      console.log(`   - Curve bounties: ${protocolBounties.curve.length}`);
      console.log(`   - FXN bounties: ${protocolBounties.fxn.length}`);
    } catch (error) {
      console.error("Error fetching claimed bounties:", error);
      console.warn("Continuing without claimed bounties file...");
    }
    
    // Print summary
    console.log("\n" + "=".repeat(80));
    console.log("SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total forwarders: ${forwarders.length}`);
    console.log(`- Delegator forwarders: ${forwarders.filter(f => f.type === "delegator").length}`);
    console.log(`- Direct voter forwarders: ${forwarders.filter(f => f.type === "direct-voter").length}`);
    // Calculate total USD value across all tokens
    const totalUsd = Object.values(totalAllocations).reduce((sum, allocation) => sum + allocation.usd, 0);
    console.log(`\nTotal allocated: $${totalUsd.toFixed(2)}`);
    
    // Show top token allocations
    console.log("\nTop token allocations:");
    const sortedTokens = Object.entries(totalAllocations)
      .sort(([, a], [, b]) => b.usd - a.usd)
      .slice(0, 5);
      
    sortedTokens.forEach(([token, allocation]) => {
      console.log(`  ${token}: ${allocation.amount} ($${allocation.usd.toFixed(2)})`);
    });
    
    // Show top forwarder allocations
    console.log("\nForwarder allocations:");
    const sortedForwarders = Object.entries(tokenAllocations)
      .map(([address, tokens]) => ({
        address,
        totalUsd: Object.values(tokens).reduce((sum, allocation) => sum + allocation.usd, 0),
        type: forwarders.find(f => f.address === address)?.type || "unknown",
      }))
      .sort((a, b) => b.totalUsd - a.totalUsd);
      
    sortedForwarders.forEach(({ address, totalUsd, type }) => {
      console.log(`  ${address} (${type}): $${totalUsd.toFixed(2)}`);
    });
    
  } catch (error) {
    console.error("Error generating Convex Votium bounties:", error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  generateConvexVotiumBountiesImproved()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}