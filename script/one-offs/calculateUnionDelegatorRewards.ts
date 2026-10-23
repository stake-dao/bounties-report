
import { CVX_SPACE } from "../utils/constants";
import {
  fetchLastProposalsIdsCurrentPeriod,
  getProposal,
  getVoters,
} from "../utils/snapshot";
import axios from "axios";

// Union delegators list with their voting power
const unionDelegatorsList = [
  {
    address: "0xC6D1ed1F2Db34d138da62B13138313DADD6A5AbC",
    vp: 9180.975
  },
  {
    address: "0xf47FD47c6241EfD6e5a6c03be3fe3F8E45f0325B",
    vp: 7500
  },
  {
    address: "0xCA0073964efe7f9422CeB16901018b1DB0cC4785",
    vp: 5964.127
  },
  {
    address: "0x8Ac4c0630C5ed1636537924eC9B037fC652ADee8",
    vp: 711.293
  },
  {
    address: "0xeE33e09ae46d84587a8A89bb7a74e70F8961058B",
    vp: 356.814
  }
];

// The Union's main address that receives bribes
const UNION_ADDRESS = "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49";

interface GaugeBribe {
  gauge: string;
  gaugeName: string;
  choice: number;
  totalBribesUSD: number;
  totalVotes: number;
  unionVotes: number;
  unionShare: number;
  unionBribesUSD: number;
}

interface DelegatorReward {
  address: string;
  vp: number;
  vpShareOfDelegators: number;
  vpShareOfUnion: number;
  estimatedUSD: number;
  gaugeBreakdown?: {
    gauge: string;
    gaugeName: string;
    estimatedUSD: number;
  }[];
}

interface LlamaBribeData {
  proposal: string;
  bribes: {
    choice: string;
    pool: string;
    gauge: string;
    bribesUSD: number;
  }[];
}

async function fetchBribesFromLlama(chain: string = "cvx-crv"): Promise<any | null> {
  try {
    console.log("\n📡 Fetching bribe data from Llama API (exact same method as generateConvexVotium)...");
    
    // Step 1: Get rounds data (exact same as generateConvexVotium)
    const roundsUrl = `https://api.llama.airforce/bribes/votium/${chain}/rounds`;
    console.log(`   Fetching rounds from: ${roundsUrl}`);
    
    const roundsResponse = await axios.get(roundsUrl);
    const roundsData = roundsResponse.data;
    
    // Step 2: Get the last round number (exact same logic)
    const lastRoundNumber = roundsData.rounds
      ? Math.max(...roundsData.rounds) // Use the last completed round
      : null;
    
    if (!lastRoundNumber) {
      console.warn(`No rounds found for ${chain}`);
      return null;
    }
    
    console.log(`   Fetching bribes for ${chain} round ${lastRoundNumber}`);
    
    // Step 3: Fetch bribes for this round (exact same URL pattern)
    const bribesUrl = `https://api.llama.airforce/bribes/votium/${chain}/${lastRoundNumber}`;
    console.log(`   Fetching bribes from: ${bribesUrl}`);
    
    const bribesResponse = await axios.get(bribesUrl);
    const bribesData = bribesResponse.data;
    
    // Return the data in the same format generateConvexVotium expects
    if (bribesData && bribesData.epoch) {
      const bribesCount = bribesData.epoch.bribes ? bribesData.epoch.bribes.length : 0;
      console.log(`✅ Found bribe data for round ${lastRoundNumber}: ${bribesCount} bribes`);
      
      if (bribesData.epoch.bribes) {
        // Calculate total USD value
        const totalUSD = bribesData.epoch.bribes.reduce((sum: number, bribe: any) => 
          sum + (bribe.amountDollars || 0), 0
        );
        console.log(`   Total bribes value: $${totalUSD.toFixed(2)}`);
      }
      
      return bribesData;
    }
    
    console.warn("⚠️  No bribe data found in response");
    return null;
  } catch (error: any) {
    console.error("Error fetching bribes from Llama API:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", error.response.data);
    }
    return null;
  }
}

