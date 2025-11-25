import fs from "fs";
import path from "path";
import { formatUnits } from "viem";
import dotenv from "dotenv";
import {
  getTimestampsBlocks,
  PROTOCOLS_TOKENS,
  aggregateBounties,
  collectAllTokens,
  fetchAllTokenInfos,
  escapeCSV,
  addGaugeNamesToBounties,
  getGaugesInfos,
} from "../utils/reportUtils";
import { getClient } from "../utils/getClients";
import { getSdFXSTransfersOnFraxtal } from "./fraxtalFetcher";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

interface ClaimedBounties {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket: Record<string, any>;
  votemarket_v2: Record<string, any>;
  warden: Record<string, any>;
  hiddenhand: Record<string, any>;
}

// Define raw tokens that should be distributed as-is without wrapping
const RAW_TOKENS = new Set([
  "0x4DF454443D6e9A888e9B1571B2375e8Ab4118d9d".toLowerCase(),
]);

/**
 * Reads claimed bounties from JSON files and filters the v2 bounties.
 */
async function fetchBountiesData(
  currentPeriod: number
): Promise<ClaimedBounties> {
  const paths = {
    votemarket: `weekly-bounties/${currentPeriod}/votemarket/claimed_bounties.json`,
    votemarket_v2: `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties.json`,
    warden: `weekly-bounties/${currentPeriod}/warden/claimed_bounties.json`,
    hiddenhand: `weekly-bounties/${currentPeriod}/hiddenhand/claimed_bounties.json`,
  };

  const readJsonFile = (filePath: string) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.warn(`Warning: Could not read ${filePath}`, error);
      return {};
    }
  };

  const votemarket = readJsonFile(paths.votemarket);
  const votemarket_v2 = readJsonFile(paths.votemarket_v2);
  const warden = readJsonFile(paths.warden);
  const hiddenhand = readJsonFile(paths.hiddenhand);

  // Filter out v2 bounties that are explicitly unwrapped
  const filteredV2 = Object.entries(votemarket_v2).reduce(
    (acc, [key, value]: [string, any]) => {
      if (value.isWrapped !== false) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, any>
  );

  return {
    timestamp1: votemarket.timestamp1 || 0,
    timestamp2: votemarket.timestamp2 || 0,
    blockNumber1: votemarket.blockNumber1 || 0,
    blockNumber2: votemarket.blockNumber2 || 0,
    votemarket,
    votemarket_v2: filteredV2,
    warden,
    hiddenhand,
  };
}

/**
 * Separates raw token bounties from regular bounties
 */
function separateRawTokenBounties(bounties: Record<string, any>): {
  regular: Record<string, any>;
  raw: Record<string, any>;
} {
  const regular: Record<string, any> = {};
  const raw: Record<string, any> = {};

  for (const [protocol, protocolBounties] of Object.entries(bounties)) {
    regular[protocol] = {};
    raw[protocol] = {};

    for (const [key, bounty] of Object.entries(protocolBounties as Record<string, any>)) {
      if (bounty.rewardToken && RAW_TOKENS.has(bounty.rewardToken.toLowerCase())) {
        raw[protocol][key] = bounty;
      } else {
        regular[protocol][key] = bounty;
      }
    }
  }

  return { regular, raw };
}

/**
 * Processes raw token bounties into CSV format
 */
function processRawTokenBounties(
  rawBounties: Record<string, any>,
  tokenInfos: Record<string, any>,
  gaugesInfo?: Array<any>
): Record<string, Array<{
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardRawValue: number;
}>> {
  const result: Record<string, Array<any>> = {};

  for (const [protocol, protocolBounties] of Object.entries(rawBounties)) {
    if (!result[protocol]) {
      result[protocol] = [];
    }

    for (const bounty of Object.values(protocolBounties as Record<string, any>)) {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];

      // Find gauge name and actual gauge address from gaugesInfo array
      let gaugeName = bounty.gauge;
      let gaugeAddress = bounty.gauge;
      if (gaugesInfo) {
        const gaugeInfo = gaugesInfo.find(
          (g: any) => g.address.toLowerCase() === bounty.gauge.toLowerCase()
        );
        if (gaugeInfo) {
          gaugeName = gaugeInfo.name;
          // If this bounty was claimed through a rootGauge, use the actual gauge address
          gaugeAddress = gaugeInfo.actualGauge || bounty.gauge;
        }
      }

      const amount = Number(bounty.amount) / Math.pow(10, tokenInfo?.decimals || 18);

      result[protocol].push({
        gaugeName,
        gaugeAddress,
        rewardToken: tokenInfo?.symbol || "UNKNOWN",
        rewardAddress: bounty.rewardToken,
        rewardAmount: amount,
        rewardRawValue: amount, // For raw tokens, the value is the same as the amount
      });
    }
  }

  return result;
}

