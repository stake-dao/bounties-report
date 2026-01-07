/**
 * Check expected rewards for a Votium forwarder
 *
 * Usage: pnpm tsx script/helpers/checkForwarderRewards.ts <address> [epoch]
 *
 * Example:
 *   pnpm tsx script/helpers/checkForwarderRewards.ts 0xdbc9e41d5e083884f2cb172bb3a17ab09a528101
 *   pnpm tsx script/helpers/checkForwarderRewards.ts 0xdbc9e41d5e083884f2cb172bb3a17ab09a528101 1767225600
 */

import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";

const VOTIUM_REGISTRY = "0x92e6E43f99809dF84ed2D533e1FD8017eb966ee2" as const;
const VLCVX_TOKEN = "0x72a19342e8F1838460eBFCCEf09F6585e32db86E" as const;
const STAKE_DAO_FORWARDER = "0xAe86A3993D13C8D77Ab77dBB8ccdb9b7Bc18cd09";
const EPOCH_DURATION = 1209600; // 14 days in seconds

interface RegistryState {
  start: bigint;
  to: string;
  expiration: bigint;
}

interface Vote {
  voter: string;
  vp: number;
  choice: Record<string, number> | number;
  proposal: {
    id: string;
    title: string;
    end: number;
  };
}

interface Bribe {
  pool: string;
  token: string;
  amount: number;
  amountDollars: number;
  gauge: string;
  choice: number;
}

interface ProposalData {
  choices: string[];
  scores: number[];
}

const client = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.llamarpc.com"),
});

async function getRegistryState(address: string): Promise<RegistryState> {
  const result = await client.readContract({
    address: VOTIUM_REGISTRY as `0x${string}`,
    abi: [
      {
        name: "registry",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [
          { name: "start", type: "uint256" },
          { name: "to", type: "address" },
          { name: "expiration", type: "uint256" },
        ],
      },
    ],
    functionName: "registry",
    args: [address as `0x${string}`],
  });

  return {
    start: result[0],
    to: result[1],
    expiration: result[2],
  };
}

