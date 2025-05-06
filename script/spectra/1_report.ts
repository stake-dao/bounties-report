import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSpectraDistribution, SpectraClaimed } from "./utils";
import { ALL_MIGHT, escapeCSV, fetchAllTokenInfos, fetchSwapInEvents, fetchSwapOutEvents, getTimestampsBlocks, processSwaps, PROTOCOLS_TOKENS } from "../utils/reportUtils";
import { clients } from "../utils/constants";
import processReport from "../reports/reportCommon";

dotenv.config();

const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

function writeReportToCSV(rows: SpectraClaimed[]) {
  const dirPath = path.join(
    __dirname,
    "..",
    "..",
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });

  const csvContent = [
    "Gauge Name;Pool Address;Reward Token;Reward Address;Reward Amount;",
    ...rows.map(
      (row) =>
        `${row.name};${row.poolAddress};${row.tokenRewardSymbol};${row.tokenRewardAddress};${row.amount.toString()};`
    ),
  ].join("\n");

  const fileName = `spectra.csv`;
  fs.writeFileSync(path.join(dirPath, fileName), csvContent);
  console.log(`Report generated for Spectra: ${fileName}`);
}

async function main() {

  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    clients[8453],
    0,
    "base"
  );

  const firstReport = await getSpectraDistribution();

  // Transform the firstReport to the following format

  const aggregatedBounties = {
    spectra: firstReport.map((claim) => ({
      chainId: 8453,
      bountyId: claim.poolId.toString(),
      gauge: claim.poolAddress,
      amount: claim.amount.toString(),
      rewardToken: claim.tokenRewardAddress,
      gaugeName: claim.name,
    })),
  };

  /*
  [
  {
    tokenRewardAddress: '0x64FCC3A02eeEba05Ef701b7eed066c6ebD5d4E51',
    poolAddress: '0x71F5B68188097A36D5604c3783B600bC7102F4aC',
    poolId: 6.50595538190023e+47,
    chainId: 42161,
    amount: 5426989871486680305533n,
    name: 'arbitrumone-sUSDX-07/08/2025',
    tokenRewardSymbol: 'SPECTRA'
  },
  ]
  */

  /*
    {
    "balancer":[
        {
          "chainId":42161,
          "bountyId":"2",
          "gauge":"0xDc2Df969EE5E66236B950F5c4c5f8aBe62035df2",
          "amount":"2359326722803469137242",
          "rewardToken":"0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F",
          "isWrapped":true,
          "gaugeName":"B-sdBAL-STABLE"
        },
        {
          "chainId":42161,
          "bountyId":"3",
          "gauge":"0xDc2Df969EE5E66236B950F5c4c5f8aBe62035df2",
          "amount":"2359326722803469137242",
          "rewardToken":"0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F",
          "isWrapped":true,
          "gaugeName":"B-sdBAL-STABLE"
        },
        {
          "gauge":"0x275df57d2b23d53e20322b4bb71bf1dcb21d0a00",
          "amount":1.9614691469660536e+21,
          "rewardToken":"0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
          "gaugeName":"50WETH-50AURA"
        },
        {
          "gauge":"0x0312aa8d0ba4a1969fddb382235870bf55f7f242",
          "amount":2.797764505885564e+21,
          "rewardToken":"0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
          "gaugeName":"B-auraBAL-STABLE"
        },
        {
          "gauge":"0x0d1b58fb1fc10f2160178de1eae2d520335ee372",
          "amount":113540359.76482892,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"sUSDX/USDX"
        },
        {
          "gauge":"0xf8a95653cc7ee59afa2304dcc518c431a15c292c",
          "amount":185243046.37261477,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"rETH/wETH BPT"
        },
        {
          "gauge":"0x1e916950a659da9813ee34479bff04c732e03deb",
          "amount":429454508.40873593,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"sAVAX-WAVAX-BPT"
        },
        {
          "gauge":"0x9965713498c74aee49cef80b2195461f188f24f8",
          "amount":289784365.9586953,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"maticX-WMATIC-BPT"
        },
        {
          "gauge":"0xd75026f8723b94d9a360a282080492d905c6a558",
          "amount":102879876.31546296,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"rETH-WETH-BPT"
        },
        {
          "gauge":"0xf8c85bd74fee26831336b51a90587145391a27ba",
          "amount":966714347.0402507,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"bb-WETH-wstETH"
        },
        {
          "gauge":"0x79ef6103a513951a3b25743db509e267685726b7",
          "amount":2251878050.327056,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"B-rETH-STABLE"
        },
        {
          "gauge":"0x5c0f23a5c1be65fa710d385814a7fd1bda480b1c",
          "amount":476964532.3230409,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"wstETH-WETH-BPT"
        },
        {
          "gauge":"0xf720e9137baa9c7612e6ca59149a5057ab320cfa",
          "amount":445481575.48931515,
          "rewardToken":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          "gaugeName":"GHO/USDT/USDC"
        }
    ]
  }
  */
  const protocolTokens = { spectra: PROTOCOLS_TOKENS.spectra };
  const allTokens = new Set<string>();
  for (const claim of firstReport) {
    allTokens.add(claim.tokenRewardAddress);
  }
  allTokens.add(protocolTokens.spectra.sdToken);
  allTokens.add(protocolTokens.spectra.native);
  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    clients[8453]
  );

  // Fetch swap events
  const swapIn = await fetchSwapInEvents(
    8453,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );
  const swapOut = await fetchSwapOutEvents(
    8453,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );


  // Process swaps
  const processedSwapIn = processSwaps(swapIn, tokenInfos);
  const processedSwapOut = processSwaps(swapOut, tokenInfos);

  const processedReport = processReport(
    8453,
    processedSwapIn,
    processedSwapOut,
    aggregatedBounties,
    tokenInfos,
    []
  );

  console.log(firstReport);

  // Generate CSV reports in the designated directory
  const projectRoot = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(
    projectRoot,
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });
  const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
    "en-GB"
  );
  console.log("Generating reports for the week of:", formattedDate);

  for (const [protocol, rows] of Object.entries(processedReport)) {
    const csvContent = [
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...rows.map(
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
    console.log(`Report generated for ${protocol}: ${fileName}`);
  }
}

main().catch(console.error);