// TODO: Fetch swaps on mainnet to not rely on usd values (can be wrong in case of price changes)
async function main() {
  const protocol = "frax";
  const publicClient = await getClient(1);

  // Get block numbers and timestamps
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    publicClient,
    0
  );

  // Fetch sdFXS amount from Fraxtal
  console.log("Fetching sdFXS transfers on Fraxtal...");
  const sdFxsTransfers = await getSdFXSTransfersOnFraxtal(currentPeriod);
  const totalSdFxsAmount = Number(formatUnits(sdFxsTransfers.amount, 18));
  console.log(`Total sdFXS amount for distribution: ${totalSdFxsAmount}`);

  const totalBounties = await fetchBountiesData(currentPeriod);
  let aggregatedBounties = aggregateBounties(totalBounties);

  // Separate raw token bounties from regular bounties
  const { regular: regularBounties, raw: rawBounties } = separateRawTokenBounties(aggregatedBounties);

  // Keep bounties only for frax protocol
  aggregatedBounties = { [protocol]: regularBounties[protocol] };
  const rawProtocolBounties = { [protocol]: rawBounties[protocol] };

  // Collect tokens and fetch their info (including raw tokens)
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };

  // Convert aggregatedBounties back to array format for collectAllTokens
  const aggregatedBountiesForTokens: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesForTokens[p] = Object.values(bounties || {});
  }

  const allTokens = collectAllTokens(aggregatedBountiesForTokens, protocolTokens);

  // Add raw tokens to the set
  for (const protocolRawBounties of Object.values(rawProtocolBounties)) {
    for (const bounty of Object.values(protocolRawBounties as Record<string, any>)) {
      if (bounty.rewardToken) {
        allTokens.add(bounty.rewardToken.toLowerCase());
      }
    }
  }

  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );

  // Fetch gauge infos
  const gaugesInfo = await getGaugesInfos("frax");

  // Convert aggregatedBounties to array format
  const aggregatedBountiesArray: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesArray[p] = Object.values(bounties || {});
  }

  if (gaugesInfo) {
    aggregatedBountiesArray[protocol] = addGaugeNamesToBounties(
      aggregatedBountiesArray[protocol],
      gaugesInfo
    );
  }

  // Fetch token prices for the period
  console.log("Fetching token prices...");
  const tokenPrices: Record<string, number> = {};

  // Get unique token addresses
  const uniqueTokens = new Set<string>();
  for (const bounty of aggregatedBountiesArray[protocol] || []) {
    uniqueTokens.add(bounty.rewardToken.toLowerCase());
  }

  // Fetch prices for all tokens
  const { getHistoricalTokenPrice } = await import("../utils/utils");
  for (const tokenAddress of uniqueTokens) {
    try {
      const price = await getHistoricalTokenPrice(
        currentPeriod,
        "ethereum", // Most bounty tokens are on mainnet
        tokenAddress
      );
      tokenPrices[tokenAddress] = price;
      console.log(`Price for ${tokenInfos[tokenAddress]?.symbol || tokenAddress}: $${price}`);
    } catch (error) {
      console.warn(`Could not fetch price for ${tokenAddress}, using 0`);
      tokenPrices[tokenAddress] = 0;
    }
  }

  // Calculate total bounty value in USD
  let totalBountyValueUSD = 0;
  const bountyValues: Map<any, number> = new Map();

  for (const bounty of aggregatedBountiesArray[protocol] || []) {
    const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
    const amount = Number(bounty.amount) / Math.pow(10, tokenInfo?.decimals || 18);
    const price = tokenPrices[bounty.rewardToken.toLowerCase()] || 0;
    const usdValue = amount * price;

    bountyValues.set(bounty, usdValue);
    totalBountyValueUSD += usdValue;

    console.log(`Bounty ${bounty.bountyId}: ${amount.toFixed(4)} ${tokenInfo?.symbol} = $${usdValue.toFixed(2)}`);
  }

  console.log(`Total bounty value: $${totalBountyValueUSD.toFixed(2)}`);

  // Generate CSV reports
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });

  // Create raw subdirectory for raw token reports
  const rawDirPath = path.join(dirPath, "raw");
  if (Object.keys(rawProtocolBounties).some(p => rawProtocolBounties[p] && Object.keys(rawProtocolBounties[p]).length > 0)) {
    fs.mkdirSync(rawDirPath, { recursive: true });
  }

  const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
    "en-GB"
  );
  console.log("Generating reports for the week of:", formattedDate);

  // Generate CSV for frax with sdFXS distribution based on USD values
  const csvRows: any[] = [];
  for (const bounty of aggregatedBountiesArray[protocol] || []) {
    const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];
    const rewardAmount = Number(bounty.amount) / Math.pow(10, tokenInfo?.decimals || 18);

    // Get USD value for this bounty
    const usdValue = bountyValues.get(bounty) || 0;

    // Calculate sdFXS value proportionally based on USD value
    const shareOfTotal = totalBountyValueUSD > 0 ? usdValue / totalBountyValueUSD : 0;
    const sdFxsValue = totalSdFxsAmount * shareOfTotal;
    const sharePercentage = shareOfTotal * 100;

    csvRows.push({
      gaugeName: bounty.gaugeName || bounty.gauge,
      gaugeAddress: bounty.gauge,
      rewardToken: tokenInfo?.symbol || "UNKNOWN",
      rewardAddress: bounty.rewardToken,
      rewardAmount: rewardAmount,
      rewardSdValue: sdFxsValue,
      sharePercentage: sharePercentage,
      usdValue: usdValue // For debugging/transparency
    });
  }

  // Sort by share percentage descending
  csvRows.sort((a, b) => b.sharePercentage - a.sharePercentage);

  // Generate CSV content
  const csvContent = [
    "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
    ...csvRows.map(
      (row) =>
        `${escapeCSV(row.gaugeName)};${escapeCSV(
          row.gaugeAddress
        )};${escapeCSV(row.rewardToken)};` +
        `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(
          6
        )};${row.rewardSdValue.toFixed(6)};` +
        `${row.sharePercentage.toFixed(2)}`
    ),
  ].join("\n");

  const fileName = `${protocol}.csv`;
  fs.writeFileSync(path.join(dirPath, fileName), csvContent);
  console.log(`\nReport generated for ${protocol}: ${fileName}`);
  console.log(`Total sdFXS distributed: ${totalSdFxsAmount}`);
  console.log(`Total bounty value: $${totalBountyValueUSD.toFixed(2)}`);

  // Log top bounties by USD value
  console.log("\nTop bounties by USD value:");
  csvRows
    .sort((a, b) => b.usdValue - a.usdValue)
    .slice(0, 5)
    .forEach((row, index) => {
      console.log(`${index + 1}. ${row.gaugeName}: $${row.usdValue.toFixed(2)} (${row.sharePercentage.toFixed(2)}% → ${row.rewardSdValue.toFixed(4)} sdFXS)`);
    });

  // Generate raw token CSV reports
  const rawTokenReport = processRawTokenBounties(rawProtocolBounties, tokenInfos, gaugesInfo);
  for (const [protocol, rows] of Object.entries(rawTokenReport)) {
    if (rows && rows.length > 0) {
      const rawCsvContent = [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount",
        ...rows.map(
          (row) =>
            `${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(6)}`
        ),
      ].join("\n");

      const rawFileName = `${protocol}.csv`;
      const protocolRawDir = path.join(rawDirPath, protocol);
      fs.mkdirSync(protocolRawDir, { recursive: true });
      fs.writeFileSync(path.join(protocolRawDir, rawFileName), rawCsvContent);
      console.log(`Raw token report generated for ${protocol}: raw/${protocol}/${rawFileName}`);
    }
  }
}

main().catch(console.error);