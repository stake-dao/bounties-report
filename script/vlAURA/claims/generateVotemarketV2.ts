import { fetchVotemarketV2ClaimedBounties } from "../../utils/claims/votemarketV2Claims";
import fs from "fs";
import path from "path";
import { VLAURA_RECIPIENT } from "../../utils/constants";
import { getTimestampsBlocks } from "../../utils/reportUtils";
import { getClient } from "../../utils/getClients";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";

const WEEK = 604800;

// Helper function to convert array to object with numeric string keys
function arrayToNumericKeyObject<T>(arr: T[]): { [key: string]: T } {
  const obj: { [key: string]: T } = {};
  arr.forEach((item, index) => {
    obj[index.toString()] = item;
  });
  return obj;
}

function customReplacer(key: string, value: any) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") {
      return value.value;
    }
    const newObj: { [key: string]: any } = {};
    for (const k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        newObj[k] = customReplacer(k, value[k]);
      }
    }
    return newObj;
  }
  return value;
}

async function generateVlAuraVotemarketV2Bounties(pastWeek: number = 0) {
  try {
    // Create client using centralized getClient
    const ethereumClient = await getClient(1);

    const currentDate = new Date();
    const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
    const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
    const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

    const { timestamp1, timestamp2 } = await getTimestampsBlocks(
      ethereumClient,
      pastWeek
    );

    console.log(`Fetching vlAURA Votemarket V2 bounties...`);
    console.log(`Period: ${currentPeriod}`);
    console.log(`Recipient: ${VLAURA_RECIPIENT}`);
    console.log(`Timestamp range: ${timestamp1} - ${timestamp2}`);

    // Fetch bounties for balancer protocol (Aura is a claimer on Balancer gauges)
    const balancerVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
      "balancer",
      timestamp1,
      timestamp2,
      VLAURA_RECIPIENT as `0x${string}`
    );

    // Convert arrays to objects with numeric string keys
    const votemarketV2VlAuraBounties: { [key: string]: any } = {};

    // Process each protocol's bounties
    for (const [protocol, bounties] of Object.entries(
      balancerVotemarketV2Bounties
    )) {
      if (Array.isArray(bounties)) {
        votemarketV2VlAuraBounties[protocol] = arrayToNumericKeyObject(bounties);
      } else {
        votemarketV2VlAuraBounties[protocol] = bounties;
      }
    }

    // Ensure directories exist
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    if (!fs.existsSync(weeklyBountiesDir)) {
      fs.mkdirSync(weeklyBountiesDir, { recursive: true });
    }

    const periodFolder = path.join(
      weeklyBountiesDir,
      currentPeriod.toString(),
      "votemarket-v2"
    );
    if (!fs.existsSync(periodFolder)) {
      fs.mkdirSync(periodFolder, { recursive: true });
    }

    const fileName = path.join(periodFolder, "claimed_bounties_vlaura.json");
    const jsonString = JSON.stringify(
      votemarketV2VlAuraBounties,
      customReplacer,
      2
    );
    fs.writeFileSync(fileName, jsonString);

    console.log(`vlAURA locker votemarket v2 bounties saved to ${fileName}`);

    // Log summary
    const balancerBounties = balancerVotemarketV2Bounties.balancer || [];
    console.log(`Total bounties found: ${balancerBounties.length}`);

    // Calculate totals by token
    const totalByToken: Record<string, bigint> = {};
    for (const bounty of balancerBounties) {
      const token = bounty.rewardToken;
      const amount = bounty.amount as unknown as bigint;
      totalByToken[token] = (totalByToken[token] || 0n) + amount;
    }

    console.log("Total by token:");
    for (const [token, amount] of Object.entries(totalByToken)) {
      console.log(`  ${token}: ${amount.toString()}`);
    }

    // Log aggregated claim sums to Telegram
    const telegramLogger = new ClaimsTelegramLogger();
    await telegramLogger.logClaims(
      "votemarket-v2/claimed_bounties_vlaura.json",
      currentPeriod,
      votemarketV2VlAuraBounties
    );
  } catch (error) {
    console.error("Error generating vlAURA votemarket v2 bounties:", error);
    process.exit(1);
  }
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateVlAuraVotemarketV2Bounties(pastWeek);
