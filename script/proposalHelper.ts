import { createPublicClient, http } from "viem";
import {
  associateGaugesPerId,
  getProposal,
  getVoters,
  getVotingPower,
} from "./utils/snapshot";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mainnet } from "viem/chains";
import { getAllCurveGauges } from "./utils/curveApi";
import { DELEGATION_ADDRESS } from "./utils/constants";
import { processAllDelegators } from "./utils/cacheUtils";

const SUPPORTED_SPACES = {
  "sdcrv.eth": "curve",
  "cvx.eth": "curve",
} as const;

const client = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.ankr.com/eth"),
});

function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("proposalId", {
      type: "string",
      description: "Snapshot proposal id",
      required: true,
    })
    .option("gauges", {
      type: "array",
      description: "Gauge address(es)",
      string: true,
      required: false,
      coerce: (arg: string | string[]) => {
        if (typeof arg === "string") {
          return arg.split(",");
        }
        return arg;
      },
    })
    .help().argv;

  try {
    const proposal = await getProposal(argv.proposalId);
    const space = proposal.space.id;

    if (!SUPPORTED_SPACES[space]) {
      console.error("Space not supported: " + space);
      process.exit(1);
    }

    const blockSnapshot = await client.getBlock({
      blockNumber: proposal.snapshot,
    });
    const dateSnapshot = new Date(
      Number(blockSnapshot.timestamp) * 1000
    ).toLocaleString();

    const curveGauges = await getAllCurveGauges();
    const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);

    let gaugePerChoiceIdWithShortName: {
      [key: string]: { shortName: string; choiceId: number };
    } = {};

    // Iterate over choices and add shortName
    for (const gauge of Object.keys(gaugePerChoiceId)) {
      for (const gaugeInfo of curveGauges) {
        if (gaugeInfo.gauge.toLowerCase() === gauge.toLowerCase()) {
          gaugePerChoiceIdWithShortName[gauge] = {
            shortName: gaugeInfo.shortName,
            choiceId: gaugePerChoiceId[gauge],
          };
          break;
        }
      }
    }

    const votes = await getVoters(proposal.id);

    // Print proposal information first
    console.log("\n=== Proposal Information ===");
    console.log(`ID: ${proposal.id}`);
    console.log(`Title: ${proposal.title}`);
    console.log(`Space: ${space}`);
    console.log(`Author: ${formatAddress(proposal.author)}`);
    console.log(`Created: ${new Date(proposal.created * 1000).toLocaleString()}`);
    console.log(`Start: ${new Date(proposal.start * 1000).toLocaleString()}`);
    console.log(`End: ${new Date(proposal.end * 1000).toLocaleString()}`);
    console.log(`Snapshot Block: ${proposal.snapshot}`);
    console.log(`Snapshot Date: ${dateSnapshot}`);
    console.log(`Total Votes: ${votes.length}`);

    if (argv.gauges) {
      console.log("\n=== Gauge Details ===");
      let gauges = argv.gauges as string[];
      gauges = gauges.map((g) => g.trim().toLowerCase());
      
      for (const gauge of gauges) {
        console.log("\n-------------------");
        if (gaugePerChoiceIdWithShortName[gauge]) {
          const gaugeInfo = gaugePerChoiceIdWithShortName[gauge];
          console.log(`Gauge Info:`, gaugeInfo);
          console.log(`Address: ${gauge}`);
          console.log(`Name: ${gaugeInfo.shortName}`);
          console.log(`Choice ID: ${gaugeInfo.choiceId}`);

          const activeChoiceId = gaugeInfo.choiceId;
          const votesForGauge = votes.filter(
            (vote) => vote.choice[activeChoiceId] !== undefined
          );

          console.log(`\n=== Votes for ${gaugeInfo.shortName} ===`);
          console.log(`Total Votes: ${votesForGauge.length}`);

          // Calculate total effective VP for this gauge
          let totalEffectiveVpForGauge = 0;
          const voterEffectiveVps: { [voter: string]: number } = {};

          // First pass: calculate all effective VPs
          for (const vote of votesForGauge) {
            let vpChoiceSum = 0;
            let currentChoiceIndex = 0;

            for (const choiceIndex of Object.keys(vote.choice)) {
              if (activeChoiceId === parseInt(choiceIndex)) {
                currentChoiceIndex = vote.choice[choiceIndex];
              }
              vpChoiceSum += vote.choice[choiceIndex];
            }

            if (currentChoiceIndex > 0) {
              const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
              const effectiveVp = (vote.vp * ratio) / 100;
              voterEffectiveVps[vote.voter] = effectiveVp;
              totalEffectiveVpForGauge += effectiveVp;
            }
          }

          // Print detailed votes
          console.log("\n--- Detailed Votes ---");
          for (const vote of votesForGauge) {
            console.log(`\nVoter: ${formatAddress(vote.voter)}`);
            
            let vpChoiceSum = 0;
            let currentChoiceIndex = 0;

            for (const choiceIndex of Object.keys(vote.choice)) {
              if (activeChoiceId === parseInt(choiceIndex)) {
                currentChoiceIndex = vote.choice[choiceIndex];
              }
              vpChoiceSum += vote.choice[choiceIndex];
            }

            if (currentChoiceIndex > 0) {
              const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
              const effectiveVp = (vote.vp * ratio) / 100;
              console.log(`Total VP: ${vote.vp.toFixed(2)}`);
              console.log(`Share of voter's VP: ${ratio.toFixed(2)}%`);
              console.log(`Effective VP: ${effectiveVp.toFixed(2)}`);
            } else {
              console.log(`Total VP: ${vote.vp.toFixed(2)}`);
              console.log(`Share of voter's VP: 0%`);
              console.log(`Effective VP: 0`);
            }

            console.log(`Timestamp: ${new Date(vote.created * 1000).toLocaleString()}`);

            // Add delegator details if applicable
            if (vote.voter === DELEGATION_ADDRESS) {
              console.log("\nDelegator Details:");

              const delegators = await processAllDelegators(
                space,
                proposal.created,
                DELEGATION_ADDRESS
              );

              if (delegators.length > 0) {
                const vps = await getVotingPower(proposal, delegators);
                const totalVp = Object.values(vps).reduce(
                  (acc, vp) => acc + vp,
                  0
                );

                console.log(`Total Delegators: ${delegators.length}`);
                console.log(`Total Voting Power: ${totalVp}`);
                
                console.log("\nDelegator Breakdown:");
                delegators.forEach((delegator) => {
                  const delegatorVp = vps[delegator] || 0;
                  if (delegatorVp > 0) {
                    const share = (delegatorVp / totalVp).toString();
                    const percentage = (parseFloat(share) * 100).toFixed(2);
                    console.log(`- ${formatAddress(delegator)}`);
                    console.log(`  Share: ${percentage}%`);
                    console.log(`  Voting Power: ${delegatorVp}`);
                  }
                });
              }
            }
          }

          // Print vote distribution summary
          console.log("\n--- Vote Distribution Summary ---");
          console.log(`Total Effective VP for ${gaugeInfo.shortName}: ${totalEffectiveVpForGauge.toFixed(2)}`);
          
          const sortedVoters = Object.entries(voterEffectiveVps)
            .sort(([, a], [, b]) => b - a); // Sort by effective VP, descending

          for (const [voter, effectiveVp] of sortedVoters) {
            const shareOfGauge = (effectiveVp * 100) / totalEffectiveVpForGauge;
            if (shareOfGauge >= 1) { // Only show voters with ≥1% share
              const voterDisplay = voter === DELEGATION_ADDRESS 
                ? "STAKE DELEGATION (0x52ea...)" 
                : formatAddress(voter);
              console.log(`${voterDisplay}: ${shareOfGauge.toFixed(2)}% (${effectiveVp.toFixed(2)} VP)`);
            }
          }

          console.log("\n-------------------");
        } else {
          console.log("Gauge not found: " + gauge);
        }
      }
    } else {
      console.log("\n=== All Available Gauges ===");
      Object.entries(gaugePerChoiceIdWithShortName).forEach(([gauge, info]) => {
        console.log("\n-------------------");
        console.log(`Address: ${gauge}`);
        console.log(`Name: ${info.shortName}`);
        console.log(`Choice ID: ${info.choiceId}`);
      });
    }

  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    } else {
      console.error("Unknown error:", error);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});