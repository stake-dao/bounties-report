import { createPublicClient, http } from "viem";
import {
  associateGaugesPerId,
  getProposal,
  getVoters,
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

const SUPPORTED_SPACES: Record<string, string> = {
  "sdcrv.eth": "curve",
  "cvx.eth": "curve",
} as const;

const client = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.ankr.com/eth"),
});

function setupLogging(proposalId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const currentDate = new Date().toISOString().split("T")[0];
  const logPath = path.join(tempDir, `${currentDate}-proposal-${proposalId}.log`);
  return logPath;
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

  const logPath = setupLogging(argv.proposalId);
  const log = (message: string) => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };

  try {
    const proposal = await getProposal(argv.proposalId);
    const space = proposal.space.id;

    if (!SUPPORTED_SPACES[space]) {
      log("Space not supported: " + space);
      process.exit(1);
    }

    const blockSnapshot = await client.getBlock({
      blockNumber: BigInt(proposal.snapshot),
    });
    const dateSnapshot = new Date(
      Number(blockSnapshot.timestamp) * 1000
    ).toLocaleString();

    // Print proposal information
    proposalInformationLogger(space, proposal, log);
    log(`Snapshot Date: ${dateSnapshot}`);
    /*
    // Fetch and log delegator data
    log("\n=== Delegation Information ===");
    await delegationLogger(space, proposal, log);
    */

    // TODO : All protocols
    const curveGauges = await getAllCurveGauges();

    const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);
    const votes = await getVoters(proposal.id);

    log(`\nTotal Votes: ${votes.length}`);

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
    } else {
      log("\n=== All Available Gauges ===");
      Object.entries(gaugePerChoiceIdWithShortName).forEach(([gauge, info]) => {
        log("\n-------------------");
        log(`Address: ${gauge}`);
        log(`Name: ${info.shortName}`);
        log(`Choice ID: ${info.choiceId}`);
      });
    }

    log(`\nLog file created at: ${logPath}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Error: ${errorMessage}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
