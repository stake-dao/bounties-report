import { fetchVotemarketV2ClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { CONVEX_LOCKER, FXN_CONVEX_LOCKER } from "../../utils/constants";
import { getTimestampsBlocks } from "../../utils/reportUtils";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";

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

async function generateConvexVotemarketV2Bounties(pastWeek: number = 0) {
  try {
    const currentDate = new Date();
    const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
    const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
    const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

    const { timestamp1, timestamp2 } = await getTimestampsBlocks(
      ethereumClient,
      pastWeek
    );

    // Fetch bounties for multiple protocols
    const curveVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
      "curve",
      timestamp1,
      timestamp2,
      CONVEX_LOCKER
    );

    const fxnVotemarketV2Bounties = await fetchVotemarketV2ClaimedBounties(
      "fxn",
      timestamp1,
      timestamp2,
      FXN_CONVEX_LOCKER
    );

    // Convert arrays to objects with numeric string keys
    const votemarketV2ConvexBounties: { [key: string]: any } = {};
    
    // Process each protocol's bounties
    for (const [protocol, bounties] of Object.entries(curveVotemarketV2Bounties)) {
      if (Array.isArray(bounties)) {
        votemarketV2ConvexBounties[protocol] = arrayToNumericKeyObject(bounties);
      } else {
        votemarketV2ConvexBounties[protocol] = bounties;
      }
    }
    
    for (const [protocol, bounties] of Object.entries(fxnVotemarketV2Bounties)) {
      if (Array.isArray(bounties)) {
        votemarketV2ConvexBounties[protocol] = arrayToNumericKeyObject(bounties);
      } else {
        votemarketV2ConvexBounties[protocol] = bounties;
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

    const fileName = path.join(periodFolder, "claimed_bounties_convex.json");
    const jsonString = JSON.stringify(
      votemarketV2ConvexBounties,
      customReplacer,
      2
    );
    fs.writeFileSync(fileName, jsonString);

    console.log(`Convex locker votemarket v2 bounties saved to ${fileName}`);

    // Log aggregated claim sums to Telegram (chain id for mainnet is 1)
    const telegramLogger = new ClaimsTelegramLogger();
    await telegramLogger.logClaims(
      "votemarket-v2/claimed_bounties_convex.json",
      currentPeriod,
      votemarketV2ConvexBounties
    );
  } catch (error) {
    console.error("Error generating votemarket v2 bounties:", error);
    process.exit(1);
  }
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateConvexVotemarketV2Bounties(pastWeek);