async function getCurrentEpoch(): Promise<bigint> {
  return await client.readContract({
    address: VOTIUM_REGISTRY as `0x${string}`,
    abi: [
      {
        name: "currentEpoch",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "currentEpoch",
  });
}

async function getVlCVXBalance(address: string): Promise<bigint> {
  return await client.readContract({
    address: VLCVX_TOKEN as `0x${string}`,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
}

async function fetchSnapshotVotes(address: string): Promise<Vote[]> {
  const query = `{
    votes(where: {voter: "${address}", space: "cvx.eth"}, first: 10, orderBy: "created", orderDirection: desc) {
      voter
      vp
      choice
      proposal {
        id
        title
        end
      }
    }
  }`;

  const response = await fetch("https://hub.snapshot.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  return data.data?.votes || [];
}

async function fetchProposalScores(proposalId: string): Promise<ProposalData> {
  const query = `{
    proposal(id: "${proposalId}") {
      choices
      scores
    }
  }`;

  const response = await fetch("https://hub.snapshot.org/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  return data.data?.proposal || { choices: [], scores: [] };
}

async function fetchVotiumBribes(round: number): Promise<Bribe[]> {
  try {
    const response = await fetch(
      `https://api.llama.airforce/bribes/votium/cvx-crv/${round}`
    );
    const data = await response.json();
    return data.epoch?.bribes || [];
  } catch (error) {
    console.error("Error fetching bribes:", error);
    return [];
  }
}

async function fetchLatestVotiumRound(): Promise<number> {
  const response = await fetch(
    "https://api.llama.airforce/bribes/votium/cvx-crv/rounds"
  );
  const data = await response.json();
  return Math.max(...(data.rounds || []));
}

function getForwardingStatus(
  registry: RegistryState,
  currentEpoch: bigint
): string {
  if (registry.start === 0n) return "UNREGISTERED";
  if (registry.start > currentEpoch) return "PENDING";
  if (registry.expiration <= currentEpoch) return "EXPIRED";
  if (registry.expiration === BigInt(currentEpoch) + BigInt(EPOCH_DURATION))
    return "EXPIRING";
  return "ACTIVE";
}

function formatDate(timestamp: number | bigint): string {
  return new Date(Number(timestamp) * 1000).toUTCString();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: pnpm tsx script/helpers/checkForwarderRewards.ts <address> [epoch]");
    console.log("");
    console.log("Example:");
    console.log("  pnpm tsx script/helpers/checkForwarderRewards.ts 0xdbc9e41d5e083884f2cb172bb3a17ab09a528101");
    process.exit(1);
  }

  const address = args[0].toLowerCase();
  const specifiedEpoch = args[1] ? BigInt(args[1]) : null;

  console.log("=".repeat(70));
  console.log("VOTIUM FORWARDER REWARDS CHECK");
  console.log("=".repeat(70));
  console.log(`\nAddress: ${address}`);

  // Get current epoch
  const currentEpoch = await getCurrentEpoch();
  const targetEpoch = specifiedEpoch || currentEpoch;

  console.log(`Current Epoch: ${currentEpoch} (${formatDate(currentEpoch)})`);
  if (specifiedEpoch) {
    console.log(`Checking Epoch: ${targetEpoch} (${formatDate(targetEpoch)})`);
  }

  // Get registry state
  console.log(`\n${"-".repeat(70)}`);
  console.log("FORWARDING STATUS");
  console.log("-".repeat(70));

  const registry = await getRegistryState(address);
  const status = getForwardingStatus(registry, targetEpoch);

  console.log(`Status: ${status}`);
  console.log(`Start: ${registry.start} (${formatDate(registry.start)})`);
  console.log(`To: ${registry.to}`);
  console.log(`Expiration: ${registry.expiration} (${formatDate(registry.expiration)})`);

  const isForwardingToStakeDAO =
    registry.to.toLowerCase() === STAKE_DAO_FORWARDER.toLowerCase();
  console.log(`\nForwarding to Stake DAO: ${isForwardingToStakeDAO ? "YES ✓" : "NO ✗"}`);

  // Check if forwarding is active for target epoch
  const isActive =
    registry.start <= targetEpoch &&
    registry.start !== 0n &&
    registry.expiration > targetEpoch;

  console.log(`Active for epoch ${targetEpoch}: ${isActive ? "YES ✓" : "NO ✗"}`);

  if (!isActive) {
    console.log("\n⚠️  Forwarding is NOT active for this epoch!");
    if (status === "EXPIRING") {
      console.log("   The registration is set to expire at the next epoch boundary.");
    }
  }

  // Get vlCVX balance
  console.log(`\n${"-".repeat(70)}`);
  console.log("VOTING POWER");
  console.log("-".repeat(70));

  const vlCVXBalance = await getVlCVXBalance(address);
  console.log(`vlCVX Balance: ${formatUnits(vlCVXBalance, 18)} vlCVX`);

  // Get recent votes
  console.log(`\n${"-".repeat(70)}`);
  console.log("RECENT GAUGE VOTES");
  console.log("-".repeat(70));

  const votes = await fetchSnapshotVotes(address);
  const gaugeVotes = votes.filter((v) =>
    v.proposal.title.includes("Gauge Weight for Week of")
  );

  if (gaugeVotes.length === 0) {
    console.log("No gauge votes found.");
    return;
  }

  // Process latest gauge vote
  const latestVote = gaugeVotes[0];
  console.log(`\nLatest Vote: ${latestVote.proposal.title}`);
  console.log(`Voting Power Used: ${latestVote.vp.toLocaleString()} vlCVX`);

  if (typeof latestVote.choice === "object") {
    const proposalData = await fetchProposalScores(latestVote.proposal.id);

    console.log("\nVote Distribution:");
    const choices = Object.entries(latestVote.choice);

    // Fetch bribes
    const latestRound = await fetchLatestVotiumRound();
    const bribes = await fetchVotiumBribes(latestRound);

    console.log(`\nBribes from Votium round ${latestRound}:`);

    let totalExpectedUSD = 0;
    const rewards: { token: string; amount: number; usd: number; gauge: string }[] = [];

    for (const [choiceId, weight] of choices) {
      const choiceIndex = Number.parseInt(choiceId) - 1; // Snapshot uses 1-based, array is 0-based
      const gaugeName = proposalData.choices[choiceIndex] || `Choice ${choiceId}`;
      const totalScore = proposalData.scores[choiceIndex] || 0;

      // Calculate user's effective VP for this choice
      const totalWeight = Object.values(latestVote.choice as Record<string, number>).reduce(
        (a, b) => a + b,
        0
      );
      const effectiveVP = (latestVote.vp * weight) / totalWeight;
      const userShare = totalScore > 0 ? effectiveVP / totalScore : 0;

      console.log(`\n  ${gaugeName}:`);
      console.log(`    Weight: ${weight} (${((weight / totalWeight) * 100).toFixed(2)}%)`);
      console.log(`    Total Gauge Votes: ${totalScore.toLocaleString()} vlCVX`);
      console.log(`    Your Effective VP: ${effectiveVP.toLocaleString()} vlCVX`);
      console.log(`    Your Share: ${(userShare * 100).toFixed(4)}%`);

      // Find matching bribes (Llama API uses 0-based choice index)
      const matchingBribes = bribes.filter((b) => b.choice === choiceIndex);

      if (matchingBribes.length > 0) {
        console.log("    Bribes:");
        for (const bribe of matchingBribes) {
          const userAmount = bribe.amount * userShare;
          const userUSD = bribe.amountDollars * userShare;
          totalExpectedUSD += userUSD;

          console.log(
            `      - ${bribe.token}: ${userAmount.toFixed(6)} ($${userUSD.toFixed(2)})`
          );

          rewards.push({
            token: bribe.token,
            amount: userAmount,
            usd: userUSD,
            gauge: gaugeName,
          });
        }
      } else {
        console.log("    Bribes: None");
      }
    }

    // Summary
    console.log(`\n${"=".repeat(70)}`);
    console.log("EXPECTED REWARDS SUMMARY");
    console.log("=".repeat(70));

    if (rewards.length > 0) {
      // Group by token
      const tokenTotals: Record<string, { amount: number; usd: number }> = {};
      for (const r of rewards) {
        if (!tokenTotals[r.token]) {
          tokenTotals[r.token] = { amount: 0, usd: 0 };
        }
        tokenTotals[r.token].amount += r.amount;
        tokenTotals[r.token].usd += r.usd;
      }

      console.log("\nBy Token:");
      for (const [token, totals] of Object.entries(tokenTotals)) {
        console.log(`  ${token}: ${totals.amount.toFixed(6)} ($${totals.usd.toFixed(2)})`);
      }

      console.log(`\nTotal Expected Value: $${totalExpectedUSD.toFixed(2)}`);

      if (isActive && isForwardingToStakeDAO) {
        console.log("\n✓ Forwarding is ACTIVE to Stake DAO");
        console.log("  These rewards should be included in Stake DAO's claim.");
      } else if (!isActive) {
        console.log("\n⚠️  Forwarding is NOT ACTIVE");
        console.log("  Rewards will go directly to the user, not Stake DAO.");
      } else if (!isForwardingToStakeDAO) {
        console.log(`\n⚠️  Forwarding to different address: ${registry.to}`);
      }
    } else {
      console.log("\nNo bribes found for voted gauges.");
    }
  } else {
    console.log(`Choice: ${latestVote.choice}`);
  }

  console.log(`\n${"=".repeat(70)}`);
}

main().catch(console.error);