async function calculateUnionDelegatorRewards() {
  console.log("=".repeat(80));
  console.log("UNION DELEGATOR REWARDS CALCULATOR");
  console.log("=".repeat(80));
  
  try {
    // Step 1: Get current Convex proposal (same as generateConvexVotium)
    console.log("\n📊 Fetching current Convex proposal...");
    
    const now = Math.floor(Date.now() / 1000);
    
    // Use the same filter as generateConvexVotium to exclude FXN proposals
    const curveProposalIds = await fetchLastProposalsIdsCurrentPeriod(
      [CVX_SPACE],
      now,
      "^(?!FXN ).*Gauge Weight for Week of"  // Exclude FXN proposals, only get Convex gauge weight votes
    );
    
    let proposalId = curveProposalIds[CVX_SPACE];
    
    if (!proposalId) {
      console.error("No Convex gauge weight proposal found for current period");
      console.log("Looking for recent proposals...");
      
      // Try getting the most recent closed proposal
      const oneMonthAgo = now - (30 * 24 * 60 * 60);
      const recentProposals = await fetchLastProposalsIdsCurrentPeriod(
        [CVX_SPACE],
        oneMonthAgo,
        "Gauge Weight"
      );
      
      proposalId = recentProposals[CVX_SPACE];
      if (!proposalId) {
        console.error("No Convex proposals found at all");
        return;
      }
      
      console.log(`Using recent proposal: ${proposalId}`);
    }
    
    const proposal = await getProposal(proposalId);
    
    if (!proposal) {
      console.error("Could not fetch proposal details");
      return;
    }
    
    console.log(`✅ Found proposal: ${proposal.title}`);
    console.log(`   Period: ${new Date(proposal.start * 1000).toLocaleDateString()} - ${new Date(proposal.end * 1000).toLocaleDateString()}`);
    console.log(`   Choices: ${proposal.choices.length} gauges`);
    
    // Step 2: Get actual bribe data from Llama API (same as generateConvexVotium)
    // Use "cvx-crv" for Curve gauges (CVX proposals that are not FXN)
    const bribesData = await fetchBribesFromLlama("cvx-crv");
    
    // Create a map of gauge bribes by choice index (Llama uses 0-based, Snapshot uses 1-based)
    const bribesByChoice = new Map<number, number>();
    let totalBribesUSD = 0;
    
    if (bribesData && bribesData.epoch && bribesData.epoch.bribes) {
      console.log(`\n💰 Processing ${bribesData.epoch.bribes.length} bribes from Llama API`);
      
      for (const bribe of bribesData.epoch.bribes) {
        // Llama uses 0-based choice indexing, Snapshot uses 1-based
        // So bribe.choice 0 = Snapshot choice 1
        const snapshotChoiceIndex = bribe.choice + 1;
        
        const existingBribe = bribesByChoice.get(snapshotChoiceIndex) || 0;
        const bribeAmount = bribe.amountDollars || 0;
        bribesByChoice.set(snapshotChoiceIndex, existingBribe + bribeAmount);
        totalBribesUSD += bribeAmount;
        
        // Debug: Show some bribes
        if (bribeAmount > 10000) {
          const gaugeName = proposal.choices[bribe.choice];
          console.log(`   ${gaugeName?.slice(0, 40)}...: $${bribeAmount.toFixed(2)}`);
        }
      }
      
      console.log(`\n💰 Total bribes available: $${totalBribesUSD.toFixed(2)}`);
      console.log(`   Bribes on ${bribesByChoice.size} gauges`);
    } else {
      console.warn("⚠️  No bribe data available from Llama API");
      // You could fall back to estimated values here if needed
    }
    
    // Step 3: Get all votes to calculate vote shares
    console.log(`\n🗳️ Fetching all votes for proposal...`);
    const voters = await getVoters(proposalId);
    
    // Try to find Union with different address formats
    const unionVoter = voters.find((v: any) => 
      v.voter.toLowerCase() === UNION_ADDRESS.toLowerCase()
    );
    
    if (!unionVoter) {
      // Also check if any of the known delegators voted directly
      console.log("   Checking if Union delegators voted directly...");
      const delegatorVoters = unionDelegatorsList.map(d => {
        const voter = voters.find((v: any) => 
          v.voter.toLowerCase() === d.address.toLowerCase()
        );
        return voter ? { ...d, voter } : null;
      }).filter(Boolean);
      
      if (delegatorVoters.length > 0) {
        console.log(`   Found ${delegatorVoters.length} delegators who voted directly`);
      }
    }
    
    if (!unionVoter) {
      console.log("⚠️ Union has not voted yet in this proposal");
      console.log("\n📊 Showing estimated allocations based on delegator voting power...\n");
      
      // Even without Union voting, we can show estimated allocations
      // based on the total bribes and delegator VP shares
      const totalDelegatorVP = unionDelegatorsList.reduce((sum, d) => sum + d.vp, 0);
      
      // Assume Union would have ~150,000 VP (typical amount)
      const assumedUnionVP = 150000;
      
      console.log(`Assumed Union VP: ${assumedUnionVP.toLocaleString()}`);
      console.log(`Total delegator VP: ${totalDelegatorVP.toLocaleString()}`);
      console.log(`Delegators % of assumed Union: ${(totalDelegatorVP / assumedUnionVP * 100).toFixed(2)}%\n`);
      
      if (totalBribesUSD > 0) {
        // Assume Union gets proportional share based on typical voting patterns
        // Union typically captures about 3-5% of total bribes
        const assumedUnionShare = 0.04; // 4% average
        const estimatedUnionBribes = totalBribesUSD * assumedUnionShare;
        
        console.log(`Total bribes in round: $${totalBribesUSD.toFixed(2)}`);
        console.log(`Estimated Union share (${(assumedUnionShare * 100).toFixed(1)}%): $${estimatedUnionBribes.toFixed(2)}\n`);
        
        console.log("ESTIMATED DELEGATOR REWARDS");
        console.log("=".repeat(80));
        
        for (const delegator of unionDelegatorsList) {
          const vpShare = delegator.vp / assumedUnionVP;
          const estimatedRewards = estimatedUnionBribes * vpShare;
          
          console.log(`${delegator.address}:`);
          console.log(`  VP: ${delegator.vp.toLocaleString()}`);
          console.log(`  Share of Union: ${(vpShare * 100).toFixed(3)}%`);
          console.log(`  💵 Estimated rewards: $${estimatedRewards.toFixed(2)}\n`);
        }
        
        const totalDelegatorRewards = unionDelegatorsList.reduce((sum, d) => 
          sum + (estimatedUnionBribes * (d.vp / assumedUnionVP)), 0
        );
        
        console.log("-".repeat(80));
        console.log(`TOTAL estimated delegator rewards: $${totalDelegatorRewards.toFixed(2)}`);
        console.log(`\n⚠️ Note: These are estimates. Actual rewards depend on Union's voting choices.`);
      } else {
        console.log("No bribe data available to estimate rewards.");
      }
      
      return;
    }
    
    console.log(`✅ Union total voting power: ${unionVoter.vp.toLocaleString()}`);
    console.log(`   Total voters: ${voters.length}`);
    
    // Step 4: Calculate votes per gauge
    const votesPerGauge = new Map<number, number>();
    
    for (const voter of voters) {
      for (const [choice, weight] of Object.entries(voter.choice)) {
        const choiceNum = parseInt(choice);
        const voteWeight = weight as number;
        // Weight is out of 1,000,000 not 100
        const votePower = voter.vp * voteWeight / 1000000;
        
        const currentVotes = votesPerGauge.get(choiceNum) || 0;
        votesPerGauge.set(choiceNum, currentVotes + votePower);
      }
    }
    
    // Step 5: Calculate Union's share of bribes for each gauge
    const gaugeBribes: GaugeBribe[] = [];
    let totalUnionBribesUSD = 0;
    
    console.log("\n💰 Union's Bribe Allocation:");
    console.log("-".repeat(60));
    
    for (const [choice, voteWeight] of Object.entries(unionVoter.choice)) {
      const choiceNum = parseInt(choice);
      const weight = voteWeight as number;
      
      if (weight > 0) {
        const gaugeName = proposal.choices[choiceNum - 1] || `Choice ${choiceNum}`;
        // Weight is out of 1,000,000 not 100
        const unionVotesForGauge = unionVoter.vp * weight / 1000000;
        const totalVotesForGauge = votesPerGauge.get(choiceNum) || 0;
        const unionShare = totalVotesForGauge > 0 ? unionVotesForGauge / totalVotesForGauge : 0;
        
        // Get actual bribes for this gauge
        const gaugeBribesUSD = bribesByChoice.get(choiceNum) || 0;
        const unionBribesUSD = gaugeBribesUSD * unionShare;
        
        if (gaugeBribesUSD > 0) {
          gaugeBribes.push({
            gauge: gaugeName,
            gaugeName: gaugeName.length > 50 ? gaugeName.slice(0, 47) + "..." : gaugeName,
            choice: choiceNum,
            totalBribesUSD: gaugeBribesUSD,
            totalVotes: totalVotesForGauge,
            unionVotes: unionVotesForGauge,
            unionShare: unionShare,
            unionBribesUSD: unionBribesUSD
          });
          
          totalUnionBribesUSD += unionBribesUSD;
          
          console.log(`${gaugeName.slice(0, 42)}...`);
          // Weight is out of 1,000,000, convert to percentage for display
          console.log(`  Union weight: ${(weight / 10000).toFixed(2)}%`);
          console.log(`  Union VP: ${unionVotesForGauge.toLocaleString()}`);
          console.log(`  Total VP on gauge: ${totalVotesForGauge.toLocaleString()}`);
          console.log(`  Union share: ${(unionShare * 100).toFixed(2)}%`);
          console.log(`  Total bribes: $${gaugeBribesUSD.toFixed(2)}`);
          console.log(`  Union gets: $${unionBribesUSD.toFixed(2)}`);
        }
      }
    }
    
    if (gaugeBribes.length === 0) {
      console.log("No bribes found for Union's voted gauges");
    }
    
    console.log("-".repeat(60));
    console.log(`TOTAL Union bribes: $${totalUnionBribesUSD.toFixed(2)}`);
    
    // Step 6: Calculate each delegator's share
    const totalDelegatorVP = unionDelegatorsList.reduce((sum, d) => sum + d.vp, 0);
    
    console.log("\n👥 Delegator Analysis:");
    console.log("=".repeat(80));
    console.log(`Total delegator VP: ${totalDelegatorVP.toLocaleString()}`);
    console.log(`Union total VP: ${unionVoter.vp.toLocaleString()}`);
    console.log(`Delegators % of Union: ${(totalDelegatorVP / unionVoter.vp * 100).toFixed(2)}%`);
    
    const delegatorRewards: DelegatorReward[] = [];
    
    for (const delegator of unionDelegatorsList) {
      const vpShareOfDelegators = delegator.vp / totalDelegatorVP;
      const vpShareOfUnion = delegator.vp / unionVoter.vp;
      const estimatedUSD = totalUnionBribesUSD * vpShareOfUnion;
      
      // Calculate per-gauge breakdown
      const gaugeBreakdown = gaugeBribes.map(gb => ({
        gauge: gb.gauge,
        gaugeName: gb.gaugeName,
        estimatedUSD: gb.unionBribesUSD * vpShareOfUnion
      }));
      
      delegatorRewards.push({
        address: delegator.address,
        vp: delegator.vp,
        vpShareOfDelegators,
        vpShareOfUnion,
        estimatedUSD,
        gaugeBreakdown
      });
    }
    
    // Step 7: Display results
    console.log("\n📈 ESTIMATED REWARDS PER DELEGATOR");
    console.log("=".repeat(80));
    console.log("Based on actual bribes from Llama API\n");
    
    // Sort by VP descending
    delegatorRewards.sort((a, b) => b.vp - a.vp);
    
    for (const reward of delegatorRewards) {
      console.log(`${reward.address}:`);
      console.log(`  VP: ${reward.vp.toLocaleString()}`);
      console.log(`  Share of delegators: ${(reward.vpShareOfDelegators * 100).toFixed(2)}%`);
      console.log(`  Share of Union total: ${(reward.vpShareOfUnion * 100).toFixed(2)}%`);
      console.log(`  💵 Estimated rewards: $${reward.estimatedUSD.toFixed(2)}`);
      
      // Show top 3 contributing gauges
      if (reward.gaugeBreakdown && reward.gaugeBreakdown.length > 0) {
        const topGauges = reward.gaugeBreakdown
          .filter(g => g.estimatedUSD > 0)
          .sort((a, b) => b.estimatedUSD - a.estimatedUSD)
          .slice(0, 3);
        
        if (topGauges.length > 0) {
          console.log(`  Top gauges:`);
          for (const gauge of topGauges) {
            console.log(`    - ${gauge.gaugeName}: $${gauge.estimatedUSD.toFixed(2)}`);
          }
        }
      }
      console.log("");
    }
    
    // Step 8: Summary table
    console.log("=".repeat(80));
    console.log("SUMMARY TABLE");
    console.log("=".repeat(80));
    
    console.log("\nAddress                                      VP        % Union   Est. USD");
    console.log("-".repeat(76));
    
    for (const reward of delegatorRewards) {
      const vpStr = reward.vp.toFixed(1).padStart(10);
      const pctStr = (reward.vpShareOfUnion * 100).toFixed(2).padStart(7) + "%";
      const usdStr = "$" + reward.estimatedUSD.toFixed(2).padStart(8);
      
      console.log(`${reward.address}  ${vpStr}  ${pctStr}  ${usdStr}`);
    }
    
    const totalDelegatorRewards = delegatorRewards.reduce((sum, r) => sum + r.estimatedUSD, 0);
    
    console.log("-".repeat(76));
    console.log(`${"TOTAL".padEnd(42)}  ${totalDelegatorVP.toFixed(1).padStart(10)}  ${((totalDelegatorVP / unionVoter.vp) * 100).toFixed(2).padStart(7)}%  $${totalDelegatorRewards.toFixed(2).padStart(8)}`);
    
    console.log("\n" + "=".repeat(80));
    console.log("KEY METRICS");
    console.log("=".repeat(80));
    console.log(`Total bribes in proposal: $${totalBribesUSD.toFixed(2)}`);
    console.log(`Union total bribes: $${totalUnionBribesUSD.toFixed(2)}`);
    console.log(`Union % of total: ${totalBribesUSD > 0 ? (totalUnionBribesUSD / totalBribesUSD * 100).toFixed(2) : 0}%`);
    console.log(`Delegators total share: $${totalDelegatorRewards.toFixed(2)}`);
    console.log(`Delegators % of Union bribes: ${totalUnionBribesUSD > 0 ? (totalDelegatorRewards / totalUnionBribesUSD * 100).toFixed(2) : 0}%`);
    
    // Export to JSON
    const output = {
      timestamp: new Date().toISOString(),
      dataSource: bribesData ? "Llama API" : "Estimated",
      proposal: {
        id: proposalId,
        title: proposal.title,
        start: new Date(proposal.start * 1000).toISOString(),
        end: new Date(proposal.end * 1000).toISOString(),
        totalChoices: proposal.choices.length,
        totalBribesUSD: totalBribesUSD
      },
      union: {
        address: UNION_ADDRESS,
        totalVP: unionVoter.vp,
        totalBribesUSD: totalUnionBribesUSD,
        percentOfTotal: totalBribesUSD > 0 ? (totalUnionBribesUSD / totalBribesUSD * 100) : 0,
        topGauges: gaugeBribes
          .sort((a, b) => b.unionBribesUSD - a.unionBribesUSD)
          .slice(0, 10)
          .map(g => ({
            gauge: g.gauge,
            totalBribes: parseFloat(g.totalBribesUSD.toFixed(2)),
            unionShare: parseFloat((g.unionShare * 100).toFixed(2)),
            unionBribes: parseFloat(g.unionBribesUSD.toFixed(2))
          }))
      },
      delegators: delegatorRewards.map(r => ({
        address: r.address,
        vp: r.vp,
        shareOfUnion: parseFloat((r.vpShareOfUnion * 100).toFixed(4)),
        estimatedUSD: parseFloat(r.estimatedUSD.toFixed(2))
      })),
      totals: {
        delegatorVP: totalDelegatorVP,
        delegatorShareOfUnion: parseFloat(((totalDelegatorVP / unionVoter.vp) * 100).toFixed(2)),
        estimatedDelegatorUSD: parseFloat(totalDelegatorRewards.toFixed(2))
      }
    };
    
    // Save to file
    const fs = require('fs');
    const outputPath = `./union_delegator_rewards_${Date.now()}.json`;
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`\n✅ Results saved to: ${outputPath}`);
    
  } catch (error) {
    console.error("Error calculating rewards:", error);
  }
}

// Run if called directly
if (require.main === module) {
  calculateUnionDelegatorRewards()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

export { calculateUnionDelegatorRewards, unionDelegatorsList };