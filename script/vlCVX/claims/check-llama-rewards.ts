import fetch from 'node-fetch';

/**
 * POC Script to check Curve gauge vote rewards using Llama Airforce API
 * 
 * Example: Check rewards for address 0x0D0Db6402196fb090Cd251A1503b5688A30A6116 on round 98
 */

// Configuration
const CONFIG = {
  LLAMA_API_BASE: 'https://api.llama.airforce',
  SNAPSHOT_API: 'https://hub.snapshot.org/graphql',
  SNAPSHOT_SPACE: 'gauges.curve.eth',
  TARGET_ADDRESS: '0x0D0Db6402196fb090Cd251A1503b5688A30A6116',
  TARGET_ROUND: 98,
};

interface LlamaReward {
  round: number;
  gauge: string;
  user: string;
  amount: string;
  token: string;
  value_usd?: number;
}

interface SnapshotVote {
  voter: string;
  choice: any;
  vp: number;
  created: number;
}

/**
 * Fetch rewards from Llama Airforce API
 */
async function fetchLlamaRewards(address: string, round: number): Promise<LlamaReward[]> {
  try {
    // Try different possible endpoints based on Llama Airforce API structure
    const endpoints = [
      `${CONFIG.LLAMA_API_BASE}/curve/gauges/rewards/${address}/${round}`,
      `${CONFIG.LLAMA_API_BASE}/curve/rewards?address=${address}&round=${round}`,
      `${CONFIG.LLAMA_API_BASE}/v1/curve/rewards/${address}?round=${round}`,
    ];

    for (const url of endpoints) {
      console.log(`Trying endpoint: ${url}`);
      
      try {
        const response = await fetch(url);
        
        if (response.ok) {
          const data = await response.json();
          console.log(`Success with endpoint: ${url}`);
          return Array.isArray(data) ? data : data.rewards || [];
        }
      } catch (error) {
        console.log(`Failed to fetch from ${url}:`, error.message);
      }
    }

    // If no direct endpoint works, try to get general data and filter
    console.log('Trying general rewards endpoint...');
    const generalUrl = `${CONFIG.LLAMA_API_BASE}/curve/gauges/rewards`;
    const response = await fetch(generalUrl);
    
    if (response.ok) {
      const allRewards = await response.json();
      return allRewards.filter((r: LlamaReward) => 
        r.user?.toLowerCase() === address.toLowerCase() && 
        r.round === round
      );
    }

    return [];
  } catch (error) {
    console.error('Error fetching Llama rewards:', error);
    return [];
  }
}

/**
 * Fetch votes from Snapshot for a specific round
 */
async function fetchSnapshotVotes(address: string, round: number): Promise<SnapshotVote[]> {
  const query = `
    query GetVotes($space: String!, $voter: String!) {
      votes(
        first: 1000,
        where: {
          space: $space,
          voter: $voter
        },
        orderBy: "created",
        orderDirection: desc
      ) {
        id
        voter
        created
        choice
        vp
        proposal {
          id
          title
          choices
          start
          end
        }
      }
    }
  `;

  try {
    const response = await fetch(CONFIG.SNAPSHOT_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          space: CONFIG.SNAPSHOT_SPACE,
          voter: address.toLowerCase(),
        },
      }),
    });

    const data = await response.json();
    
    // Filter votes for the specific round (assuming round is in proposal title)
    const roundVotes = data.data?.votes?.filter((vote: any) => {
      const title = vote.proposal?.title || '';
      return title.includes(`#${round}`) || title.includes(`Round ${round}`);
    }) || [];

    return roundVotes;
  } catch (error) {
    console.error('Error fetching Snapshot votes:', error);
    return [];
  }
}

/**
 * Get gauge weights for a specific round
 */
async function fetchGaugeWeights(round: number): Promise<Map<string, number>> {
  try {
    const url = `${CONFIG.LLAMA_API_BASE}/curve/gauges/weights/${round}`;
    const response = await fetch(url);
    
    if (response.ok) {
      const weights = await response.json();
      const weightMap = new Map<string, number>();
      
      // Convert to map for easy lookup
      if (Array.isArray(weights)) {
        weights.forEach((w: any) => {
          weightMap.set(w.gauge.toLowerCase(), w.weight);
        });
      }
      
      return weightMap;
    }
  } catch (error) {
    console.error('Error fetching gauge weights:', error);
  }
  
  return new Map();
}

/**
 * Main function to check rewards and votes
 */
