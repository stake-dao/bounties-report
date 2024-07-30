import axios from "axios";
import fs from "fs";
import path from "path";
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet } from "viem/chains";
import { getAddress } from "viem";

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
      "Protocol;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
      ...newData.map(
        (row) =>
          `${row.Protocol};` +
          `${row["Gauge Name"]};` +
          `${row["Gauge Address"]};` +
          `${row["Reward Token"]};` +
          `${row["Reward Address"]};` +
          `${row["Reward Amount"].toFixed(6)};` +
          `${row["Reward sd Value"].toFixed(6)};` +
          `${row["Share % per Protocol"].toFixed(2)}`
      ),
    ].join("\n");

    // Retrieve min period and max period (for folder name)
    let minPeriod = Number(Object.keys(latestRewards.resultsByPeriod)[0]);
    let maxPeriod = minPeriod;

    for (const period of Object.keys(latestRewards.resultsByPeriod)) {
      if (Number(period) < minPeriod) {
        minPeriod = Number(period);
      }
      if (Number(period) > maxPeriod) {
        maxPeriod = Number(period);
      }
    }
    const dateMin = new Date(minPeriod * 1000);
    const dateMax = new Date(maxPeriod * 1000);

    function formatDate(date: Date): string {
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const day = date.getDate().toString().padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    const formattedFileName = `${formatDate(dateMin)}_${formatDate(dateMax)}`;

    // Write to file
    const dirPath = path.join(__dirname, "..", "bribes-reports", "pendle");
    fs.mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, `${formattedFileName}.csv`);
    fs.writeFileSync(filePath, csvContent);
    console.log(`Report generated for ${PROTOCOL}: ${filePath}`);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
