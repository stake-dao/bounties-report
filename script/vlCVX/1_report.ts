import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getTokenInfo, getGaugesInfos } from "../utils/reportUtils";
import { VotemarketBounty, VotemarketV2Bounty } from "../utils/types";
import { clients } from "../utils/constants";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

interface ClaimedBounties {
  votemarket: {
    curve: VotemarketBounty[];
  };
  votemarket_v2: {
    curve: VotemarketV2Bounty[];
  };
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
  const votemarketPath = `weekly-bounties/${currentPeriod}/votemarket/claimed_bounties_convex.json`;
  const votemarketV2Path = `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties_convex.json`;

  let votemarketBounties;
  let votemarketV2Bounties;

  try {
    const votemarketData = fs.readFileSync(votemarketPath, "utf8");
    votemarketBounties = JSON.parse(votemarketData, (key, value) => {
      if (key === "amount") {
        return BigInt(value);
      }
      return value;
    });
  } catch (error) {
    console.warn(
      `Warning: Could not find votemarket bounties file at ${votemarketPath}`
    );
  }

  try {
    const votemarketV2Data = fs.readFileSync(votemarketV2Path, "utf8");
    votemarketV2Bounties = JSON.parse(votemarketV2Data, (key, value) => {
      if (key === "amount") {
        return BigInt(value);
      }
      return value;
    });
  } catch (error) {
    console.warn(
      `Warning: Could not find votemarket v2 bounties file at ${votemarketV2Path}`
    );
  }

  if (!votemarketBounties && !votemarketV2Bounties) {
    throw new Error(
      "Neither votemarket nor votemarket v2 bounties files were found"
    );
  }

  return {
    votemarket: votemarketBounties,
    votemarket_v2: votemarketV2Bounties,
  };
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
      ...(await getTokenInfo(clients[chainId], tokenAddress)),
    };
  }
  return tokenInfos;
}

async function generateReport() {
  const claimedBounties = await fetchClaimedBounties();

  // If both not present, error. If one present, continue with that one.
  if (!claimedBounties.votemarket && !claimedBounties.votemarket_v2) {
    throw new Error("Both votemarket and votemarket v2 bounties are missing");
  }

  const curveBounties = claimedBounties.votemarket?.curve
    ? Object.values(claimedBounties.votemarket.curve)
    : [];
  const curveV2Bounties = claimedBounties.votemarket_v2?.curve
    ? Object.values(claimedBounties.votemarket_v2.curve)
    : [];

  const allTokens = new Set<string>([
    ...curveBounties.map((bounty) => "1:" + bounty.rewardToken),
    ...curveV2Bounties.map((bounty) =>
      bounty.isWrapped
        ? "1:" + bounty.rewardToken
        : bounty.chainId + ":" + bounty.rewardToken
    ),
  ]);

  const tokenInfos = await fetchAllTokenInfos(Array.from(allTokens));

  const gaugesInfo = await getGaugesInfos("curve");

  const gaugeMap = new Map(
    gaugesInfo.map((g) => [g.address.toLowerCase(), g.name])
  );

  const rows: CSVRow[] = [];

  // Filter out unknown gauges and log them
  const allBounties = [...curveBounties, ...curveV2Bounties];
  const filteredBounties = allBounties.filter((bounty) => {
    const hasGauge = gaugeMap.has(bounty.gauge.toLowerCase());
    if (!hasGauge) {
      console.log(`Unknown gauge: ${bounty.gauge}`);
    }
    return hasGauge;
  });

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

  const csvContent = [
    "ChainId;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;",
    ...rows.map(
      (row) =>
        `${row.chainId};${row.gaugeName};${row.gaugeAddress};${row.rewardToken};${row.rewardAddress};` +
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
