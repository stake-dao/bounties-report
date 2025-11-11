import axios from "axios";
import fs from "fs";
import path from "path";
import { createPublicClient, http, formatUnits, pad } from "viem";
import { mainnet } from "../utils/chains";
import { getAddress } from "viem";
import { WEEK, DELEGATION_ADDRESS } from "../utils/constants";
import {
  parseAbiItem,
  decodeEventLog,
  parseAbi,
  keccak256,
  encodePacked,
} from "viem";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import {
  getTimestampsBlocks,
  OTC_REGISTRY,
  getPendleGaugesInfos,
} from "../utils/reportUtils";

const REPO_PATH = "stake-dao/pendle-merkle-script";
const DIRECTORY_PATH = "scripts/data/sdPendle-rewards";
const PROTOCOL = "pendle";

interface GaugeInfo {
  name: string;
  reward: string;
}

interface LatestRewards {
  totalVoterRewards: string;
  resultsByPeriod: {
    [period: string]: {
      [address: string]: GaugeInfo;
    };
  };
}

interface CSVRow {
  Protocol: string;
  Period: string;
  "Gauge Name": string;
  "Gauge Address": string;
  "Reward Token": string;
  "Reward Address": string;
  "Reward Amount": number;
  "Reward sd Value": number;
  "Share % per Protocol": number;
}

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

const BOTMARKET = getAddress("0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF");
const sdPENDLE = getAddress("0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9");
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const explorerUtils = createBlockchainExplorerUtils();

async function getLatestJson(
  repoPath: string,
  directoryPath: string
): Promise<LatestRewards> {
  const url = `https://api.github.com/repos/${repoPath}/contents/${directoryPath}`;
  const response = await axios.get(url);

  if (response.status === 200) {
    const files = response.data;
    let latestFile = null;
    let latestDate = new Date(0);

    for (const file of files) {
      const dateStr = file.name.split("_").pop()!.replace(".json", "");
      const fileDate = new Date(dateStr.split("-").reverse().join("-"));
      if (fileDate > latestDate) {
        latestDate = fileDate;
        latestFile = file as any;
      }
    }
    if (latestFile) {
      const fileContent = await axios.get(
        (latestFile as { download_url: string }).download_url
      );
      return fileContent.data;
    }
  }

  throw new Error("Failed to retrieve latest JSON file");
}

// TEMP: Get second latest file
/*
async function getSecondLatestJson(
  repoPath: string,
  directoryPath: string
): Promise<LatestRewards> {
  const url = `https://api.github.com/repos/${repoPath}/contents/${directoryPath}`;
  const response = await axios.get(url);

  if (response.status === 200) {
    const files = response.data;

    const filesWithDates = files
      .map((file: any) => {
        const dateStr = file.name.split("_").pop()!.replace(".json", "");
        const fileDate = new Date(dateStr.split("-").reverse().join("-"));
        return { file, date: fileDate };
      })
      .sort((a: { file: any; date: Date }, b: { file: any; date: Date }) =>
        b.date.getTime() - a.date.getTime()
      );

    if (filesWithDates.length >= 2) {
      const secondLatestFile = filesWithDates[1].file;
      const fileContent = await axios.get(secondLatestFile.download_url);
      return fileContent.data;
    }

    throw new Error("Not enough files to retrieve second latest");
  }

  throw new Error("Failed to retrieve second latest JSON file");
}
*/
async function getSdPendleTransfers(fromBlock: number, toBlock: number) {
  const transferEventSignature = "Transfer(address,address,uint256)";
  const transferHash = keccak256(
    encodePacked(["string"], [transferEventSignature])
  );

  const transferAbi = parseAbi([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);

  const paddedContractAddress = pad(BOTMARKET as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const topics = {
    "0": transferHash,
    "2": paddedContractAddress,
  };

  const logs = await explorerUtils.getLogsByAddressesAndTopics(
    [sdPENDLE],
    fromBlock,
    toBlock,
    topics,
    1
  );

  if (!logs?.result) return BigInt(0);

  let totalAmount = BigInt(0);
  const TARGET_ADDRESS = getAddress("0xe42a462dbF54F281F95776e663D8c942dcf94f17");
  const ALL_MIGHT = getAddress("0x0000000a3Fc396B89e4c11841B39D9dff85a5D05");
  const VALID_SOURCES = [
    TARGET_ADDRESS.toLowerCase(),
    DELEGATION_ADDRESS.toLowerCase(),
    ALL_MIGHT.toLowerCase() // Include ALL_MIGHT for VM swapped bounties
  ];

  // Group logs by transaction hash
  const txGroups = logs.result.reduce((acc, log) => {
    const txHash = log.transactionHash;
    if (!acc[txHash]) {
      acc[txHash] = [];
    }
    acc[txHash].push(log);
    return acc;
  }, {} as Record<string, typeof logs.result>);

  // Check each transaction to see if it contains transfers from valid sources
  const validTxHashes = new Set<string>();

  // Get all transactions that have sdPENDLE transfers to BOTMARKET
  const allTxHashes = Object.keys(txGroups);

  for (const txHash of allTxHashes) {
    // Get the transaction details to inspect all transfers within it
    const txDetails = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });

    // Check if any log in this transaction is a Transfer from valid sources
    for (const log of receipt.logs) {
      if (log.topics[0] === transferHash && log.topics.length >= 3) {
        try {
          const decodedLog = decodeEventLog({
            abi: transferAbi,
            data: log.data,
            topics: log.topics,
            strict: false,
          });

          if (decodedLog.args.from && VALID_SOURCES.includes(decodedLog.args.from.toLowerCase())) {
            validTxHashes.add(txHash);
            break;
          }
        } catch (error) {
          // Skip logs that don't match Transfer event signature
          continue;
        }
      }
    }
  }

  // Process each transaction
  for (const [txHash, txLogs] of Object.entries(txGroups)) {
    // Only sum transfers if this tx has funds coming from valid sources
    if (validTxHashes.has(txHash)) {
      for (const log of txLogs) {
        const decodedLog = decodeEventLog({
          abi: transferAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });

        totalAmount += decodedLog.args.value;
      }
    }
  }

  return totalAmount;
}

