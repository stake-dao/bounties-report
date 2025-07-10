import { fetchVotiumClaimedBounties } from "../../utils/claimedBountiesUtils";
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
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import {
  getBlockNumberByTimestamp,
  getClosestBlockTimestamp,
} from "../../utils/chainUtils";
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
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";
import { getTokenAddress } from "../../utils/tokenMappings";
import { getTokenPrices, TokenIdentifier } from "../../utils/priceUtils";

// The Union's address (from comment in constants.ts)
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

// Common token decimals mapping
const TOKEN_DECIMALS: Record<string, number> = {
  // Stablecoins
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": 18, // DAI
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": 6, // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7": 6, // USDT

  // Major tokens
  "0xD533a949740bb3306d119CC777fa900bA034cd52": 18, // CRV
  "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B": 18, // CVX
  "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0": 18, // FXS
  "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09": 18, // FXN
  "0xdBdb4d16EdA451D0503b854CF79D55697F90c8DF": 18, // ALCX
  "0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68": 18, // INV
  "0xb794Ad95317f75c44090f64955954C3849315fFe": 18, // RSUP
  "0x5DE8ab7E27f6E7A1fFf3E5B337584Aa43961BEeF": 18, // SDEX

  // Add more as needed
};

/**
 * Get token decimals with fallback to 18
 */
