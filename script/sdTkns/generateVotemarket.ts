import { getTimestampsBlocks } from "../utils/reportUtils";
import { fetchVotemarketV1ClaimedBounties } from "../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { VOTEMARKET_PLATFORM_CONFIGS } from "../utils/constants";

const WEEK = 604800;

const ethereumClient = createPublicClient({
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

async function generateVotemarketBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { timestamp1, timestamp2 } = await getTimestampsBlocks(ethereumClient, pastWeek);

  const votemarketBounties = await fetchVotemarketV1ClaimedBounties(
    timestamp1,
    timestamp2,
    VOTEMARKET_PLATFORM_CONFIGS
  );

  const weeklyBounties = {
    timestamp1,
    timestamp2,
    votemarket: votemarketBounties,
  };

  const rootDir = path.resolve(__dirname, "../..");
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString(), 'votemarket');
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  const fileName = path.join(periodFolder, "claimed_bounties.json");
  const jsonString = JSON.stringify(weeklyBounties, customReplacer, 2);
  fs.writeFileSync(fileName, jsonString);
  console.log(`Votemarket weekly claims saved to ${fileName}`);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateVotemarketBounties(pastWeek); 