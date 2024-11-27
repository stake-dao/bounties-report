import { getTimestampsBlocks } from "../utils/reportUtils";
import { fetchVotemarketV1ClaimedBounties, fetchVotemarketV2ClaimedBounties } from "../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { STAKE_DAO_LOCKER, VOTEMARKET_CONVEX_LOCKER_CONFIGS } from "../utils/constants";

const WEEK = 604800; // One week in seconds

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

  // Fetch bounties for Convex locker on Votemarket V1
  const votemarketConvexBounties = await fetchVotemarketV1ClaimedBounties(
    currentPeriod,
    currentTimestamp,
    VOTEMARKET_CONVEX_LOCKER_CONFIGS
  );

  const votemarketV2ConvexBounties = await fetchVotemarketV2ClaimedBounties(
    currentPeriod,
    currentTimestamp,
    STAKE_DAO_LOCKER
  );

  const weeklyBountiesConvex = {
    timestamp1: currentPeriod,
    timestamp2: currentTimestamp,
    blockNumber1: 0,
    blockNumber2: 0,
    votemarket: votemarketConvexBounties,
    votemarket_v2: votemarketV2ConvexBounties,
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
