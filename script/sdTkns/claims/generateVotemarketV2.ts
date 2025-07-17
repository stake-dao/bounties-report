import { getTimestampsBlocks } from "../../utils/reportUtils";
import { fetchVotemarketV2ClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import {
  BALANCER_STAKE_DAO_LOCKER,
  FXN_STAKE_DAO_LOCKER,
  STAKE_DAO_LOCKER,
} from "../../utils/constants";
import { ClaimsTelegramLogger } from "./claimsTelegramLogger";

const WEEK = 604800;

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

// Helper function to convert array to object with numeric string keys
function arrayToNumericKeyObject<T>(arr: T[]): { [key: string]: T } {
  const obj: { [key: string]: T } = {};
  arr.forEach((item, index) => {
    obj[index.toString()] = item;
  });
  return obj;
}

function customReplacer(key: string, value: any): any {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") {
      return value.value;
    }
    // Handle arrays properly
    if (Array.isArray(value)) {
      return value.map((item, index) => customReplacer(String(index), item));
    }
    // Handle objects
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

async function generateVotemarketV2Bounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { timestamp1, timestamp2 } = await getTimestampsBlocks(
    ethereumClient,
    pastWeek
  );

  console.log('Fetching claims for period:', {
    timestamp1,
    timestamp2,
    timestamp1Date: new Date(timestamp1 * 1000).toISOString(),
    timestamp2Date: new Date(timestamp2 * 1000).toISOString(),
    locker: STAKE_DAO_LOCKER
  });

  const curveVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
    "curve",
    timestamp1,
    timestamp2,
    STAKE_DAO_LOCKER
  );

  console.log('curveVotemarketV2Bounties', JSON.stringify(curveVotemarketV2Bounties, customReplacer, 2));

  const balancerVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
    "balancer",
    timestamp1,
    timestamp2,
    BALANCER_STAKE_DAO_LOCKER
  );

  const fxnVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
    "fxn",
    timestamp1,
    timestamp2,
    FXN_STAKE_DAO_LOCKER
  );

  // Convert arrays to objects with numeric string keys
  const votemarketV2Bounties: { [key: string]: any } = {};
  
  // Process each protocol's bounties
  for (const [protocol, bounties] of Object.entries(curveVotemarketV2Bounties)) {
    if (Array.isArray(bounties)) {
      votemarketV2Bounties[protocol] = arrayToNumericKeyObject(bounties);
    } else {
      votemarketV2Bounties[protocol] = bounties;
    }
  }
  
  for (const [protocol, bounties] of Object.entries(balancerVotemarketV2Bounties)) {
    if (Array.isArray(bounties)) {
      votemarketV2Bounties[protocol] = arrayToNumericKeyObject(bounties);
    } else {
      votemarketV2Bounties[protocol] = bounties;
    }
  }
  
  for (const [protocol, bounties] of Object.entries(fxnVotemarketV2Bounties)) {
    if (Array.isArray(bounties)) {
      votemarketV2Bounties[protocol] = arrayToNumericKeyObject(bounties);
    } else {
      votemarketV2Bounties[protocol] = bounties;
    }
  }

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

  const fileName = path.join(periodFolder, "claimed_bounties.json");
  const jsonString = JSON.stringify(votemarketV2Bounties, customReplacer, 2);
  fs.writeFileSync(fileName, jsonString);
  console.log(`VotemarketV2 weekly claims saved to ${fileName}`);

  // Log aggregated claim sums to Telegram (chain id for mainnet is 1)
  const telegramLogger = new ClaimsTelegramLogger();
  await telegramLogger.logClaims(
    "votemarket-v2/claimed_bounties.json",
    currentPeriod,
    votemarketV2Bounties
  );
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateVotemarketV2Bounties(pastWeek);
