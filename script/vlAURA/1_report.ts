import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getTokenInfo, getGaugesInfos } from "../utils/reportUtils";
import { VotemarketV2Bounty } from "../utils/types";
import { getClient } from "../utils/constants";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

interface ClaimedBounties {
  balancer: VotemarketV2Bounty[];
}

interface TokenInfo {
  chainId: number;
  symbol: string;
  decimals: number;
}

interface CSVRow {
  chainId: number;
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: string;
}

async function fetchClaimedBounties(): Promise<ClaimedBounties> {
  const votemarketV2Path = `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties_vlaura.json`;

  let votemarketV2Bounties;

  try {
    const votemarketV2Data = fs.readFileSync(votemarketV2Path, "utf8");
    votemarketV2Bounties = JSON.parse(votemarketV2Data, (key, value) => {
      if (key === "amount") {
        return BigInt(value);
      }
      return value;
    });
  } catch (error) {
    throw new Error(
      `Could not find votemarket v2 bounties file at ${votemarketV2Path}`
    );
  }

  return votemarketV2Bounties;
}

async function fetchAllTokenInfos(
  allTokens: string[]
): Promise<Record<string, TokenInfo>> {
  const tokenInfos: Record<string, TokenInfo> = {};
  for (const tokenInfo of allTokens) {
    const chainId = parseInt(tokenInfo.split(":")[0]);
    const tokenAddress = tokenInfo.split(":")[1];

    tokenInfos[tokenAddress.toLowerCase()] = {
      chainId,
      ...(await getTokenInfo(await getClient(chainId), tokenAddress)),
    };
  }
  return tokenInfos;
}

async function generateReport(): Promise<CSVRow[]> {
  const claimedBounties = await fetchClaimedBounties();

  if (!claimedBounties.balancer) {
    throw new Error("No balancer bounties found");
  }

  const balancerBounties = Object.values(claimedBounties.balancer);
  console.log(`Found ${balancerBounties.length} bounties`);

  const allTokens = new Set<string>(
    balancerBounties.map((bounty) =>
      bounty.isWrapped
        ? "1:" + bounty.rewardToken
        : bounty.chainId + ":" + bounty.rewardToken
    )
  );

  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens));
  const balancerGaugesInfo = await getGaugesInfos("balancer");

  const gaugeMap = new Map(
    balancerGaugesInfo.map((g) => [g.address.toLowerCase(), g.name])
  );

  const rows: CSVRow[] = [];

  // Filter out unknown gauges and log them
  const filteredBounties = balancerBounties.filter((bounty) => {
    const hasGauge = gaugeMap.has(bounty.gauge.toLowerCase());
    if (!hasGauge) {
      console.warn(`Unknown gauge: ${bounty.gauge}`);
    }
    return hasGauge;
  });

  // Process bounties
  for (const bounty of filteredBounties) {
    const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];

    rows.push({
      chainId: tokenInfo.chainId,
      gaugeName: gaugeMap.get(bounty.gauge.toLowerCase()) || "Unknown",
      gaugeAddress: bounty.gauge,
      rewardToken: tokenInfo.symbol,
      rewardAddress: bounty.rewardToken,
      rewardAmount: bounty.amount.toString(),
    });
  }

  return rows;
}

function writeReportToCSV(rows: CSVRow[]) {
  const dirPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });

  // Helper function to create CSV content
  const createCSVContent = (dataRows: CSVRow[]) =>
    [
      "ChainId;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;",
      ...dataRows.map(
        (row) =>
          `${row.chainId};${row.gaugeName};${row.gaugeAddress};${row.rewardToken};${row.rewardAddress};` +
          `${row.rewardAmount};`
      ),
    ].join("\n");

  // Write vlAURA CSV
  const fileName = `vlaura.csv`;
  fs.writeFileSync(path.join(dirPath, fileName), createCSVContent(rows));
  console.log(`Report generated: ${fileName}`);

  // Log summary
  const totalPerToken: Record<string, bigint> = {};
  for (const row of rows) {
    const key = row.rewardToken;
    totalPerToken[key] = (totalPerToken[key] || 0n) + BigInt(row.rewardAmount);
  }

  console.log("\nTotal rewards per token:");
  for (const [token, amount] of Object.entries(totalPerToken)) {
    console.log(`  ${token}: ${amount.toString()}`);
  }
}

async function main() {
  console.log(`Generating vlAURA report for period ${currentPeriod}...`);
  const report = await generateReport();
  writeReportToCSV(report);
}

main().catch(console.error);