function getTokenDecimals(tokenAddress: string): number {
  return TOKEN_DECIMALS[tokenAddress] || 18;
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

  // Handle delegators who delegated to The Union
  // These are addresses that delegated to The Union, who then forwards to us
  const unionDelegatorsList = [
    {
      address: "0x2dbeDd2632D831E61eB3fCc6720f072eeF9d522D",
      vp: 71266.07740464392, // Their voting power
    },
    // Add more Union delegators here as needed
  ];

  // Create a map for easy lookup
  const unionDelegatorsMap = new Map<string, number>();
  unionDelegatorsList.forEach((delegator) => {
    unionDelegatorsMap.set(delegator.address.toLowerCase(), delegator.vp);
  });

  // Add Union delegators to voters list so they're included in forwarders
  unionDelegatorsList.forEach((delegator) => {
    voters.push({
      voter: delegator.address,
      vp: delegator.vp,
    });
  });

  console.log(
    `Added ${unionDelegatorsList.length} Union delegators, total voters: ${voters.length}`
  );

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

  console.log(
    `\nChecking forwarding status on-chain for ${voterAddresses.length} voters...`
  );

  // 4. Check forwarding status for ALL voters in batches
  const batchSize = 50; // Smaller batches to avoid timeouts
  const allForwardedStatuses: string[] = [];

  for (let i = 0; i < voterAddresses.length; i += batchSize) {
    const batch = voterAddresses.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(voterAddresses.length / batchSize);

    console.log(
      `Processing batch ${batchNum}/${totalBatches} (${batch.length} addresses)...`
    );

    try {
      const forwardedAddresses = await getForwardedDelegators(
        batch,
        blockSnapshotEnd
      );
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
      const isDirectVoter =
        !isDelegator && voterLower !== DELEGATION_ADDRESS.toLowerCase();

      // Determine type
      let type: "delegator" | "direct-voter";
      let votingPower = vote ? vote.vp : 0;

      if (isDelegator) {
        type = "delegator";
        // For delegators, check delegation VP with multiple possible keys
        if (delegatorData && delegatorData.votingPowers) {
          // Try original case first, then lowercase
          votingPower =
            delegatorData.votingPowers[voterAddress] ||
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
      console.log(
        `Found forwarder: ${voterAddress} (${type}) - VP from vote: ${vote?.vp}, final VP: ${votingPower}`
      );

      // Check if this is a Union delegator
      const isUnionDelegator = unionDelegatorsMap.has(voterLower);

      forwarders.push({
        address: voterLower,
        type,
        votingPower: isUnionDelegator
          ? unionDelegatorsMap.get(voterLower) || votingPower
          : votingPower,
        delegatedTo: isUnionDelegator ? THE_UNION_ADDRESS : undefined,
        isUnionDelegator,
      });
    }
  });

  // Sort by voting power
  forwarders.sort((a, b) => b.votingPower - a.votingPower);

  console.log(`\n✅ Found ${forwarders.length} forwarders:`);
  console.log(
    `   - Delegator forwarders: ${
      forwarders.filter((f) => f.type === "delegator").length
    }`
  );
  console.log(
    `   - Direct voter forwarders: ${
      forwarders.filter((f) => f.type === "direct-voter").length
    }`
  );

  // Log all forwarders with details
  console.log("\nAll forwarders:");
  forwarders.forEach((f, idx) => {
    console.log(
      `${idx + 1}. ${f.address} (${
        f.type
      }) - VP: ${f.votingPower.toLocaleString()}`
    );
  });

  // Highlight direct voter forwarders
  const directVoterForwarders = forwarders.filter(
    (f) => f.type === "direct-voter"
  );
  if (directVoterForwarders.length > 0) {
    console.log("\n🎯 Direct voter forwarders (non-delegators who forward):");
    directVoterForwarders.forEach((f) => {
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

  // Debug for choice 395
  if (gaugeChoiceId === 395) {
    console.log(`\n  Computing vote shares for choice ${gaugeChoiceId}:`);
    console.log(
      `  Forwarder addresses: ${Array.from(forwarderAddresses).join(", ")}`
    );
    console.log(
      `  Union delegators: ${Array.from(unionDelegators.keys()).join(", ")}`
    );
    console.log(`  Total choice score from Snapshot: ${totalChoiceScore}`);
    console.log(`  Total votes to check: ${votes.length}`);
  }

  // First, find The Union's vote for this gauge
  let unionVoteChoice: any = null;
  const unionVote = votes.find(
    (v) => v.voter.toLowerCase() === THE_UNION_ADDRESS.toLowerCase()
  );
  if (
    unionVote &&
    unionVote.choice &&
    unionVote.choice[gaugeChoiceId] !== undefined
  ) {
    unionVoteChoice = unionVote.choice;
    if (gaugeChoiceId === 395) {
      console.log(
        `  Found Union vote for choice ${gaugeChoiceId}: ${unionVote.choice[gaugeChoiceId]}%`
      );
    }
  }

  // Calculate effective VP for each forwarder on this gauge
  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();

      // Debug for choice 395
      if (gaugeChoiceId === 395) {
        console.log(
          `  Vote from ${voter} for choice ${gaugeChoiceId}: ${vote.choice[gaugeChoiceId]}%`
        );
        console.log(`    Is forwarder? ${forwarderAddresses.has(voter)}`);
      }

      // Skip if not a forwarder AND not The Union
      if (
        !forwarderAddresses.has(voter) &&
        voter !== THE_UNION_ADDRESS.toLowerCase()
      )
        return;

      // Handle Union delegators separately
      if (
        voter === THE_UNION_ADDRESS.toLowerCase() &&
        unionDelegators.size > 0
      ) {
        // Process Union delegators using Union's choices but their own VP
        unionDelegators.forEach((delegator) => {
          let vpChoiceSum = 0;
          let gaugeChoiceValue = 0;

          // Use Union's choices
          Object.keys(unionVoteChoice).forEach((choiceId) => {
            const val = unionVoteChoice[choiceId];
            vpChoiceSum += val;
            if (parseInt(choiceId) === gaugeChoiceId) {
              gaugeChoiceValue = val;
            }
          });

          if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
            // Use delegator's voting power
            const effectiveVp =
              (delegator.votingPower * gaugeChoiceValue) / vpChoiceSum;
            voterVp.set(
              delegator.address,
              (voterVp.get(delegator.address) || 0) + effectiveVp
            );

            if (gaugeChoiceId === 395) {
              console.log(
                `    Union delegator ${delegator.address} using Union's choice with VP: ${delegator.votingPower}`
              );
              console.log(
                `    Effective VP for this choice: ${effectiveVp.toFixed(2)}`
              );
            }
          }
        });
        return; // Don't process The Union's vote as a regular forwarder
      }

      // Skip Union delegators in regular vote processing (they're handled above)
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
          // Use the forwarder's actual voting power instead of vote.vp
          const forwarder = forwarderMap.get(voter);
          const forwarderVotingPower = forwarder
            ? forwarder.votingPower
            : vote.vp;

          const effectiveVp =
            (forwarderVotingPower * gaugeChoiceValue) / vpChoiceSum;
          voterVp.set(voter, (voterVp.get(voter) || 0) + effectiveVp);

          // Debug for choice 395
          if (gaugeChoiceId === 395) {
            console.log(
              `    Using forwarder VP: ${forwarderVotingPower} (vs vote VP: ${vote.vp})`
            );
            console.log(
              `    Effective VP for this choice: ${effectiveVp.toFixed(2)}`
            );
          }
        }
      }
    }
  });

  // Calculate shares based on total choice score from Snapshot
  forwarders.forEach((forwarder) => {
    const vp = voterVp.get(forwarder.address) || 0;
    const share = totalChoiceScore > 0 ? vp / totalChoiceScore : 0;
    shares.set(forwarder.address, share);

    // Debug log if forwarder has votes for this gauge
    if (vp > 0) {
      console.log(
        `    Forwarder ${forwarder.address} has ${vp.toFixed(
          2
        )} effective VP (${(share * 100).toFixed(
          2
        )}%) for gauge choice ${gaugeChoiceId} (total: ${totalChoiceScore})`
      );
    }
  });

  return shares;
}

