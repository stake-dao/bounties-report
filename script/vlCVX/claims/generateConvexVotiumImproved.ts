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
import { getGaugesInfos } from "../../utils/reportUtils";
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
  [token: string]: bigint;
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
  forwarders: Forwarder[]
): Map<string, number> {
  const shares = new Map<string, number>();
  const forwarderAddresses = new Set(forwarders.map(f => f.address));
  
  let totalEffectiveVp = 0;
  const voterVp = new Map<string, number>();
  
  // Debug for choice 395
  if (gaugeChoiceId === 395) {
    console.log(`\n  Computing vote shares for choice ${gaugeChoiceId}:`);
    console.log(`  Forwarder addresses: ${Array.from(forwarderAddresses).join(', ')}`);
    console.log(`  Total votes to check: ${votes.length}`);
  }
  
  // Calculate effective VP for each voter on this gauge
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
        const effectiveVp = (vote.vp * gaugeChoiceValue) / vpChoiceSum;
        totalEffectiveVp += effectiveVp;
        voterVp.set(voter, (voterVp.get(voter) || 0) + effectiveVp);
      }
    }
  });
  
  // Calculate shares
  forwarders.forEach(forwarder => {
    const vp = voterVp.get(forwarder.address) || 0;
    const share = totalEffectiveVp > 0 ? vp / totalEffectiveVp : 0;
    shares.set(forwarder.address, share);
    
    // Debug log if forwarder has votes for this gauge
    if (vp > 0) {
      console.log(`    Forwarder ${forwarder.address} has ${vp.toFixed(2)} VP (${(share * 100).toFixed(2)}%) for gauge choice ${gaugeChoiceId}`);
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
    
    // Compute vote shares for forwarders
    const voteShares = computeVoteSharesForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders
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
      console.log(`  Distributing bribe: ${bribe.amount} ${bribe.token} from ${bribe.pool}`);
      
      forwarders.forEach(forwarder => {
        const share = voteShares.get(forwarder.address) || 0;
        if (share > 0) {
          // Use amountDollars for proper computation
          const amountInDollars = bribe.amountDollars || 0;
          const allocatedDollars = amountInDollars * share;
          
          // For now, store by token symbol since we don't have addresses
          // The amount appears to be in human-readable format already
          const allocatedAmount = Math.floor(Number(bribe.amount) * share);
          
          console.log(`    Allocating to ${forwarder.address}: ${(share * 100).toFixed(2)}% of ${bribe.amount} ${bribe.token} ($${amountInDollars.toFixed(2)}) = ${allocatedAmount} ${bribe.token} ($${allocatedDollars.toFixed(2)})`);
          
          if (!tokenAllocations[forwarder.address]) {
            tokenAllocations[forwarder.address] = {};
          }
          
          // Use token symbol as key for now
          const tokenKey = bribe.token;
          
          if (!tokenAllocations[forwarder.address][tokenKey]) {
            tokenAllocations[forwarder.address][tokenKey] = BigInt(0);
          }
          
          tokenAllocations[forwarder.address][tokenKey] += BigInt(allocatedAmount);
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
      Object.entries(userTokens).forEach(([token, amount]) => {
        if (!totalAllocations[token]) {
          totalAllocations[token] = BigInt(0);
        }
        totalAllocations[token] += amount;
      });
    });
    
    // Token symbols are already in the keys (from Llama API)
    console.log("\n💰 Token allocations complete");
    const tokenSymbols: Record<string, string> = {};
    for (const token of Object.keys(totalAllocations)) {
      // Token is already the symbol from Llama API
      tokenSymbols[token] = token;
    }
    
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
      JSON.stringify(output, customReplacer, 2)
    );
    
    console.log(`\n✅ Results saved to: ${outputPath}`);
    
    // Print summary
    console.log("\n" + "=".repeat(80));
    console.log("SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total forwarders: ${forwarders.length}`);
    console.log(`- Delegator forwarders: ${forwarders.filter(f => f.type === "delegator").length}`);
    console.log(`- Direct voter forwarders: ${forwarders.filter(f => f.type === "direct-voter").length}`);
    console.log(`\nTokens distributed: ${Object.keys(totalAllocations).length}`);
    
    // Show top allocations
    console.log("\nTop token allocations:");
    const sortedTokens = Object.entries(totalAllocations)
      .sort(([, a], [, b]) => Number(b - a))
      .slice(0, 5);
      
    sortedTokens.forEach(([token, amount]) => {
      // Token is already the symbol
      console.log(`  ${token}: ${amount.toString()}`);
    });
    
    // Show forwarders with most tokens
    console.log("\nTop forwarders by token count:");
    const forwarderTokenCounts = Object.entries(tokenAllocations)
      .map(([address, tokens]) => ({
        address,
        tokenCount: Object.keys(tokens).length,
        type: forwarders.find(f => f.address === address)?.type || "unknown",
      }))
      .sort((a, b) => b.tokenCount - a.tokenCount)
      .slice(0, 5);
      
    forwarderTokenCounts.forEach(({ address, tokenCount, type }) => {
      console.log(`  ${address} (${type}): ${tokenCount} tokens`);
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