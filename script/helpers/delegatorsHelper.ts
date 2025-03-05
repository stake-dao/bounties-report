import path from "path";
import fs from "fs";
import { delegationLogger } from "../utils/delegationHelper";
import { getProposal, getVoters, fetchLastProposalsIds } from "../utils/snapshot";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { formatAddress } from "../utils/address";

function setupLogging(dateSnapshot: number, spaceId: string): string {
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestampToDate = new Date(dateSnapshot * 1000)
    .toISOString()
    .split("T")[0];
  const logPath = path.join(tempDir, `${timestampToDate}-${spaceId}-delegators.log`);

  // Empty the log file if it exists
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "");
  }

  return logPath;
}

async function main() {
  const args = await yargs(hideBin(process.argv))
    .option("proposalId", {
      type: "string",
      description: "Snapshot proposal id (optional if --space is provided)",
    })
    .option("space", {
      type: "string",
      description: "Space id to fetch the last proposal from",
    })
    .help()
    .argv;

  let proposalId: string | undefined = args.proposalId;

  if (!proposalId) {
    if (!args.space) {
      console.error("Error: You must provide either a --proposalId or a --space");
      process.exit(1);
    }
    const now = Math.floor(Date.now() / 1000);
    const filter = args.space === "cvx.eth" ? "^(?!FXN ).*Gauge Weight*": "*Gauge vote.*$";

    // TODO : If cvx.eth, also fetch for each delegator the Votium forwarded status

    const proposalIds = await fetchLastProposalsIds([args.space], now, filter);
    if (proposalIds.length === 0) {
      console.error(`No proposals found for space ${args.space}`);
      process.exit(1);
    }
    proposalId = proposalIds[args.space];
    console.log(`No proposalId provided. Using latest proposal ${proposalId} for space ${args.space}`);
  }

  // Now fetch the proposal details once
  const proposal = await getProposal(proposalId);
  const resolvedSpace = proposal.space.id;

  console.log(`Space: ${resolvedSpace}`);
  console.log(`Proposal: ${proposalId}`);
  console.log(proposal);

  const logPath = setupLogging(proposal.start, resolvedSpace);
  const log = (message: string) => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };

  log("=== Proposal Information ===");
  log(`ID: ${proposal.id}`);
  log(`Title: ${proposal.title}`);
  log(`Space: ${resolvedSpace}`);
  log(`Author: ${formatAddress(proposal.author)}`);
  log(`Created: ${new Date(proposal.created * 1000).toLocaleString()}`);
  log(`Start: ${new Date(proposal.start * 1000).toLocaleString()}`);
  log(`End: ${new Date(proposal.end * 1000).toLocaleString()}`);
  log(`Snapshot Block: ${proposal.snapshot}`);

  const votes = await getVoters(proposal.id);
  log(`Total Votes: ${votes.length}`);

  // Gather unique voter addresses
  const voters: string[] = [];
  for (const vote of votes) {
    const voterAddress = vote.voter.toLowerCase();
    if (!voters.includes(voterAddress)) {
      voters.push(voterAddress);
    }
  }

  await delegationLogger(resolvedSpace, proposal, voters, log);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
