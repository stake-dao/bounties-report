// generateBSCWeeklyBounties.ts

import {
  createPublicClient,
  http,
  formatUnits,
  Address,
  PublicClient,
} from "viem";
import { bsc } from "viem/chains";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fetchVotemarketBSCBounties } from "./utils/claimedBountiesUtils";

// Constants
const WEEK = 604800;

// Initialize Viem client
const publicClient = createPublicClient({
  chain: bsc,
  transport: http("https://bsc-dataseed.bnbchain.org"),
});

// Interfaces
interface ClaimedBounties {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket: Record<string, any[]>;
}

// Helper functions
async function getTimestampsBlocks(
  publicClient: PublicClient,
  pastWeek?: number
): Promise<{
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
}> {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  let timestamp2: number;
  let timestamp1: number;

  if (pastWeek === undefined || pastWeek === 0) {
    console.log("No past week specified, using current week");
    timestamp2 = currentTimestamp;
    timestamp1 = Math.floor(currentTimestamp / WEEK) * WEEK;
  } else {
    console.log(`Past week specified: ${pastWeek}`);
    timestamp2 = Math.floor(currentTimestamp / WEEK) * WEEK;
    timestamp1 = timestamp2 - pastWeek * WEEK;
  }

  const blockNumber1 = await getClosestBlockTimestamp(timestamp1);
  const blockNumber2 =
    pastWeek === undefined || pastWeek === 0
      ? Number(await publicClient.getBlockNumber())
      : await getClosestBlockTimestamp(timestamp2);

  return { timestamp1, timestamp2, blockNumber1, blockNumber2 };
}

async function getClosestBlockTimestamp(timestamp: number): Promise<number> {
  const response = await axios.get(
    `https://coins.llama.fi/block/bsc/${timestamp}`
  );
  if (response.status !== 200) {
    throw new Error("Failed to get closest block timestamp");
  }
  return response.data.height;
}

// Main function
async function generateBSCWeeklyBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { timestamp1, timestamp2, blockNumber1, blockNumber2 } =
    await getTimestampsBlocks(publicClient, pastWeek);

  const votemarket = await fetchVotemarketBSCBounties(
    publicClient,
    blockNumber1,
    blockNumber2
  );

  const weeklyBounties: ClaimedBounties = {
    timestamp1,
    timestamp2,
    blockNumber1,
    blockNumber2,
    votemarket,
  };

  // Create 'weekly-bounties' folder at the root of the project if it doesn't exist
  const rootDir = path.resolve(__dirname, "..");
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  // Create folder for the adjusted period inside 'weekly-bounties' if it doesn't exist
  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString());
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  const fileName = path.join(periodFolder, "bsc_claimed_bounties.json");
  const jsonString = JSON.stringify(
    weeklyBounties,
    (key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
  fs.writeFileSync(fileName, jsonString);
  console.log(`BSC Weekly bounties saved to ${fileName}`);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateBSCWeeklyBounties(pastWeek);
