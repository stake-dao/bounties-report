import axios from "axios";
import fs from "fs";
import path from "path";
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { getAddress } from "viem";
import moment from "moment";
import { WEEK } from "./utils/constants";

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
  transport: http(),
});

const BOTMARKET = getAddress("0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF");
const sdPENDLE = getAddress("0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

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

async function main() {
  const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

  try {
    // Fetch the repartition of rewards from Pendle scripts repo
    const latestRewards = await getLatestJson(REPO_PATH, DIRECTORY_PATH);

    // SdPendle : Take balanceOf Botmarket
    const sdPendleBalance = await publicClient.readContract({
      address: sdPENDLE,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ],
      functionName: "balanceOf",
      args: [BOTMARKET],
    });

    if (sdPendleBalance === BigInt(0)) {
      console.error("No sdPendle balance found on Botmarket");
      return;
    }

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

          newData.push({
            Protocol: `${PROTOCOL}-${period}`,
            "Gauge Name": gaugeInfo.name,
            "Gauge Address": address,
            "Reward Token": "WETH",
            "Reward Address": WETH,
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
      "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...newData.map(
        (row) =>
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
    const projectRoot = path.resolve(__dirname, "..");
    const dirPath = path.join(
      projectRoot,
      "bounties-reports",
      currentPeriod.toString()
    );
    fs.mkdirSync(dirPath, { recursive: true });

    const filePath = path.join(dirPath, "pendle.csv");
    fs.writeFileSync(filePath, csvContent);

    const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
      "en-GB"
    );
    console.log(`Report generated for Pendle for the week of: ${formattedDate}`);
    console.log(`File saved at: ${filePath}`);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
