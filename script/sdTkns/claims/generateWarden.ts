import { getTimestampsBlocks } from "../../utils/reportUtils";
import { fetchWardenClaimedBounties } from "../../utils/claims/wardenClaims";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "../../utils/chains";
import { ClaimsTelegramLogger } from "./claimsTelegramLogger";

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

const path_to_protocols: { [key: string]: string } = {
  crv: "curve",
  bal: "balancer",
  fxn: "fxn",
  scbtc: "scbtc",
  sceth: "sceth",
  scusd: "scusd"
};

async function generateWardenBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  console.log(`Generating Warden bounties for period: ${currentPeriod}`);
  console.log(`Fetching blocks for past week: ${pastWeek}`);

  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(ethereumClient, pastWeek);
  
  console.log(`Block range: ${blockNumber1} to ${blockNumber2}`);

  const wardenBounties = await fetchWardenClaimedBounties(blockNumber1, blockNumber2);

  // Transform protocol names if needed
  const warden: { [key: string]: any } = {};
  for (const p of Object.keys(wardenBounties)) {
    const protocol = path_to_protocols[p] || p;
    warden[protocol] = wardenBounties[p];
  }

  const rootDir = path.resolve(__dirname, "../../..");
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString(), 'warden');
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  const fileName = path.join(periodFolder, "claimed_bounties.json");
  const jsonString = JSON.stringify(warden, customReplacer, 2);
  fs.writeFileSync(fileName, jsonString);
  console.log(`Warden weekly claims saved to ${fileName}`);

  // Log aggregated claim sums to Telegram
  const telegramLogger = new ClaimsTelegramLogger();
  await telegramLogger.logClaims("warden/claimed_bounties.json", currentPeriod, warden);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateWardenBounties(pastWeek);