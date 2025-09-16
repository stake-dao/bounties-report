import { createPublicClient, http } from "viem";
import {
  associateGaugesPerId,
  getProposal,
  getVoters,
  fetchLastProposalsIds,
} from "../utils/snapshot";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mainnet } from "../utils/chains";
import { getAllCurveGauges } from "../utils/curveApi";
import { getGaugesInfos } from "../utils/reportUtils";
import { DELEGATION_ADDRESS, VOTIUM_FORWARDER } from "../utils/constants";
import fs from "fs";
import path from "path";
import {
  delegationLogger,
  proposalInformationLogger,
  getForwardedDelegators,
  fetchDelegatorData,
} from "../utils/delegationHelper";
import { formatAddress } from "../utils/address";
import { getBlockNumberByTimestamp } from "../utils/chainUtils";

// Set up the public client for blockchain interactions
const client = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

/**
 * Creates a logging function that writes to both a file and the console.
 * @param logPath - The file path for logging.
 */
function createLogger(logPath: string) {
  return (message: string) => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };
}

/**
 * Sets up the log file in a temp directory.
 * @param proposalTitle - The proposal title used to name the log file.
 * @returns The full path of the log file.
 */
function setupLogFile(proposalTitle: string): string {
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const currentDate = new Date().toISOString().split("T")[0];
  
  // Remove "Gauge vote" prefix and format the title
  let formattedTitle = proposalTitle.trim();
  if (formattedTitle.startsWith("Gauge vote")) {
    formattedTitle = formattedTitle.substring("Gauge vote".length).trim();
  }
  
  // Replace forward slashes with underscores to avoid file path issues
  formattedTitle = formattedTitle.replace(/\//g, "_");
  
  // Replace spaces with hyphens and remove any multiple consecutive spaces
  formattedTitle = formattedTitle.replace(/\s+/g, "-");
  
  const logPath = path.join(
    tempDir,
    `${currentDate}_${formattedTitle}.log`
  );
  fs.writeFileSync(logPath, ""); // Clear the file if it exists
  return logPath;
}

/**
 * Formats the Tuesday distribution date given an epoch.
 * @param epoch - The epoch timestamp.
 * @returns A formatted string (DD/MM) representing the Tuesday distribution.
 */
function formatTuesdayDistribution(epoch: number): string {
  const tuesday = new Date((epoch + 5 * 86400) * 1000);
  return `${tuesday.getDate().toString().padStart(2, "0")}/${(
    tuesday.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}`;
}

async function main() {
  // Set up command-line arguments with yargs
  const argv = await yargs(hideBin(process.argv))
    .option("proposalId", {
      type: "string",
      description: "Snapshot proposal id (optional if --space is provided)",
    })
    .option("space", {
      type: "string",
      description:
        "Space id to fetch the last proposal from (e.g., sdcrv.eth, cvx.eth)",
    })
    .option("gaugeType", {
      type: "string",
      description: "Gauge type to fetch (curve or fxn)",
      default: "curve",
      choices: ["curve", "fxn"],
    })
    .option("gauges", {
      type: "array",
      description: "Gauge address(es) to analyze in detail",
      string: true,
      coerce: (arg: string | string[]) =>
        typeof arg === "string" ? arg.split(",") : arg,
    })
    .help().argv;

  try {
    const { proposalId: inputProposalId, space, gaugeType, gauges } = argv;

    // Resolve the proposal ID
    let proposalId: string | undefined = inputProposalId;
    if (!proposalId) {
      if (!space) {
        console.error(
          "Error: You must provide either a --proposalId or a --space"
        );
        process.exit(1);
      }
      const now = Math.floor(Date.now() / 1000);
      // Select filter based on space and gaugeType
      const filter =
        space === "cvx.eth"
          ? gaugeType.toLowerCase() === "fxn"
            ? "^FXN.*Gauge Weight for Week of"
            : "^(?!FXN ).*Gauge Weight*"
          : "*Gauge vote.*$";
      console.log(
        `Fetching latest proposal for space ${space} with filter ${filter}...`
      );
      const proposalIds = await fetchLastProposalsIds([space], now, filter);
      if (!proposalIds[space]) {
        console.error(`No proposals found for space ${space}`);
        process.exit(1);
      }
      proposalId = proposalIds[space];
      console.log(`Using latest proposal: ${proposalId}`);
    } else if (space === "cvx.eth" && !gaugeType) {
      console.error(
        "Error: For cvx.eth proposals, when passing a proposal ID directly, you must also provide --gaugeType (e.g., fxn)."
      );
      process.exit(1);
    }

    // Fetch proposal and block snapshot data
    const proposal = await getProposal(proposalId);
    const spaceId = proposal.space.id;
    const blockSnapshot = await client.getBlock({
      blockNumber: BigInt(proposal.snapshot),
    });
    const dateSnapshot = new Date(
      Number(blockSnapshot.timestamp) * 1000
    ).toLocaleString();

    // Set up logging
    const logPath = setupLogFile(proposal.title);
    const log = createLogger(logPath);

    log("=== Proposal Information ===");
    proposalInformationLogger(spaceId, proposal, log);
    log(`Snapshot Date: ${dateSnapshot}`);

    // Calculate epoch distribution
    const WEEK = 604800; // seconds in a week
    const currentEpoch = Math.floor(proposal.end / WEEK) * WEEK + WEEK;
    const secondEpoch = currentEpoch + WEEK;
    log("\n=== Epoch Distribution ===");
    log(
      `First Epoch (rounded down on Thursday): ${new Date(
        currentEpoch * 1000
      ).toUTCString()} (${currentEpoch})`
    );
    log(`Tuesday distrib: ${formatTuesdayDistribution(currentEpoch)}`);
    log(
      `Second Epoch: ${new Date(
        secondEpoch * 1000
      ).toUTCString()} (${secondEpoch})`
    );
    log(`Tuesday distrib: ${formatTuesdayDistribution(secondEpoch)}`);

    // Fetch votes and compute unique voters
    const votes = await getVoters(proposal.id);
    log(`\nTotal Votes: ${votes.length}`);
    const voters = Array.from(
      new Set(votes.map((vote) => vote.voter.toLowerCase()))
    );
    log(`Unique Voters: ${voters.length}`);

    // Always show delegation information
    log("\n=== Delegation Information ===");
    await delegationLogger(spaceId, proposal, voters, log);

    // For cvx.eth space, also fetch forwarders for all voters
    if (spaceId === "cvx.eth") {
      log("\n=== All Voters Forwarder Analysis ===");
      const blockNumber = await getBlockNumberByTimestamp(proposal.end, "after", 1);
      
      // Get delegator data
      const delegatorData = await fetchDelegatorData(spaceId, proposal, "1");
      const delegatorSet = new Set(
        delegatorData?.delegators.map(d => d.toLowerCase()) || []
      );
      
      log(`Fetching forwarder data for ${voters.length} unique voters...`);
      try {
        const forwardedAddresses = await getForwardedDelegators(
          voters,
          blockNumber
        );
        
        // Categorize voters
        let delegatorForwarderCount = 0;
        let delegatorNonForwarderCount = 0;
        let nonDelegatorForwarderCount = 0;
        let nonDelegatorNonForwarderCount = 0;
        
        const voterForwarderMap: Record<string, { isForwarder: boolean; isDelegator: boolean }> = {};
        
        voters.forEach((voter, index) => {
          const isForwarder = forwardedAddresses[index] && 
            forwardedAddresses[index].toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
          const isDelegator = delegatorSet.has(voter.toLowerCase());
          
          voterForwarderMap[voter] = { isForwarder, isDelegator };
          
          if (isDelegator) {
            if (isForwarder) {
              delegatorForwarderCount++;
            } else {
              delegatorNonForwarderCount++;
            }
          } else {
            if (isForwarder) {
              nonDelegatorForwarderCount++;
            } else {
              nonDelegatorNonForwarderCount++;
            }
          }
        });
        
        // Count delegators who actually voted
        const delegatorsWhoVoted = voters.filter(v => delegatorSet.has(v.toLowerCase())).length;
        const nonDelegatorCount = voters.length - delegatorsWhoVoted;
        
        log(`\nVoter Categories:`);
        log(`Total Unique Voters: ${voters.length}`);
        log(`\nDelegators to Stake DAO who voted (${delegatorsWhoVoted} out of ${delegatorSet.size} total delegators):`);
        log(`  - Using Votium Forwarder: ${delegatorForwarderCount} (${delegatorsWhoVoted > 0 ? ((delegatorForwarderCount / delegatorsWhoVoted) * 100).toFixed(2) : '0.00'}% of voting delegators)`);
        log(`  - NOT using Votium Forwarder: ${delegatorNonForwarderCount} (${delegatorsWhoVoted > 0 ? ((delegatorNonForwarderCount / delegatorsWhoVoted) * 100).toFixed(2) : '0.00'}% of voting delegators)`);
        
        log(`\nNon-Delegators (${nonDelegatorCount} total):`);
        log(`  - Using Votium Forwarder: ${nonDelegatorForwarderCount} (${nonDelegatorCount > 0 ? ((nonDelegatorForwarderCount / nonDelegatorCount) * 100).toFixed(2) : '0.00'}% of non-delegators)`);
        log(`  - NOT using Votium Forwarder: ${nonDelegatorNonForwarderCount} (${nonDelegatorCount > 0 ? ((nonDelegatorNonForwarderCount / nonDelegatorCount) * 100).toFixed(2) : '0.00'}% of non-delegators)`);
        
        const totalForwarders = delegatorForwarderCount + nonDelegatorForwarderCount;
        log(`\nOverall Forwarder Usage:`);
        log(`  - Total using Votium Forwarder: ${totalForwarders} (${((totalForwarders / voters.length) * 100).toFixed(2)}% of all voters)`);
        log(`  - Total NOT using Votium Forwarder: ${voters.length - totalForwarders} (${(((voters.length - totalForwarders) / voters.length) * 100).toFixed(2)}% of all voters)`);
        
        // Show top voters with forwarder status and delegator label
        log("\nTop 30 Voters by Voting Power:");
        const topVoters = votes
          .sort((a, b) => b.vp - a.vp)
          .slice(0, 30)
          .map(vote => {
            const voter = vote.voter.toLowerCase();
            const info = voterForwarderMap[voter];
            return {
              voter,
              vp: vote.vp,
              isForwarder: info?.isForwarder || false,
              isDelegator: info?.isDelegator || false
            };
          });
        
        topVoters.forEach((item, index) => {
          const labels = [];
          if (item.isDelegator) labels.push("DELEGATOR");
          if (item.isForwarder) labels.push("FORWARDER");
          const labelStr = labels.length > 0 ? `[${labels.join(", ")}]` : "[DIRECT VOTER]";
          log(`${index + 1}. ${formatAddress(item.voter)}: ${item.vp.toFixed(2)} VP ${labelStr}`);
        });
      } catch (error) {
        log(`Error fetching forwarder data: ${error}`);
      }
    }

    // Perform gauge analysis only if gauges are provided
    if (gauges) {
      log("\n=== Gauge Details ===");
      // Fetch gauges based on the provided gaugeType
      let fetchedGauges;
      if (gaugeType === "curve") {
        console.log("Fetching Curve gauges...");
        fetchedGauges = await getAllCurveGauges();
      } else {
        console.log("Fetching FXN gauges...");
        fetchedGauges = await getGaugesInfos("fxn");
        fetchedGauges = fetchedGauges.map((gauge: any) => ({
          ...gauge,
          shortName: gauge.name,
          gauge: gauge.address,
        }));
      }

      // Map gauges to their associated choice IDs
      const gaugePerChoiceId = associateGaugesPerId(proposal, fetchedGauges);
      const gaugePerChoiceIdWithShortName: {
        [key: string]: { shortName: string; choiceId: number };
      } = {};
      for (const gaugeAddress of Object.keys(gaugePerChoiceId)) {
        const gaugeInfo = fetchedGauges.find(
          (g: any) =>
            g.gauge.toLowerCase() === gaugeAddress.toLowerCase() ||
            (g.rootGauge &&
              g.rootGauge.toLowerCase() === gaugeAddress.toLowerCase())
        );
        if (gaugeInfo) {
          gaugePerChoiceIdWithShortName[gaugeAddress] = {
            shortName: gaugeInfo.shortName,
            choiceId: gaugePerChoiceId[gaugeAddress].choiceId,
          };
        }
      }

      // Normalize the provided gauge addresses
      const gaugesArg = (gauges as string[]).map((g) => g.trim().toLowerCase());
      for (const gauge of gaugesArg) {
        log("\n-------------------");
        const info = gaugePerChoiceIdWithShortName[gauge];
        if (!info) {
          log("Gauge not found: " + gauge);
          continue;
        }
        log(`Gauge Info: ${JSON.stringify(info, null, 2)}`);
        log(`Address: ${gauge}`);
        log(`Name: ${info.shortName}`);
        log(`Choice ID: ${info.choiceId}`);

        const votesForGauge = votes.filter(
          (vote) => vote.choice[info.choiceId] !== undefined
        );
        log(`\n=== Votes for ${info.shortName} ===`);
        log(`Total Votes: ${votesForGauge.length}`);

        // Calculate effective VP for each vote and accumulate totals
        let totalEffectiveVpForGauge = 0;
        const voterEffectiveVps: { [voter: string]: number } = {};
        votesForGauge.forEach((vote) => {
          const totalChoiceSum = Object.values(vote.choice).reduce(
            (sum: number, val: unknown) => sum + (val as number),
            0
          );
          const currentChoiceValue = vote.choice[info.choiceId] || 0;
          if (currentChoiceValue > 0 && totalChoiceSum > 0) {
            const ratio = (currentChoiceValue * 100) / totalChoiceSum;
            const effectiveVp = (vote.vp * ratio) / 100;
            voterEffectiveVps[vote.voter] = effectiveVp;
            totalEffectiveVpForGauge += effectiveVp;
          }
        });

        // Print detailed vote breakdown for the gauge
        log("\n--- Detailed Votes ---");
        votesForGauge.forEach((vote) => {
          const totalChoiceSum = Object.values(vote.choice).reduce(
            (sum: number, val: unknown) => sum + (val as number),
            0
          );
          const currentChoiceValue = vote.choice[info.choiceId] || 0;
          const ratio =
            totalChoiceSum > 0
              ? (currentChoiceValue * 100) / totalChoiceSum
              : 0;
          const effectiveVp = (vote.vp * ratio) / 100;
          log(`\nVoter: ${vote.voter}`);
          log(`Total VP: ${vote.vp.toFixed(2)}`);
          log(`Share of voter's VP: ${ratio.toFixed(2)}%`);
          log(`Effective VP: ${effectiveVp.toFixed(2)}`);
          log(`Timestamp: ${new Date(vote.created * 1000).toLocaleString()}`);
        });

        // Print summary of vote distribution
        log("\n--- Vote Distribution Summary ---");
        log(
          `Total Effective VP for ${
            info.shortName
          }: ${totalEffectiveVpForGauge.toFixed(2)}`
        );
        Object.entries(voterEffectiveVps)
          .sort(([, a], [, b]) => b - a)
          .forEach(([voter, effectiveVp]) => {
            const share = (effectiveVp * 100) / totalEffectiveVpForGauge;
            const displayVoter =
              voter === DELEGATION_ADDRESS
                ? "STAKE DELEGATION (0x52ea...)"
                : formatAddress(voter);
            log(
              `${displayVoter}: ${share.toFixed(2)}% (${effectiveVp.toFixed(
                2
              )} VP)`
            );
          });

        log("\n-------------------");
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
