import axios from "axios";
import * as dotenv from "dotenv";
import {
  fetchLastProposalsIds,
  fetchProposalsIdsBasedOnExactPeriods,
} from "../utils/snapshot";
import {
  abi,
  NETWORK_TO_MERKLE,
  NETWORK_TO_STASH,
  SDPENDLE_SPACE,
  SPACE_TO_NETWORK,
  SPACES,
  SPACES_IMAGE,
  SPACES_SYMBOL,
  SPACES_TOKENS,
  SPACES_UNDERLYING_TOKEN,
  WEEK,
} from "../utils/constants";
import * as moment from "moment";
import {
  checkSpace,
  extractCSV,
  extractOTCCSV,
  getAllAccountClaimedSinceLastFreeze,
  PendleCSVType,
} from "../utils/utils";
import { createMerkle } from "../utils/createMerkle";
import {
  Chain,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
} from "viem";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { ethers } from "ethers";
import { bsc, mainnet } from "viem/chains";
import { Merkle } from "../utils/types";

dotenv.config();

const logData: Record<string, any> = {
  TotalReported: {},
  Transactions: [],
  SnapshotIds: [],
}; // Used to store logs in a JSON file

const convertToProperHex = (value: any): string => {
  if (value?.type === "BigNumber" && value?.hex) {
    const hexValue = value.hex.startsWith("0x") ? value.hex : `0x${value.hex}`;
    return hexValue;
  }
  if (BigNumber.isBigNumber(value)) {
    return value.toHexString();
  }
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`;
  }
  if (typeof value === "number") {
    return `0x${value.toString(16)}`;
  }
  return value.hex || "0x0";
};

const main = async () => {
  const now = moment.utc().unix();
  const filter: string = "*Gauge vote.*$";

  const [
    { data: lastMerkles },
    proposalIdPerSpace,
    { data: delegationAPRs },
    { data: sdFXSWorkingData },
    { data: sdCakeWorkingData },
  ] = await Promise.all([
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/bounties-report/main/bounties-reports/latest/merkle.json"
    ),
    fetchLastProposalsIds(SPACES, now, filter),
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/bounties-report/main/bounties-reports/latest/delegationsAPRs.json"
    ),
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/lockers/sdfxs-working-supply.json"
    ),
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/lockers/sdcake-working-supply.json"
    ),
  ]);

  const delegationAPRsClone = { ...delegationAPRs };
  for (const key of Object.keys(delegationAPRs)) {
    delegationAPRs[key] = -1;
  }

  const newMerkles: Merkle[] = [];
  const toFreeze: Record<string, string[]> = {};
  const toSet: Record<string, string[]> = {};
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Loop through each space (except Pendle, handled separately)
  for (const space of Object.keys(proposalIdPerSpace)) {
    checkSpace(
      space,
      SPACES_SYMBOL,
      SPACES_IMAGE,
      SPACES_UNDERLYING_TOKEN,
      SPACES_TOKENS,
      SPACE_TO_NETWORK,
      NETWORK_TO_STASH,
      NETWORK_TO_MERKLE
    );

    // Skip if no CSV data for this space.
    const csvResult = await extractCSV(currentPeriodTimestamp, space);
    const isPendle = space === SDPENDLE_SPACE;
    const network = SPACE_TO_NETWORK[space];

    // For Pendle, we need to check OTC even if there's no regular report
    if (!csvResult && !isPendle) {
      continue;
    }

    let totalSDToken = 0;
    let ids: string[] = [];
    let pendleRewards: Record<string, Record<string, number>> | undefined = undefined;

    if (isPendle) {
      // Initialize pendleRewards
      pendleRewards = {};


      // Process regular report if it exists
      if (csvResult) {
        let proposalsPeriods = await fetchProposalsIdsBasedOnExactPeriods(
          space,
          Object.keys(csvResult),
          currentPeriodTimestamp
        );

        for (const period of Object.keys(csvResult)) {
          const proposalId = proposalsPeriods[period];
          const periodRewards = (csvResult as PendleCSVType)[period];
          if (!pendleRewards[proposalId]) {
            pendleRewards[proposalId] = {};
          }
          for (const address in periodRewards) {
            pendleRewards[proposalId][address] = (pendleRewards[proposalId][address] || 0) + periodRewards[address];
          }
          totalSDToken += Object.values(periodRewards).reduce(
            (acc, amount) => acc + amount,
            0
          );
        }
      }

      // Process OTC report
      const otcCsvPath = path.join(
        __dirname,
        "..",
        "..",
        "bounties-reports",
        currentPeriodTimestamp.toString(),
        "pendle-otc.csv"
      );

      if (fs.existsSync(otcCsvPath)) {
        const otcCsvResult: Record<string, Record<string, number>> = await extractOTCCSV(otcCsvPath);
        const otcTimestamps = Object.keys(otcCsvResult);
        let proposalsPeriodsOTC: Record<string, string> = {};

        // Fetch OTC proposals
        proposalsPeriodsOTC = await fetchProposalsIdsBasedOnExactPeriods(
          space,
          otcTimestamps,
          currentPeriodTimestamp
        );

        // Merge OTC rewards into pendleRewards and add to total
        for (const timestamp of otcTimestamps) {
          const proposalId = proposalsPeriodsOTC[timestamp];
          if (!pendleRewards[proposalId]) {
            pendleRewards[proposalId] = {};
          }
          const rewards = otcCsvResult[timestamp];
          for (const address in rewards) {
            pendleRewards[proposalId][address] =
              (pendleRewards[proposalId][address] || 0) + rewards[address];
            totalSDToken += rewards[address]; // Add OTC rewards to total
          }
        }
      }

      // Only process if we have either regular or OTC rewards
      if (Object.keys(pendleRewards).length === 0) {
        continue;
      }

      ids = Object.keys(pendleRewards);
    } else if (csvResult) {
      totalSDToken = Object.values(csvResult).reduce(
        (acc, amount) => acc + amount,
        0
      );
      ids = [proposalIdPerSpace[space]];
    }

    // Save using the token symbol as key
    logData["TotalReported"][SPACES_SYMBOL[space]] = totalSDToken;

    logData["SnapshotIds"].push({
      space,
      ids,
    });

    // Create the merkle for this space.
    const merkleStat = await createMerkle(
      ids,
      space,
      lastMerkles,
      csvResult,
      pendleRewards,
      sdFXSWorkingData,
      sdCakeWorkingData,
      {}
    );

    newMerkles.push(merkleStat.merkle);

    if (!toFreeze[network]) {
      toFreeze[network] = [];
    }
    if (!toSet[network]) {
      toSet[network] = [];
    }
    toFreeze[network].push(merkleStat.merkle.address);
    toSet[network].push(merkleStat.merkle.root);

    delegationAPRs[space] = merkleStat.apr;

    for (const log of merkleStat.logs) {
      if (!logData[log.id]) {
        logData[log.id] = [];
      }
      logData[log.id] = logData[log.id].concat(log.content);
    }
  }

  for (const network of Object.keys(toFreeze)) {
    let multiSetName: undefined | string = undefined;
    if (network === "ethereum") {
      multiSetName = "multiSet";
    } else {
      multiSetName = "multiUpdateMerkleRoot";
    }

    const freezeData = encodeFunctionData({
      abi,
      functionName: "multiFreeze",
      args: [toFreeze[network] as `0x${string}`[]],
    });

    const multiSetData = encodeFunctionData({
      abi,
      functionName: multiSetName as any,
      args: [
        toFreeze[network] as `0x${string}`[],
        toSet[network] as `0x${string}`[],
      ],
    });

    logData["Transactions"].push({
      network: network,
      tokenAddressesToFreeze: toFreeze[network],
      newMerkleRoots: toSet[network],
      toFreeze: {
        contract: NETWORK_TO_STASH[network],
        data: freezeData,
      },
      toSet: {
        contract: NETWORK_TO_STASH[network],
        function: multiSetName,
        data: multiSetData,
      },
    });
  }

  for (const lastMerkle of lastMerkles) {
    let found = false;
    for (const newMerkle of newMerkles) {
      if (
        newMerkle.address.toLowerCase() === lastMerkle.address.toLowerCase()
      ) {
        found = true;
        break;
      }
    }
    if (!found) {
      newMerkles.push(lastMerkle);
    }
  }

  // Check if the tokens in the merkle contract plus the new tokens to distribute
  // are at least the total expected (with a small threshold)
  const isDistributionOk = await checkDistribution(newMerkles, logData);

  if (!isDistributionOk) {
    throw new Error("Distribution is not ok");
  }

  fs.writeFileSync(
    `./bounties-reports/${currentPeriodTimestamp}/merkle.json`,
    JSON.stringify(newMerkles)
  );

  for (const key of Object.keys(delegationAPRs)) {
    if (delegationAPRs[key] === -1) {
      delegationAPRs[key] = delegationAPRsClone[key] || 0;
    }
  }
  fs.writeFileSync(
    `./bounties-reports/${currentPeriodTimestamp}/delegationsAPRs.json`,
    JSON.stringify(delegationAPRs)
  );
  fs.writeFileSync(`delegationsAPRs.json`, JSON.stringify(delegationAPRs)); // TODO : Remove , adapt the logger to fetch from current period

  // Add delegation APRS in logData
  logData["DelegationsAPRsDetails"] = delegationAPRs;

  // Add totals in the log
  logData["TotalRewards"] = {};
  for (const merkle of newMerkles) {
    if (merkle.symbol === "sdMAV") {
      continue;
    }
    const amount = parseFloat(
      formatUnits(BigInt(BigNumber.from(merkle.total).toString()), 18)
    );
    if (amount > 0) {
      logData["TotalRewards"][merkle.symbol] = amount;
    }
  }

  // Add full file paths to the log
  logData["Merkle"] = path.join(__dirname, "..", "merkle.json");
  logData["DelegationsAPRs"] = path.join(
    __dirname,
    "..",
    "..",
    "delegationsAPRs.json"
  );

  // Write here if no --log, else write after the comparison
  if (!process.argv.includes("--log")) {
    const logPath = path.join(__dirname, "..", "..", "log.json");
    fs.writeFileSync(logPath, JSON.stringify(logData));
    process.stdout.write(logPath + "\n");
  }

  // Compare merkle trees and log the distribution details.
  // Run the merkle check only if the --log flag is passed.
  if (process.argv.includes("--log")) {
    // Write comparison output to stderr
    const comparisonOutput = await compareMerkleTrees(
      newMerkles,
      lastMerkles,
      logData
    );
    process.stderr.write(comparisonOutput);
  }
};

/**
 * Check, for each token, that the tokens held in the Merkle contract plus
 * the tokens slated for distribution are not less than the total expected.
 */
const checkDistribution = async (
  newMerkles: Merkle[],
  logData: Record<string, any>
): Promise<boolean> => {
  if (!logData || !logData["TotalReported"]) {
    throw new Error("Total reported does not exist in log");
  }

  // Now TotalReported is keyed by token symbol.
  for (const tokenSymbol of Object.keys(logData["TotalReported"])) {
    const amountToDistribute = logData["TotalReported"][tokenSymbol];

    // Find the merkle object using token symbol.
    const merkle = newMerkles.find((merkle) => merkle.symbol === tokenSymbol);
    if (!merkle) {
      throw new Error("Merkle object not found for token " + tokenSymbol);
    }

    const totalAmount = parseFloat(
      formatUnits(BigInt(BigNumber.from(merkle.total).toString()), 18)
    );

    let chain: Chain | null = null;
    let rpcUrl = "";

    switch (merkle.chainId) {
      case mainnet.id:
        chain = mainnet;
        rpcUrl =
          "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
        break;
      case bsc.id:
        chain = bsc;
        rpcUrl =
          "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
        break;
      default:
        throw new Error("Chain not found");
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    // Check if the token is frozen.
    const merkleRootRes = await publicClient.readContract({
      address: merkle.merkleContract as any,
      abi: [
        {
          inputs: [{ internalType: "address", name: "", type: "address" }],
          name: "merkleRoot",
          outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
          stateMutability: "view",
          type: "function",
        },
      ],
      functionName: "merkleRoot",
      args: [merkle.address as `0x${string}`],
    });

    if (
      merkleRootRes ===
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      continue;
    }

    const sdTknBalanceBn = await publicClient.readContract({
      address: merkle.address as any,
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
      args: [merkle.merkleContract as `0x${string}`],
    });

    const sdTknBalanceInMerkle = parseFloat(formatUnits(sdTknBalanceBn, 18));

    // Allow a small threshold of 0.01
    if (sdTknBalanceInMerkle + amountToDistribute < totalAmount - 0.01) {
      console.error("Distribution is not ok for token " + tokenSymbol);
      console.error(
        "Difference",
        totalAmount - (sdTknBalanceInMerkle + amountToDistribute)
      );
      return false;
    }
  }

  return true;
};

async function compareMerkleTrees(
  newMerkles: any[],
  lastMerkles: any[],
  logData: Record<string, any>
): Promise<string> {
  if (!logData || !logData["TotalReported"]) {
    throw new Error("Total reported does not exist in logData");
  }

  logData["DistributionSurplus"] = {};
  logData["MerkleRoots"] = [];
  logData["ActiveUsers"] = {};
  logData["TotalHolders"] = {};
  logData["ClaimedSinceLastDistrib"] = {};
  logData["TopHolders"] = {};

  let output = "\nComparing Merkle Trees:\n";

  for (const merkle of newMerkles) {
    output += "\n" + "=".repeat(80) + "\n";
    output += `Distribution Details for ${merkle.symbol}\n`;

    // Fallbacks: if chainId or merkleContract are missing, default to mainnet and use token address.
    const chainId = merkle.chainId || mainnet.id;
    const merkleContractAddress = merkle.merkleContract || merkle.address;
    output += `Chain ID: ${chainId}\n`;
    output += `Token Address: ${merkle.address}\n`;
    output += `Merkle Contract: ${merkleContractAddress}\n`;
    output += `Root: ${merkle.root}\n`;

    // Find the previous snapshot.
    const prevMerkle = lastMerkles.find(
      (m: any) => m.address.toLowerCase() === merkle.address.toLowerCase()
    );

    // Weekly Reported Reward from logData (in token units).
    const weeklyReportedReward = logData["TotalReported"][merkle.symbol] || 0;

    if (!prevMerkle) {
      output += "\nNEW DISTRIBUTION\n";
      output += `Weekly Reported Reward: ${weeklyReportedReward.toFixed(2)} ${
        merkle.symbol
      }\n`;
      continue;
    }

    // Set up blockchain client details.
    let chain: Chain | null = null;
    let rpcUrl = "";
    switch (chainId) {
      case mainnet.id:
        chain = mainnet;
        rpcUrl =
          "https://lb.drpc.org/ogrpc?network=ethereum&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
        break;
      case bsc.id:
        chain = bsc;
        rpcUrl =
          "https://lb.drpc.org/ogrpc?network=bsc&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9";
        break;
      default:
        throw new Error("Chain not supported for merkle " + merkle.symbol);
    }

    // Fetch the current contract balance.
    let sdTknBalanceRaw: bigint;
    try {
      const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
      });
      sdTknBalanceRaw = await publicClient.readContract({
        address: merkle.address as `0x${string}`,
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
        args: [merkleContractAddress as `0x${string}`],
      });
    } catch (error) {
      output += "\nError fetching contract balance information\n";
      output += error instanceof Error ? error.message : String(error) + "\n";
      continue;
    }

    // Convert raw bigint to ethers BigNumber.
    const sdTknBalanceBn = ethers.BigNumber.from(sdTknBalanceRaw);
    // Get cumulative total (Merkle snapshot) as ethers BigNumber.
    const newTotalBN = ethers.BigNumber.from(convertToProperHex(merkle.total));

    // Compute pending allocation = (Cumulative Total – Contract Balance)
    const pendingAllocationBN = newTotalBN.sub(sdTknBalanceBn);
    const pendingAllocation = parseFloat(
      ethers.utils.formatUnits(pendingAllocationBN, 18)
    );
    // Compute Distribution Surplus = max(Weekly Reported Reward - Pending Allocation, 0)
    const distributionSurplus =
      weeklyReportedReward > 0
        ? Math.max(weeklyReportedReward - pendingAllocation, 0)
        : 0;

    output += "\nDistribution Changes:\n";
    output += `Weekly Reported Reward: ${weeklyReportedReward.toFixed(2)} ${
      merkle.symbol
    }\n`;
    output += `Pending Allocation (Cumulative Total - Contract Balance): ${pendingAllocation.toFixed(
      2
    )} ${merkle.symbol}\n`;
    output += `Distribution Surplus: ${distributionSurplus.toFixed(2)} ${
      merkle.symbol
    }\n`;

    // --- Holder Distribution ---
    const addresses = new Set([
      ...Object.keys(merkle.merkle),
      ...Object.keys(prevMerkle.merkle),
    ]);

    // Gather each holder's amounts.
    const holderData = Array.from(addresses).map((address) => {
      const newAmount = parseFloat(
        ethers.utils.formatUnits(
          BigInt(
            BigNumber.from(merkle.merkle[address]?.amount || "0").toString()
          ),
          18
        )
      );
      const prevAmount = parseFloat(
        ethers.utils.formatUnits(
          BigInt(
            BigNumber.from(prevMerkle.merkle[address]?.amount || "0").toString()
          ),
          18
        )
      );
      return { address, newAmount, prevAmount };
    });

    // Get claim status for each user.
    const networkName = chainId === mainnet.id ? "ethereum" : "bsc";
    const usersClaimedAddress = await getAllAccountClaimedSinceLastFreeze(
      NETWORK_TO_MERKLE[networkName],
      merkle.address,
      chainId === mainnet.id ? "1" : "56"
    );

    // Compute each holder's shares.
    const holders = holderData
      .map((h) => {
        const hasClaimed = !!usersClaimedAddress[h.address.toLowerCase()];
        const totalShare =
          weeklyReportedReward > 0
            ? (h.newAmount / weeklyReportedReward) * 100
            : 0;
        // For pending users, the new distribution share is the delta (new - prev);
        // for claimed users, we use the total share.
        const newDistShare = hasClaimed
          ? totalShare
          : weeklyReportedReward > 0
          ? ((h.newAmount - h.prevAmount) / weeklyReportedReward) * 100
          : 0;
        return {
          address: h.address,
          newAmount: h.newAmount,
          prevAmount: h.prevAmount,
          weekChange: h.newAmount - h.prevAmount,
          hasClaimed,
          totalShare,
          newDistShare,
        };
      })
      .filter((h) => h.newAmount > 0)
      .sort((a, b) => b.newDistShare - a.newDistShare);

    output += "\nHolder Distribution:\n";
    output += "-".repeat(120) + "\n";
    output +=
      "Address                                      New Dist Share  Total Share  Prev Amount    New Amount     Week Change    Status\n";
    output += "-".repeat(120) + "\n";
    for (const holder of holders) {
      const newDistShareStr = holder.newDistShare.toFixed(2).padStart(6) + "%";
      const totalShareStr = holder.totalShare.toFixed(2).padStart(6) + "%";
      const prevAmountStr = holder.prevAmount.toFixed(2).padStart(12);
      const newAmountStr = holder.newAmount.toFixed(2).padStart(12);
      const changeStr =
        (holder.weekChange > 0 ? "+" : "") + holder.weekChange.toFixed(2);
      const claimStatus = holder.hasClaimed ? "CLAIMED" : "PENDING";
      output += `${holder.address.padEnd(42)} ${newDistShareStr.padEnd(
        14
      )} ${totalShareStr.padEnd(12)} ${prevAmountStr.padEnd(
        14
      )} ${newAmountStr.padEnd(14)} ${changeStr.padEnd(
        14
      )} ${claimStatus.padEnd(10)}\n`;
    }
    output += "-".repeat(120) + "\n";

    const totalHolders = holders.length;
    const claimedCount = holders.filter((h) => h.hasClaimed).length;
    const pendingCount = holders.filter((h) => !h.hasClaimed).length;

    output += "\nDistribution Summary:\n";
    output += `Total Holders: ${totalHolders}\n`;
    output += `Claimed Since Last Distribution: ${claimedCount} (${(
      (claimedCount / totalHolders) *
      100
    ).toFixed(2)}%)\n`;
    output += `Pending Claims: ${pendingCount} (${(
      (pendingCount / totalHolders) *
      100
    ).toFixed(2)}%)\n`;
    output += `Active Users this Week: ${
      holders.filter((h) => h.weekChange > 0).length
    }\n`;
    output += `Distribution Surplus: ${distributionSurplus.toFixed(2)} ${
      merkle.symbol
    }\n`;

    // Log data
    logData["DistributionSurplus"][merkle.symbol] = distributionSurplus;
    logData["MerkleRoots"].push(merkle.root);
    logData["TotalHolders"][merkle.symbol] = holders.length;
    logData["ClaimedSinceLastDistrib"][merkle.symbol] = claimedCount;
    logData["ActiveUsers"][merkle.symbol] = holders.filter(
      (h) => h.weekChange > 0
    ).length;

    // Storing top 5 holders before/after
    logData["TopHolders"][merkle.symbol] = holders.slice(0, 5).map((h) => ({
      address: h.address,
      prevAmount: h.prevAmount,
      newAmount: h.newAmount,
      claimed: h.hasClaimed,
    }));
  }

  const logPath = path.join(__dirname, "..", "..", "log.json");
  fs.writeFileSync(logPath, JSON.stringify(logData));
  process.stdout.write(logPath + "\n");

  return output;
}

main();