async function checkRewards() {
  console.log('='.repeat(60));
  console.log('Curve Gauge Vote Rewards Checker');
  console.log('='.repeat(60));
  console.log(`Address: ${CONFIG.TARGET_ADDRESS}`);
  console.log(`Round: ${CONFIG.TARGET_ROUND}`);
  console.log('='.repeat(60));

  // 1. Fetch rewards from Llama Airforce
  console.log('\n📊 Fetching rewards from Llama Airforce...');
  const rewards = await fetchLlamaRewards(CONFIG.TARGET_ADDRESS, CONFIG.TARGET_ROUND);
  
  if (rewards.length > 0) {
    console.log(`\nFound ${rewards.length} rewards:`);
    
    let totalUSD = 0;
    rewards.forEach((reward, index) => {
      console.log(`\n${index + 1}. Gauge: ${reward.gauge}`);
      console.log(`   Amount: ${reward.amount} ${reward.token}`);
      if (reward.value_usd) {
        console.log(`   Value: $${reward.value_usd.toFixed(2)}`);
        totalUSD += reward.value_usd;
      }
    });
    
    console.log(`\n💰 Total rewards value: $${totalUSD.toFixed(2)}`);
  } else {
    console.log('\n❌ No rewards found for this address in round', CONFIG.TARGET_ROUND);
  }

  // 2. Fetch Snapshot votes
  console.log('\n\n🗳️  Fetching Snapshot votes...');
  const votes = await fetchSnapshotVotes(CONFIG.TARGET_ADDRESS, CONFIG.TARGET_ROUND);
  
  if (votes.length > 0) {
    console.log(`\nFound ${votes.length} votes for round ${CONFIG.TARGET_ROUND}:`);
    
    votes.forEach((vote: any) => {
      console.log(`\nProposal: ${vote.proposal.title}`);
      console.log(`Voting Power: ${(vote.vp / 1e18).toFixed(2)} veCRV`);
      console.log(`Date: ${new Date(vote.created * 1000).toISOString()}`);
      
      // Parse choices
      if (typeof vote.choice === 'object') {
        console.log('Votes:');
        Object.entries(vote.choice).forEach(([choiceIndex, weight]) => {
          const choiceName = vote.proposal.choices[parseInt(choiceIndex) - 1];
          console.log(`  - ${choiceName}: ${weight}%`);
        });
      }
    });
  } else {
    console.log('\n❌ No Snapshot votes found for round', CONFIG.TARGET_ROUND);
  }

  // 3. Try to correlate votes with rewards
  console.log('\n\n🔍 Cross-referencing votes with rewards...');
  
  if (rewards.length > 0 && votes.length > 0) {
    const rewardedGauges = new Set(rewards.map(r => r.gauge.toLowerCase()));
    const votedGauges = new Set<string>();
    
    // Extract voted gauges from snapshot votes
    votes.forEach((vote: any) => {
      if (typeof vote.choice === 'object') {
        Object.entries(vote.choice).forEach(([choiceIndex, weight]) => {
          const choiceName = vote.proposal.choices[parseInt(choiceIndex) - 1];
          // Try to extract gauge address from choice name
          const gaugeMatch = choiceName.match(/0x[a-fA-F0-9]{40}/);
          if (gaugeMatch) {
            votedGauges.add(gaugeMatch[0].toLowerCase());
          }
        });
      }
    });
    
    console.log(`\nVoted on ${votedGauges.size} gauges`);
    console.log(`Received rewards from ${rewardedGauges.size} gauges`);
    
    // Find matches
    const matches = Array.from(votedGauges).filter(gauge => rewardedGauges.has(gauge));
    if (matches.length > 0) {
      console.log(`\n✅ Matched ${matches.length} gauges with rewards:`, matches);
    } else {
      console.log('\n⚠️  No direct matches found between votes and rewards');
    }
  }

  // 4. Fetch gauge weights for additional context
  console.log('\n\n📈 Fetching gauge weights for round', CONFIG.TARGET_ROUND);
  const weights = await fetchGaugeWeights(CONFIG.TARGET_ROUND);
  
  if (weights.size > 0) {
    console.log(`\nTop 5 gauges by weight:`);
    const sortedWeights = Array.from(weights.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    
    sortedWeights.forEach(([gauge, weight], index) => {
      console.log(`${index + 1}. ${gauge}: ${(weight * 100).toFixed(2)}%`);
    });
  }
}

// Run the script
checkRewards().catch(console.error);

// Export for testing
export { fetchLlamaRewards, fetchSnapshotVotes, fetchGaugeWeights };