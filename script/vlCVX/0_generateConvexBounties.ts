import { getTimestampsBlocks } from "../utils/reportUtils";
import { fetchVotemarketConvexLockerClaimedBounties } from "../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const WEEK = 604800; // One week in seconds

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

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

async function generateConvexWeeklyBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { timestamp1, timestamp2, blockNumber1, blockNumber2 } =
    await getTimestampsBlocks(publicClient, pastWeek);

  // Fetch bounties for Convex locker
  const votemarketConvexBounties = await fetchVotemarketConvexLockerClaimedBounties(
    publicClient,
    blockNumber1,
    blockNumber2,
  );

  const weeklyBountiesConvex = {
    timestamp1,
    timestamp2,
    blockNumber1,
    blockNumber2,
    votemarket: votemarketConvexBounties,
    warden: {}, // Convex doesn't use Warden
    hiddenhand: {}, // Convex doesn't use Hidden Hand
  };

  // Create 'weekly-bounties' folder at the root of the project if it doesn't exist
  const rootDir = path.resolve(__dirname, "../.."); 
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  // Create folder for the adjusted period inside 'weekly-bounties' if it doesn't exist
  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString());
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  // Save Convex locker bounties
  const fileNameConvex = path.join(
    periodFolder,
    "claimed_bounties_convex.json"
  );
  const jsonStringConvex = JSON.stringify(
    weeklyBountiesConvex,
    customReplacer,
    2
  );
  fs.writeFileSync(fileNameConvex, jsonStringConvex);
  console.log(`Convex locker weekly bounties saved to ${fileNameConvex}`);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateConvexWeeklyBounties(pastWeek);