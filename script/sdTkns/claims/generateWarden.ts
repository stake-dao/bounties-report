import { getTimestampsBlocks } from "../../utils/reportUtils";
import { fetchWardenClaimedBounties } from "../../utils/claimedBountiesUtils";
import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
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
};

async function generateWardenBounties(pastWeek: number = 0) {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const adjustedTimestamp = currentTimestamp - pastWeek * WEEK;
  const currentPeriod = Math.floor(adjustedTimestamp / WEEK) * WEEK;

  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(ethereumClient, pastWeek);

  const wardenBounties = await fetchWardenClaimedBounties(blockNumber1, blockNumber2);

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

  // Log aggregated claim sums to Telegram (chain id for mainnet is 1)
  const telegramLogger = new ClaimsTelegramLogger();
  await telegramLogger.logClaims("warden/claimed_bounties.json", currentPeriod, warden);
}

const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
generateWardenBounties(pastWeek);
