// generateWeeklyBounties.ts

import { getTimestampsBlocks } from "./utils/reportUtils";
import {
  fetchVotemarketClaimedBounties,
  fetchWardenClaimedBounties,
  fetchHiddenHandClaimedBounties,
} from "./utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const WEEK = 604800; // One week in seconds

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const path_to_protocols: { [key: string]: string } = {
  crv: "curve",
  bal: "balancer",
  fxn: "fxn",
};

function customReplacer(key: string, value: any) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") {
      return value.value;
    }
    // Handle nested objects
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

async function generateWeeklyBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { timestamp1, timestamp2, blockNumber1, blockNumber2 } =
    await getTimestampsBlocks(publicClient, pastWeek);

  const votemarket = await fetchVotemarketClaimedBounties(
    publicClient,
    blockNumber1,
    blockNumber2
  );
  const warden = await fetchWardenClaimedBounties(blockNumber1, blockNumber2);
  const hiddenhand = await fetchHiddenHandClaimedBounties(
    publicClient,
    currentPeriod,
    blockNumber1,
    blockNumber2
  );

  // Replace keys in warden bounties by protocol
  for (const path of Object.keys(warden)) {
    const protocol = path_to_protocols[path];
    if (protocol) {
      warden[protocol] = warden[path];
      delete warden[path];
    }
  }

  const weeklyBounties = {
    timestamp1,
    timestamp2,
    blockNumber1,
    blockNumber2,
    votemarket,
    warden,
    hiddenhand,
  };

  console.log(JSON.stringify(weeklyBounties, customReplacer, 2));

  // Create 'weekly-bounties' folder at the root of the project if it doesn't exist
  const rootDir = path.resolve(__dirname, ".."); // Go up one level from the script directory
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  // Create folder for the adjusted period inside 'weekly-bounties' if it doesn't exist
  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString());
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  const fileName = path.join(periodFolder, "claimed_bounties.json");
  const jsonString = JSON.stringify(weeklyBounties, customReplacer, 2);
  fs.writeFileSync(fileName, jsonString);
  console.log(`Weekly bounties saved to ${fileName}`);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateWeeklyBounties(pastWeek);
