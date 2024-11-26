import { getTimestampsBlocks } from "../utils/reportUtils";
import {
  fetchVotemarketStakeDaoLockerClaimedBounties,
  fetchWardenClaimedBounties,
  fetchHiddenHandClaimedBounties,
} from "../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http, pad } from "viem";
import { mainnet } from "viem/chains";
import { STAKE_DAO_LOCKER, CONVEX_LOCKER } from "../utils/constants";

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

  // Fetch bounties for standard locker
  const votemarketStakeBounties =
    await fetchVotemarketStakeDaoLockerClaimedBounties(
      publicClient,
      blockNumber1,
      blockNumber2
    );

  const wardenBounties = await fetchWardenClaimedBounties(
    blockNumber1,
    blockNumber2
  );

  const hiddenhand = await fetchHiddenHandClaimedBounties(
    publicClient,
    currentPeriod,
    blockNumber1,
    blockNumber2
  );

  // Replace keys in warden bounties by protocol
  const warden: { [key: string]: any } = {};
  for (const path of Object.keys(wardenBounties)) {
    console.log("path", path);
    const protocol = path_to_protocols[path] || path;
    warden[protocol] = wardenBounties[path];
  }

  const weeklyBounties = {
    timestamp1,
    timestamp2,
    blockNumber1,
    blockNumber2,
    votemarket: votemarketStakeBounties,
    warden,
    hiddenhand,
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

  // Save Stake Dao locker bounties
  const fileNameStandard = path.join(periodFolder, "claimed_bounties.json");
  const jsonStringStandard = JSON.stringify(weeklyBounties, customReplacer, 2);
  fs.writeFileSync(fileNameStandard, jsonStringStandard);
  console.log(`Standard locker weekly bounties saved to ${fileNameStandard}`);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateWeeklyBounties(pastWeek);
