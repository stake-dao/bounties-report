import fs from "fs";
import path from "path";
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import dotenv from "dotenv";
import { getTokenInfo, getGaugesInfos } from "../utils/reportUtils";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

interface Bounty {
  bountyId: string;
  gauge: string;
  amount: string;
  rewardToken: string;
}

interface ClaimedBounties {
  votemarket: {
    curve: Record<string, Bounty>;
  };
}

interface TokenInfo {
  symbol: string;
  decimals: number;
}

interface CSVRow {
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: string;
}

async function fetchClaimedBounties(): Promise<ClaimedBounties> {
  const claimedBountiesPath = `weekly-bounties/${currentPeriod}/claimed_bounties_convex.json`;
  return JSON.parse(fs.readFileSync(claimedBountiesPath, "utf8"));
}

async function fetchAllTokenInfos(
  allTokens: string[]
): Promise<Record<string, TokenInfo>> {
  const tokenInfos: Record<string, TokenInfo> = {};
  for (const token of allTokens) {
    tokenInfos[token.toLowerCase()] = await getTokenInfo(publicClient, token);
  }
  return tokenInfos;
}

async function generateReport() {
  const claimedBounties = await fetchClaimedBounties();
  const curveBounties = Object.values(claimedBounties.votemarket.curve);

  const allTokens = new Set<string>(
    curveBounties.map((bounty) => bounty.rewardToken)
  );
  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens));

  const gaugesInfo = await getGaugesInfos("curve");
  const gaugeMap = new Map(
    gaugesInfo.map((g) => [g.address.toLowerCase(), g.name])
  );

  const rows: CSVRow[] = [];

  for (const bounty of curveBounties) {
    const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
    const formattedAmount = formatUnits(
      BigInt(bounty.amount),
      tokenInfo.decimals
    );

    rows.push({
      gaugeName: gaugeMap.get(bounty.gauge.toLowerCase()) || "Unknown",
      gaugeAddress: bounty.gauge,
      rewardToken: tokenInfo.symbol,
      rewardAddress: bounty.rewardToken,
      rewardAmount: formattedAmount,
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

  const csvContent = [
    "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;",
    ...rows.map(
      (row) =>
        `${row.gaugeName};${row.gaugeAddress};${row.rewardToken};${row.rewardAddress};` +
        `${row.rewardAmount};`
    ),
  ].join("\n");

  const fileName = `cvx.csv`;
  fs.writeFileSync(path.join(dirPath, fileName), csvContent);
  console.log(`Report generated for Curve Convex: ${fileName}`);
}

async function main() {
  const report = await generateReport();
  writeReportToCSV(report);
}

main().catch(console.error);
