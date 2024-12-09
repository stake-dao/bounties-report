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

          console.log(`\nTotal Votes for this Gauge: ${votesForGauge.length}`);

          for (const vote of votesForGauge) {
            console.log("\nVote Details:");
            console.log(`Voter: ${vote.voter}`);
            console.log(`Weight: ${vote.choice[activeChoiceId]}`);
            console.log(`Timestamp: ${new Date(vote.created * 1000).toLocaleString()}`);

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