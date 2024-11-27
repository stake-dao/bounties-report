import {
  fetchVotemarketV1ClaimedBounties,
  fetchVotemarketV2ClaimedBounties,
} from "../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import {
  STAKE_DAO_LOCKER,
  VOTEMARKET_CONVEX_LOCKER_CONFIGS,
} from "../utils/constants";

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
  try {
    const currentDate = new Date();
    const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
    const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
    const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

    // Fetch bounties with error handling
    let votemarketConvexBounties = {};
    let votemarketV2ConvexBounties = {};

    try {
      votemarketConvexBounties = await fetchVotemarketV1ClaimedBounties(
        currentPeriod,
        currentTimestamp,
        VOTEMARKET_CONVEX_LOCKER_CONFIGS
      );
    } catch (error) {
      console.error('Error fetching V1 bounties:', error);
    }

    try {
      votemarketV2ConvexBounties = await fetchVotemarketV2ClaimedBounties(
        currentPeriod,
        currentTimestamp,
        STAKE_DAO_LOCKER
      );
    } catch (error) {
      console.error('Error fetching V2 bounties:', error);
    }

    const weeklyBountiesConvex = {
      timestamp1: currentPeriod,
      timestamp2: currentTimestamp,
      blockNumber1: 0,
      blockNumber2: 0,
      votemarket: votemarketConvexBounties,
      votemarket_v2: votemarketV2ConvexBounties,
      warden: {},
      hiddenhand: {},
    };

    // Ensure directories exist
    const rootDir = path.resolve(__dirname, "../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });

    const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString());
    fs.mkdirSync(periodFolder, { recursive: true });

    // Save results
    const fileNameConvex = path.join(periodFolder, "claimed_bounties_convex.json");
    const jsonStringConvex = JSON.stringify(weeklyBountiesConvex, customReplacer, 2);
    fs.writeFileSync(fileNameConvex, jsonStringConvex);
    
    console.log(`Convex locker weekly bounties saved to ${fileNameConvex}`);
  } catch (error) {
    console.error('Error generating weekly bounties:', error);
    process.exit(1);
  }
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateConvexWeeklyBounties(pastWeek);
