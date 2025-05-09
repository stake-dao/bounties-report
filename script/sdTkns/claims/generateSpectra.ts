import { getSpectraDistribution } from "../../spectra/utils";
import fs from "fs";
import path from "path";
import { ClaimsTelegramLogger } from "./claimsTelegramLogger";

const WEEK = 604800;

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

async function generateSpectraBounties() {
  const currentDate = new Date();
  const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
  const currentPeriod = Math.floor(currentTimestamp / WEEK) * WEEK;


  const bounties = await getSpectraDistribution();

  // Transform in good format
  const processedBounties = bounties.map((bounty) => ({
    bountyId: BigInt(bounty.poolId).toString(),
    gauge: bounty.poolAddress,
    amount: bounty.amount,
    rewardToken: bounty.tokenRewardAddress,
  }));

  const baseBounties = {
    "spectra": processedBounties
  }

  const rootDir = path.resolve(__dirname, "../../..");
  const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
  if (!fs.existsSync(weeklyBountiesDir)) {
    fs.mkdirSync(weeklyBountiesDir, { recursive: true });
  }

  const periodFolder = path.join(weeklyBountiesDir, currentPeriod.toString(), "spectra");
  if (!fs.existsSync(periodFolder)) {
    fs.mkdirSync(periodFolder, { recursive: true });
  }

  const fileName = path.join(periodFolder, "claimed_bounties.json");
  const jsonString = JSON.stringify(baseBounties, customReplacer, 2);
  fs.writeFileSync(fileName, jsonString);
  console.log(`Spectra weekly claims saved to ${fileName}`);

  const telegramLogger = new ClaimsTelegramLogger();
  await telegramLogger.logClaims("spectra/claimed_bounties.json", currentPeriod, baseBounties, 8453);
}

generateSpectraBounties();