async function main() {
  try {
    const { timestamp1, timestamp2, blockNumber1, blockNumber2, storageTimestamp } =
      await getTimestampsBlocks(publicClient, 0, "ethereum", "pendle");

    const latestRewards = await getLatestJson(REPO_PATH, DIRECTORY_PATH);

    // Get sdPendle transfers to BOTMARKET, excluding OTC transfers
    const sdPendleBalance = await getSdPendleTransfers(
      Number(blockNumber1),
      Number(blockNumber2)
    );

    if (sdPendleBalance === BigInt(0)) {
      console.error("No valid sdPendle transfers found to Botmarket");
      return;
    }

    // Fetch Pendle gauges info to get proper names
    const pendleGaugesInfo = await getPendleGaugesInfos();
    const gaugeNameMap = pendleGaugesInfo.reduce((map, gauge) => {
      map[gauge.address.toLowerCase()] = gauge.name;
      return map;
    }, {} as Record<string, string>);

    const totalVoterRewards = BigInt(latestRewards.totalVoterRewards);
    const newData: CSVRow[] = [];
    let totalRewardAmount = BigInt(0);

    for (const [period, gauges] of Object.entries(
      latestRewards.resultsByPeriod
    )) {
      for (const [address, gaugeInfo] of Object.entries(gauges)) {
        if (gaugeInfo.name !== "vePENDLE") {
          const reward = BigInt(gaugeInfo.reward);
          totalRewardAmount += reward;
          const share = Number(reward) / Number(totalVoterRewards);

          // Use the gauge name from our map if available, otherwise use the one from the rewards data
          const gaugeName =
            gaugeNameMap[address.toLowerCase()] || gaugeInfo.name;

          newData.push({
            Protocol: `${PROTOCOL}`,
            Period: period,
            "Gauge Name": gaugeName,
            "Gauge Address": address,
            "Reward Token": "USDT",
            "Reward Address": USDT,
            "Reward Amount": Number(formatUnits(reward, 18)),
            "Reward sd Value": 0, // Will be computed later
            "Share % per Protocol": share * 100,
          });
        }
      }
    }

    // Normalize Reward Amount
    const scaleFactor = Number(sdPendleBalance) / Number(totalRewardAmount);
    let totalNormalizedAmount = BigInt(0);

    newData.forEach((row) => {
      const normalizedAmount = BigInt(
        Math.floor(row["Reward Amount"] * scaleFactor * 1e18)
      );
      totalNormalizedAmount += normalizedAmount;
      row["Reward sd Value"] = Number(formatUnits(normalizedAmount, 18));
    });

    // Distribute any remaining dust
    const remainingDust = sdPendleBalance - totalNormalizedAmount;
    if (remainingDust > 0) {
      newData[0]["Reward sd Value"] += Number(formatUnits(remainingDust, 18));
    }

    // Recompute shares based on the normalized Reward sd Value
    const totalRewardSdValue = newData.reduce(
      (sum, row) => sum + row["Reward sd Value"],
      0
    );
    newData.forEach((row) => {
      row["Share % per Protocol"] =
        (row["Reward sd Value"] / totalRewardSdValue) * 100;
    });

    // Generate CSV content
    const csvContent = [
      "Period;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...newData.map(
        (row) =>
          `${row["Period"]};` +
          `${row["Gauge Name"]};` +
          `${row["Gauge Address"]};` +
          `${row["Reward Token"]};` +
          `${row["Reward Address"]};` +
          `${row["Reward Amount"].toFixed(6)};` +
          `${row["Reward sd Value"].toFixed(6)};` +
          `${row["Share % per Protocol"].toFixed(2)}`
      ),
    ].join("\n");

    // Write to file
    // Use storageTimestamp (Thursday epoch) for directory path to match GitHub bounty JSONs
    // Use timestamp1 (Tuesday search start) for logging/display purposes
    const projectRoot = path.resolve(__dirname, "..", "..");
    const dirPath = path.join(
      projectRoot,
      "bounties-reports",
      storageTimestamp.toString()
    );
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = path.join(dirPath, "pendle.csv");
    fs.writeFileSync(filePath, csvContent);

    const formattedDate = new Date(timestamp1 * 1000).toLocaleDateString(
      "en-GB"
    );
    console.log(
      `Report generated for Pendle for the week of: ${formattedDate}`
    );
    console.log(`File saved at: ${filePath}`);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