/**
 * Aggregate bribes by token for overall distribution
 */
function aggregateBribesByToken(
  gaugeBribes: any[],
  matchingBribesAggregated: any,
  delegationShare: number,
  bribesType: "curve" | "fxn"
) {
  gaugeBribes.forEach((bribe: any) => {
    // Convert token symbol to address if needed
    const tokenKey = getTokenAddress(bribe.token) || bribe.token;

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
      const decimals = getTokenDecimals(tokenKey);
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
  });
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

    if (bribesMatchingByChoice.length > 0 && votesForGauge.length > 0) {
      // We have votes for this choice and bribes that match by choice
      // This handles gauge address mismatches between our data and Llama
      console.log(
        `\nFound ${bribesMatchingByChoice.length} bribes matching choice ${gaugeInfo.choiceId} with ${votesForGauge.length} votes`
      );
    }

    if (votesForGauge.length === 0) continue;

    // Debug: Check if our forwarders voted for this gauge
    const forwarderVotes = votesForGauge.filter((v) =>
      forwarders.some((f) => f.address === v.voter.toLowerCase())
    );
    if (forwarderVotes.length > 0) {
      console.log(
        `\nDEBUG: Gauge ${gaugeAddress} (choice ${gaugeInfo.choiceId}) has ${forwarderVotes.length} forwarder votes`
      );
      if (
        gaugeInfo.choiceId === 395 ||
        gaugeAddress.toLowerCase() ===
          "0xaf01d68714e7ea67f43f08b5947e367126b889b1"
      ) {
        console.log("  This is the gauge we are tracking!");
        forwarderVotes.forEach((v) => {
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
    const gaugeBribes =
      bribesData?.epoch?.bribes?.filter((bribe: any) => {
        // Primary match by gauge address
        const matchByGauge =
          bribe.gauge.toLowerCase() === gaugeAddress.toLowerCase();

        // Secondary match by choice ID (Llama uses -1 offset)
        const matchByChoice = bribe.choice === gaugeInfo.choiceId - 1;

        if (!matchByGauge && matchByChoice) {
          console.log(
            `Note: Bribe for ${bribe.pool} matches by choice ${bribe.choice} (Snapshot ${gaugeInfo.choiceId})`
          );
          console.log(
            `  Llama gauge: ${bribe.gauge}, Our gauge: ${gaugeAddress}`
          );
          // Accept the match by choice even if gauge addresses don't match
          // This handles cases where Llama API has different gauge addresses
          return true;
        }

        return matchByGauge;
      }) || [];

    // Debug: Log gauge and bribes info
    if (gaugeBribes.length > 0) {
      console.log(
        `\nGauge ${gaugeAddress} (choice ${gaugeInfo.choiceId}) has ${gaugeBribes.length} bribes`
      );
    }

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
    gaugeBribes.forEach((bribe: any) => {
      const amountInDollars = bribe.amountDollars || 0;
      console.log(
        `  Distributing bribe: $${amountInDollars.toFixed(2)} (${
          bribe.amount
        } ${bribe.token}) from ${bribe.pool}`
      );

      // Debug: Check if amount looks like wei or human-readable
      const amountNum = Number(bribe.amount);
      if (amountNum > 1e10) {
        console.log(
          `    WARNING: Bribe amount ${bribe.amount} looks like it might already be in wei!`
        );
      }
      // Calculate per-address shares for the aggregated claimed bounties
      const addressShares = computeVoteSharesForGauge(
        votesForGauge,
        gaugeInfo.choiceId,
        forwarders,
        totalChoiceScore
      );

      forwarders.forEach((forwarder) => {
        const share = addressShares.get(forwarder.address) || 0;
        if (share > 0) {
          const allocatedDollars = amountInDollars * share;
          const allocatedAmount = (Number(bribe.amount) * share).toFixed(6);

          console.log(
            `    Allocating to ${forwarder.address}: ${(share * 100).toFixed(
              2
            )}% = $${allocatedDollars.toFixed(2)} (${allocatedAmount} ${
              bribe.token
            })`
          );

          if (!tokenAllocations[forwarder.address]) {
            tokenAllocations[forwarder.address] = {};
          }

          // Convert token symbol to address if needed
          const tokenKey = getTokenAddress(bribe.token) || bribe.token;

          if (!tokenAllocations[forwarder.address][tokenKey]) {
            tokenAllocations[forwarder.address][tokenKey] = {
              amount: "0",
              usd: 0,
            };
          }

          // Add to existing allocation
          const existing = tokenAllocations[forwarder.address][tokenKey];
          tokenAllocations[forwarder.address][tokenKey] = {
            amount: (Number(existing.amount) + Number(allocatedAmount)).toFixed(
              6
            ),
            usd: existing.usd + allocatedDollars,
          };

          // Also track for per-address token allocations (for claimed bounties)
          const tokenAddress = getTokenAddress(bribe.token) || bribe.token;

          // Check if the bribe amount looks like it's already in wei
          const brideAmountNum = Number(bribe.amount);
          let amountInWei: bigint;

          if (brideAmountNum > 1e10) {
            // Looks like wei already, use directly
            console.log(
              `    Token ${bribe.token}: Using bribe amount as wei: ${bribe.amount}`
            );
            amountInWei = BigInt(Math.floor(Number(bribe.amount) * share));
          } else {
            // Looks like human-readable, convert to wei
            const decimals = getTokenDecimals(tokenAddress);
            console.log(
              `    Token ${bribe.token}: Converting ${bribe.amount} to wei with ${decimals} decimals`
            );
            amountInWei = BigInt(
              Math.floor(Number(bribe.amount) * share * 10 ** decimals)
            );
          }

          if (!perAddressTokenAllocations[forwarder.address][tokenAddress]) {
            perAddressTokenAllocations[forwarder.address][tokenAddress] =
              BigInt(0);
          }
          perAddressTokenAllocations[forwarder.address][tokenAddress] +=
            amountInWei;
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

  // Log if we found any Union delegators
  if (unionDelegators.size > 0) {
    console.log(`Found ${unionDelegators.size} Union delegators`);
    console.log("Union delegators:", Array.from(unionDelegators.keys()));
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
  console.log(
    "\n📋 Fetching actual claimed Votium bounties from blockchain..."
  );

  // Fetch claimed bounties from the blockchain
  const votiumConvexBounties = await fetchVotiumClaimedBounties(
    blockStart,
    Number(blockEnd)
  );

  console.log(votiumConvexBounties);

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

  console.log(
    `Found ${votiumConvexBounties.votiumBounties.length} claimed bounties`
  );

  // Map token addresses to overall bribes data
  // matchingBribesAggregated already uses token addresses as keys after our changes
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
    } else {
      console.warn(
        `⚠️  Token ${bounty.rewardToken} not found in any bribes. Skipping this claimed bounty.`
      );
      // Skip this bounty - don't add it to either protocol
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

  console.log(
    `Split bounties: ${Object.keys(protocolBounties.curve).length} curve, ${
      Object.keys(protocolBounties.fxn).length
    } fxn`
  );

  return { votiumConvexBounties, protocolBounties };
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
    const ethereumClient = ((await getClient(1)) ||
      createPublicClient({
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

    const currentEpoch = await ethereumClient.readContract({
      address: VOTIUM_FORWARDER_REGISTRY as `0x${string}`,
      abi: epochAbi,
      functionName: "currentEpoch",
    });

    console.log(`Current Votium epoch: ${currentEpoch}`);

    // Get Curve proposal for reference
    const now = Math.floor(Date.now() / 1000);
    const curveProposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"
    );
    const curveProposalId = curveProposalIds[CVX_SPACE];
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
    console.log("\n🔷 Processing Curve gauge votes...");
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
    console.log(`Processed ${curveGaugesProcessed} Curve gauges with bribes`);

    // Process FXN votes and bribes
    console.log("\n🔶 Processing FXN gauge votes...");
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
      console.log(`Processed ${fxnGaugesProcessed} FXN gauges with bribes`);
    } catch (error) {
      console.error("Error processing FXN gauges:", error);
      console.log("Continuing without FXN gauge processing...");
    }

    // Store original tokenAllocations for USD values
    const originalTokenAllocations = JSON.parse(
      JSON.stringify(tokenAllocations)
    );

    // All amounts are now in USD
    console.log("\n💰 Token allocations complete (amounts in USD)");

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

      console.log(`\n📋 Claimed bounties saved to: ${claimedBountiesPath}`);
      console.log(
        `   - Curve bounties: ${Object.keys(protocolBounties.curve).length}`
      );
      console.log(
        `   - FXN bounties: ${Object.keys(protocolBounties.fxn).length}`
      );

      // Adjust per-address allocations to match actual claimed amounts
      console.log("\n🔄 Adjusting allocations to match claimed amounts...");

      // First, get the actual claimed tokens and amounts from votiumConvexBounties
      // Reset claimedTokenAmounts (already declared outside try block)
      
      // Process all votium bounties to get actual claimed amounts
      for (const bounty of votiumConvexBounties.votiumBounties) {
        const token = bounty.rewardToken;
        if (!claimedTokenAmounts[token]) {
          claimedTokenAmounts[token] = 0n;
        }
        claimedTokenAmounts[token] += BigInt(bounty.amount);
      }

      console.log("\n📊 Claimed tokens from Votium:");
      for (const [token, amount] of Object.entries(claimedTokenAmounts)) {
        console.log(`  ${token}: ${amount.toString()}`);
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

      // Get unique tokens to remove
      const uniqueTokensToRemove = [...new Set(tokensToRemove)];
      console.log(`\n🔍 Found ${uniqueTokensToRemove.length} unclaimed tokens to remove`);

      // Remove unclaimed tokens
      for (const token of uniqueTokensToRemove) {
        console.log(`❌ Removing unclaimed token: ${token}`);
        
        // Count how many addresses have this token before removal
        let addressCount = 0;
        for (const voter in perAddressTokenAllocations) {
          if (perAddressTokenAllocations[voter][token]) {
            addressCount++;
            delete perAddressTokenAllocations[voter][token];
          }
        }
        
        for (const voter in tokenAllocations) {
          if (tokenAllocations[voter][token]) {
            delete tokenAllocations[voter][token];
          }
        }
        
        console.log(`   Removed from ${addressCount} addresses`);
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
      
      console.log(`\n💵 Total USD value to distribute: $${grandTotalUsd.toFixed(2)}`);
      
      // Get token prices for claimed tokens
      // Reset tokenPrices (already declared outside try block)
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
      console.log("\n🔄 Calculating token amounts based on USD allocations...");
      
      for (const token in claimedTokenAmounts) {
        const tokenPrice = tokenPrices[token.toLowerCase()];
        const actualTotal = claimedTokenAmounts[token];
        
        if (!tokenPrice || tokenPrice === 0) {
          console.warn(`⚠️  No price found for token ${token}, using proportional distribution`);
          
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
        const decimals = getTokenDecimals(token);
        const totalTokensNeeded = BigInt(Math.floor((tokenUsdTotal / tokenPrice) * (10 ** decimals)));
        
        console.log(`\nToken ${token}:`);
        console.log(`  Price: $${tokenPrice.toFixed(4)}`);
        console.log(`  Total USD to distribute: $${tokenUsdTotal.toFixed(2)}`);
        console.log(`  Tokens needed: ${totalTokensNeeded.toString()} (${Number(totalTokensNeeded) / (10 ** decimals)} tokens)`);
        console.log(`  Actual claimed: ${actualTotal.toString()} (${Number(actualTotal) / (10 ** decimals)} tokens)`);
        
        // Check if we have enough tokens
        if (totalTokensNeeded > actualTotal) {
          console.warn(`  ⚠️  Not enough tokens! Need ${totalTokensNeeded.toString()} but only have ${actualTotal.toString()}`);
          console.log(`  📊 Will distribute all available tokens proportionally based on USD shares`);
        }
        
        // Distribute tokens based on each user's USD share
        const tokensToDistribute = totalTokensNeeded > actualTotal ? actualTotal : totalTokensNeeded;
        let distributedAmount = 0n;
        
        for (const voter in perAddressTokenAllocations) {
          if (originalTokenAllocations[voter] && originalTokenAllocations[voter][token]) {
            const userUsdForToken = originalTokenAllocations[voter][token].usd;
            const userShare = tokenUsdTotal > 0 ? userUsdForToken / tokenUsdTotal : 0;
            const userTokenAmount = BigInt(Math.floor(Number(tokensToDistribute) * userShare));
            
            perAddressTokenAllocations[voter][token] = userTokenAmount;
            distributedAmount += userTokenAmount;
            
            // Update tokenAllocations with the new amount
            if (tokenAllocations[voter] && tokenAllocations[voter][token]) {
              tokenAllocations[voter][token] = {
                amount: (Number(userTokenAmount) / (10 ** decimals)).toFixed(6),
                usd: originalTokenAllocations[voter][token].usd,
              };
            }
          }
        }
        
        console.log(`  Distributed: ${distributedAmount.toString()} (${Number(distributedAmount) / (10 ** decimals)} tokens)`);
        console.log(`  Remaining: ${(tokensToDistribute - distributedAmount).toString()}`);
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

    // Debug: Log CRV amount for the specific address
    const debugAddress = "0x2dbedd2632d831e61eb3fcc6720f072eef9d522d";
    const crvToken = "0xD533a949740bb3306d119CC777fa900bA034cd52";
    if (
      cleanedPerAddressOutput.tokenAllocations &&
      cleanedPerAddressOutput.tokenAllocations[debugAddress] &&
      cleanedPerAddressOutput.tokenAllocations[debugAddress][crvToken]
    ) {
      console.log(
        `\nDEBUG: Final CRV amount for ${debugAddress}: ${cleanedPerAddressOutput.tokenAllocations[debugAddress][crvToken]}`
      );
    }

    fs.writeFileSync(
      perAddressPath,
      JSON.stringify(cleanedPerAddressOutput, customReplacer)
    );
    console.log(`\n📊 Per-address rewards saved to: ${perAddressPath}`);

    // Print summary
    console.log("\n" + "=".repeat(80));
    console.log("SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total forwarders: ${forwarders.length}`);
    console.log(
      `- Delegator forwarders: ${
        forwarders.filter((f) => f.type === "delegator").length
      }`
    );
    console.log(
      `- Direct voter forwarders: ${
        forwarders.filter((f) => f.type === "direct-voter").length
      }`
    );
    // Calculate total USD value across all tokens
    const totalUsd = Object.values(totalAllocations).reduce(
      (sum, allocation) => sum + allocation.usd,
      0
    );
    console.log(`\nTotal allocated: $${totalUsd.toFixed(2)}`);

    // Show top token allocations with claimed vs distributed comparison
    console.log("\nToken allocations (Claimed vs Distributed):");
    const sortedTokens = Object.entries(totalAllocations)
      .sort(([, a], [, b]) => b.usd - a.usd)
      .slice(0, 10);

    sortedTokens.forEach(([token, allocation]) => {
      const decimals = getTokenDecimals(token);
      const claimedAmount = claimedTokenAmounts[token];
      const distributedWei = Object.values(perAddressTokenAllocations).reduce(
        (sum, userAllocs) => sum + (userAllocs[token] || 0n),
        0n
      );
      
      if (claimedAmount) {
        const claimedFormatted = Number(claimedAmount) / (10 ** decimals);
        const distributedFormatted = Number(distributedWei) / (10 ** decimals);
        const percentUsed = (Number(distributedWei) * 100 / Number(claimedAmount)).toFixed(2);
        
        console.log(
          `  ${token}: ${allocation.amount} ($${allocation.usd.toFixed(2)})`
        );
        console.log(
          `    Claimed: ${claimedFormatted.toFixed(6)} | Distributed: ${distributedFormatted.toFixed(6)} (${percentUsed}% used)`
        );
      } else {
        console.log(
          `  ${token}: ${allocation.amount} ($${allocation.usd.toFixed(2)}) - NOT CLAIMED`
        );
      }
    });

    // Show top forwarder allocations
    console.log("\nForwarder allocations:");
    const sortedForwarders = Object.entries(tokenAllocations)
      .map(([address, tokens]) => ({
        address,
        totalUsd: Object.values(tokens).reduce(
          (sum, allocation) => sum + allocation.usd,
          0
        ),
        type: forwarders.find((f) => f.address === address)?.type || "unknown",
      }))
      .sort((a, b) => b.totalUsd - a.totalUsd);

    sortedForwarders.forEach(({ address, totalUsd, type }) => {
      console.log(`  ${address} (${type}): $${totalUsd.toFixed(2)}`);
    });
    
    // Final summary of token distribution efficiency
    console.log("\n" + "=".repeat(80));
    console.log("TOKEN DISTRIBUTION EFFICIENCY");
    console.log("=".repeat(80));
    
    let totalClaimedUsd = 0;
    let totalDistributedUsd = 0;
    
    for (const [token, claimedAmount] of Object.entries(claimedTokenAmounts)) {
      const decimals = getTokenDecimals(token);
      const distributedWei = Object.values(perAddressTokenAllocations).reduce(
        (sum, userAllocs) => sum + (userAllocs[token] || 0n),
        0n
      );
      
      // Get token price if available
      const tokenPrice = tokenPrices?.[token.toLowerCase()] || 0;
      
      if (tokenPrice > 0) {
        const claimedUsd = (Number(claimedAmount) / (10 ** decimals)) * tokenPrice;
        const distributedUsd = (Number(distributedWei) / (10 ** decimals)) * tokenPrice;
        
        totalClaimedUsd += claimedUsd;
        totalDistributedUsd += distributedUsd;
      }
    }
    
    console.log(`Total claimed value: $${totalClaimedUsd.toFixed(2)}`);
    console.log(`Total distributed value: $${totalDistributedUsd.toFixed(2)}`);
    console.log(`Distribution efficiency: ${(totalDistributedUsd * 100 / totalClaimedUsd).toFixed(2)}%`);
    console.log(`Remaining value: $${(totalClaimedUsd - totalDistributedUsd).toFixed(2)}`);
    
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
