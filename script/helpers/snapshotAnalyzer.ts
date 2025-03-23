import { createPublicClient, http } from "viem";
import {
  associateGaugesPerId,
  getProposal,
  getVoters,
  fetchLastProposalsIds,
} from "../utils/snapshot";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mainnet } from "viem/chains";
import { getAllCurveGauges } from "../utils/curveApi";
import { DELEGATION_ADDRESS } from "../utils/constants";
import fs from "fs";
import path from "path";
import { delegationLogger, proposalInformationLogger } from "../utils/delegationHelper";
import { formatAddress } from "../utils/address";

const client = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

function setupLogging(proposalId: string): string {
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const currentDate = new Date().toISOString().split("T")[0];
  const logPath = path.join(tempDir, `${currentDate}-proposal-${proposalId}.log`);
  
  // Empty the log file if it already exists
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "");
  }
  
  return logPath;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("proposalId", {
      type: "string",
      description: "Snapshot proposal id (optional if --space is provided)",
    })
    .option("space", {
      type: "string",
      description: "Space id to fetch the last proposal from (e.g., sdcrv.eth, cvx.eth)",
    })
    .option("gauges", {
      type: "array",
      description: "Gauge address(es) to analyze in detail",
      string: true,
      required: false,
      coerce: (arg: string | string[]) => {
        if (typeof arg === "string") {
          return arg.split(",");
        }
        return arg;
      },
    })
    .option("delegators", {
      type: "boolean",
      description: "Show detailed delegator information",
      default: false,
    })
    .option("full", {
      type: "boolean",
      description: "Show full analysis (proposal info, delegators, and gauges)",
      default: false,
    })
    .help().argv;

  try {
    // Resolve the proposal ID if not provided
    let proposalId: string | undefined = argv.proposalId;
    if (!proposalId) {
      if (!argv.space) {
        console.error("Error: You must provide either a --proposalId or a --space");
        process.exit(1);
      }
      
      const spaceId = argv.space;
      const now = Math.floor(Date.now() / 1000);
      const filter = spaceId === "cvx.eth" ? "^(?!FXN ).*Gauge Weight*" : "*Gauge vote.*$";

      console.log(`Fetching latest proposal for space ${spaceId}...`);
      const proposalIds = await fetchLastProposalsIds([spaceId], now, filter);
      if (proposalIds.length === 0) {
        console.error(`No proposals found for space ${spaceId}`);
        process.exit(1);
      }
      proposalId = proposalIds[spaceId];
      console.log(`Using latest proposal: ${proposalId}`);
    }

    // Set up logging
    const logPath = setupLogging(proposalId);
    const log = (message: string) => {
      fs.appendFileSync(logPath, `${message}\n`);
      console.log(message);
    };

    // Fetch proposal data
    const proposal = await getProposal(proposalId);
    const space = proposal.space.id;

    // Get snapshot block information
    const blockSnapshot = await client.getBlock({
      blockNumber: BigInt(proposal.snapshot),
    });
    const dateSnapshot = new Date(
      Number(blockSnapshot.timestamp) * 1000
    ).toLocaleString();

    // Print proposal information
    log("=== Proposal Information ===");
    proposalInformationLogger(space, proposal, log);
    log(`Snapshot Date: ${dateSnapshot}`);
    
    // Calculate epoch distribution
    const WEEK = 604800; // seconds in a week
    const currentEpoch = Math.floor(proposal.end / WEEK) * WEEK + WEEK; // One week after the end of the proposal
    const secondEpoch = currentEpoch + WEEK;
    log("\n=== Epoch Distribution ===");
    log(`First Epoch (rounded down on Thursday): ${new Date(currentEpoch * 1000).toUTCString()} (${currentEpoch})`);
    
    // Calculate Tuesday distribution date for first epoch (5 days after Thursday)
    const firstTuesdayDistrib = new Date((currentEpoch + (5 * 86400)) * 1000);
    log(`Tuesday distrib: ${firstTuesdayDistrib.getDate().toString().padStart(2, '0')}/${(firstTuesdayDistrib.getMonth() + 1).toString().padStart(2, '0')}`);
    
    log(`Second Epoch: ${new Date(secondEpoch * 1000).toUTCString()} (${secondEpoch})`);
    
    // Calculate Tuesday distribution date for second epoch (5 days after Thursday)
    const secondTuesdayDistrib = new Date((secondEpoch + (5 * 86400)) * 1000);
    log(`Tuesday distrib: ${secondTuesdayDistrib.getDate().toString().padStart(2, '0')}/${(secondTuesdayDistrib.getMonth() + 1).toString().padStart(2, '0')}`);

    // Fetch votes
    const votes = await getVoters(proposal.id);
    log(`\nTotal Votes: ${votes.length}`);

    // Gather unique voter addresses
    const voters: string[] = [];
    for (const vote of votes) {
      const voterAddress = vote.voter.toLowerCase();
      if (!voters.includes(voterAddress)) {
        voters.push(voterAddress);
      }
    }
    log(`Unique Voters: ${voters.length}`);

    // Show delegator information if requested
    if (argv.delegators || argv.full) {
      log("\n=== Delegation Information ===");
      await delegationLogger(space, proposal, voters, log);
    }

    // Gauge analysis
    if (argv.gauges || argv.full) {
      // Fetch gauge data
      const curveGauges = await getAllCurveGauges();
      const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);

      let gaugePerChoiceIdWithShortName: {
        [key: string]: { shortName: string; choiceId: number };
      } = {};

      // Iterate over choices and add shortName
      for (const gauge of Object.keys(gaugePerChoiceId)) {
        for (const gaugeInfo of curveGauges) {
          if (gaugeInfo.gauge.toLowerCase() === gauge.toLowerCase() || (gaugeInfo.rootGauge && gaugeInfo.rootGauge.toLowerCase() === gauge.toLowerCase())) {
            gaugePerChoiceIdWithShortName[gauge] = {
              shortName: gaugeInfo.shortName,
              choiceId: gaugePerChoiceId[gauge].choiceId,
            };
            break;
          }
        }
      }

      if (argv.gauges) {
        log("\n=== Gauge Details ===");
        let gauges = argv.gauges as string[];
        gauges = gauges.map((g) => g.trim().toLowerCase());

        for (const gauge of gauges) {
          log("\n-------------------");
          if (gaugePerChoiceIdWithShortName[gauge]) {
            const gaugeInfo = gaugePerChoiceIdWithShortName[gauge];
            log(`Gauge Info: ${JSON.stringify(gaugeInfo, null, 2)}`);
            log(`Address: ${gauge}`);
            log(`Name: ${gaugeInfo.shortName}`);
            log(`Choice ID: ${gaugeInfo.choiceId}`);

            const votesForGauge = votes.filter(
              (vote) => vote.choice[gaugeInfo.choiceId] !== undefined
            );

            log(`\n=== Votes for ${gaugeInfo.shortName} ===`);
            log(`Total Votes: ${votesForGauge.length}`);

            // Calculate total effective VP for this gauge
            let totalEffectiveVpForGauge = 0;
            const voterEffectiveVps: { [voter: string]: number } = {};

            // First pass: calculate all effective VPs
            for (const vote of votesForGauge) {
              let vpChoiceSum = 0;
              let currentChoiceIndex = 0;

              for (const choiceIndex of Object.keys(vote.choice)) {
                if (gaugeInfo.choiceId === parseInt(choiceIndex)) {
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
            log("\n--- Detailed Votes ---");
            for (const vote of votesForGauge) {
              log(`\nVoter: ${vote.voter}`);

              let vpChoiceSum = 0;
              let currentChoiceIndex = 0;

              for (const choiceIndex of Object.keys(vote.choice)) {
                if (gaugeInfo.choiceId === parseInt(choiceIndex)) {
                  currentChoiceIndex = vote.choice[choiceIndex];
                }
                vpChoiceSum += vote.choice[choiceIndex];
              }

              if (currentChoiceIndex > 0) {
                const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
                const effectiveVp = (vote.vp * ratio) / 100;
                log(`Total VP: ${vote.vp.toFixed(2)}`);
                log(`Share of voter's VP: ${ratio.toFixed(2)}%`);
                log(`Effective VP: ${effectiveVp.toFixed(2)}`);
              } else {
                log(`Total VP: ${vote.vp.toFixed(2)}`);
                log(`Share of voter's VP: 0%`);
                log(`Effective VP: 0`);
              }

              log(`Timestamp: ${new Date(vote.created * 1000).toLocaleString()}`);
            }

            // Print vote distribution summary
            log("\n--- Vote Distribution Summary ---");
            log(
              `Total Effective VP for ${
                gaugeInfo.shortName
              }: ${totalEffectiveVpForGauge.toFixed(2)}`
            );

            const sortedVoters = Object.entries(voterEffectiveVps).sort(
              ([, a], [, b]) => b - a
            );

            for (const [voter, effectiveVp] of sortedVoters) {
              const shareOfGauge = (effectiveVp * 100) / totalEffectiveVpForGauge;
              const voterDisplay =
                voter === DELEGATION_ADDRESS
                  ? "STAKE DELEGATION (0x52ea...)"
                  : formatAddress(voter);
              log(
                `${voterDisplay}: ${shareOfGauge.toFixed(
                  2
                )}% (${effectiveVp.toFixed(2)} VP)`
              );
            }

            log("\n-------------------");
          } else {
            log("Gauge not found: " + gauge);
          }
        }
      } else if (argv.full) {
        log("\n=== All Available Gauges ===");
        Object.entries(gaugePerChoiceIdWithShortName).forEach(([gauge, info]) => {
          log("\n-------------------");
          log(`Address: ${gauge}`);
          log(`Name: ${info.shortName}`);
          log(`Choice ID: ${info.choiceId}`);
        });
      }
    }

    log(`\nLog file created at: ${logPath}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});