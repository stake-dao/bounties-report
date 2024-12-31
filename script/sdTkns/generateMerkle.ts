import axios from "axios";
import * as dotenv from "dotenv";
import {
  fetchLastProposalsIds,
  fetchProposalsIdsBasedOnPeriods,
} from "../utils/snapshot";
import {
  abi,
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
  NETWORK_TO_MERKLE,
  NETWORK_TO_STASH,
  SDPENDLE_SPACE,
  SPACE_TO_CHAIN_ID,
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

const TODAY_DATE = moment.utc().format("YYYY-MM-DD");

dotenv.config();

const logData: Record<string, any> = {
  TotalReported: {},
  Transactions: [],
  SnapshotIds: [],
}; // Use to store and write logs in a JSON

const convertToProperHex = (value: any): string => {
  // If it's a BigNumber object with type and hex properties
  if (value?.type === "BigNumber" && value?.hex) {
    const hexValue = value.hex.startsWith("0x") ? value.hex : `0x${value.hex}`;
    return hexValue;
  }

  // If it's an ethers BigNumber instance
  if (BigNumber.isBigNumber(value)) {
    return value.toHexString();
  }

  // If it's a string already
  if (typeof value === "string") {
    return value.startsWith("0x") ? value : `0x${value}`;
  }

  // If it's a regular number
  if (typeof value === "number") {
    return `0x${value.toString(16)}`;
  }

  // Default case
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
  ] = await Promise.all([
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/bounties-report/main/merkle.json"
    ),
    fetchLastProposalsIds(SPACES, now, filter),
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/bounties-report/main/delegationsAPRs.json"
    ),
    axios.get(
      "https://raw.githubusercontent.com/stake-dao/tg-bots/refs/heads/main/data/sdfxs/sdfxs-working-supply.json"
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

  // All except Pendle
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

    // If no bribe to distribute to this space => skip
    const csvResult = await extractCSV(currentPeriodTimestamp, space);
    const isPendle = space === SDPENDLE_SPACE;
    const network = SPACE_TO_NETWORK[space];

    // Log csv totals (total sd token)
    if (!csvResult) {
      continue;
    }

    let totalSDToken = 0;
    if (isPendle) {
      for (const period of Object.keys(csvResult)) {
        totalSDToken += Object.values(csvResult[period]).reduce(
          (acc, amount) => acc + amount,
          0
        );
      }
    } else {
      totalSDToken = Object.values(csvResult).reduce(
        (acc, amount) => acc + amount,
        0
      );
    }
    logData["TotalReported"][space] = totalSDToken;

    let ids: string[] = [];
    let pendleRewards: Record<string, Record<string, number>> | undefined =
      undefined;

    // If it's pendle, we merge the rewards before
    if (isPendle) {
      let proposalsPeriods = await fetchProposalsIdsBasedOnPeriods(
        space,
        Object.keys(csvResult),
        currentPeriodTimestamp
      );

      // Merge rewards by proposal period
      pendleRewards = {};
      for (const period in csvResult) {
        const proposalId = proposalsPeriods[period];
        if (!pendleRewards[proposalId]) {
          pendleRewards[proposalId] = {};
        }

        const rewards = (csvResult as PendleCSVType)[period];
        for (const address in rewards) {
          if (pendleRewards[proposalId][address]) {
            pendleRewards[proposalId][address] += rewards[address];
          } else {
            pendleRewards[proposalId][address] = rewards[address];
          }
        }
      }

      ids = Object.keys(pendleRewards);
    } else {
      ids = [proposalIdPerSpace[space]];
    }

    logData["SnapshotIds"].push({
      space,
      ids,
    });

    // Create the merkle
    const merkleStat = await createMerkle(
      ids,
      space,
      lastMerkles,
      csvResult,
      pendleRewards,
      sdFXSWorkingData
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

    // compute log
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

  // Check if sdTkn in the merkle contract + sdTkn to distribute >= total in merkle file
  checkDistribution(newMerkles, logData);

  fs.writeFileSync(`./merkle.json`, JSON.stringify(newMerkles));

  for (const key of Object.keys(delegationAPRs)) {
    if (delegationAPRs[key] === -1) {
      delegationAPRs[key] = delegationAPRsClone[key] || 0;
    }
  }
  fs.writeFileSync(`./delegationsAPRs.json`, JSON.stringify(delegationAPRs));

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

  // Add full path to the written files in the log
  logData["Merkle"] = path.join(__dirname, "..", "merkle.json");
  logData["DelegationsAPRs"] = path.join(
    __dirname,
    "..",
    "..",
    "delegationsAPRs.json"
  );

  const logPath = path.join(__dirname, "..", "..", "log.json");
  fs.writeFileSync(logPath, JSON.stringify(logData));
  console.log(logPath);

  console.log("\nComparing Merkle Trees:");

  const logFilePath = `./temp/sdTokens_merkle_${TODAY_DATE}.log`;
  const writeToMerkleLog = (content: string) => {
    fs.appendFileSync(logFilePath, content + "\n");
  };

  for (const merkle of newMerkles) {
    writeToMerkleLog("\n" + "=".repeat(80));
    writeToMerkleLog(`Distribution Details for ${merkle.symbol}`);
    writeToMerkleLog("=".repeat(80));

    writeToMerkleLog(`Chain ID: ${merkle.chainId}`);
    writeToMerkleLog(`Token Address: ${merkle.address}`);
    writeToMerkleLog(`Merkle Contract: ${merkle.merkleContract}`);

    // Find corresponding previous merkle
    const prevMerkle = lastMerkles.find(
      (m: any) => m.address.toLowerCase() === merkle.address.toLowerCase()
    );

    if (!prevMerkle) {
      writeToMerkleLog("\nNEW DISTRIBUTION");
      const totalFormatted = parseFloat(
        formatUnits(BigInt(BigNumber.from(merkle.total).toString()), 18)
      );
      writeToMerkleLog(`Total: ${totalFormatted.toFixed(2)} ${merkle.symbol}`);
      continue;
    }

    // Calculate totals
    const newTotal = BigNumber.from(convertToProperHex(merkle.total));
    const prevTotal = BigNumber.from(convertToProperHex(prevMerkle.total));
    const difference = newTotal.sub(prevTotal);

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
    }

    let sdTknBalance = 0;
    let totalInMerkle = 0;
    let remainingToDistribute = 0;

    // Get current balance from contract
    if (chain) {
      try {
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        });

        const sdTknBalanceBn = await publicClient.readContract({
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
          args: [merkle.merkleContract as `0x${string}`],
        });

        sdTknBalance = parseFloat(formatUnits(sdTknBalanceBn, 18));
        totalInMerkle = parseFloat(ethers.utils.formatUnits(newTotal, 18));
        remainingToDistribute = totalInMerkle - sdTknBalance;

        writeToMerkleLog("\nContract Status:");
        writeToMerkleLog(
          `Current Balance: ${sdTknBalance.toFixed(2)} ${merkle.symbol}`
        );
        writeToMerkleLog(
          `Total in Merkle: ${totalInMerkle.toFixed(2)} ${merkle.symbol}`
        );
        writeToMerkleLog(
          `Remaining to Distribute: ${remainingToDistribute.toFixed(2)} ${
            merkle.symbol
          }`
        );
      } catch (error) {
        writeToMerkleLog("\nError fetching balance information");
        writeToMerkleLog(
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    writeToMerkleLog("\nDistribution Changes:");
    writeToMerkleLog(
      `Previous Total: ${ethers.utils.formatUnits(prevTotal, 18)} ${
        merkle.symbol
      }`
    );
    writeToMerkleLog(
      `New Total: ${ethers.utils.formatUnits(newTotal, 18)} ${merkle.symbol}`
    );
    writeToMerkleLog(
      `Difference: ${difference.gte(0) ? "+" : ""}${ethers.utils.formatUnits(
        difference,
        18
      )} ${merkle.symbol}`
    );

    if (newTotal > 0 || prevTotal > 0) {
      writeToMerkleLog("\nHolder Distribution:");
      writeToMerkleLog("-".repeat(120));
      writeToMerkleLog(
        "Address          New Dist Share  Total Share  Prev Amount    Total Amount    Week Change    Status"
      );
      writeToMerkleLog("-".repeat(120));

      const addresses = new Set([
        ...Object.keys(merkle.merkle),
        ...Object.keys(prevMerkle.merkle),
      ]);

      // Get claim status for all users
      const network = merkle.chainId === mainnet.id ? "ethereum" : "bsc";
      const usersClaimedAddress = await getAllAccountClaimedSinceLastFreeze(
        NETWORK_TO_MERKLE[network],
        merkle.address,
        merkle.chainId === mainnet.id ? "1" : "56"
      );

      // Create the holders array with calculations
      const holders = Array.from(addresses)
        .map((address) => {
          const newAmount = parseFloat(
            formatUnits(
              BigInt(
                BigNumber.from(merkle.merkle[address]?.amount || "0").toString()
              ),
              18
            )
          );
          const prevAmount = parseFloat(
            formatUnits(
              BigInt(
                BigNumber.from(
                  prevMerkle.merkle[address]?.amount || "0"
                ).toString()
              ),
              18
            )
          );
          const weekChange = newAmount - prevAmount;
          const userAddressLowerCase = address.toLowerCase();
          const hasClaimed = usersClaimedAddress[userAddressLowerCase];

          // Calculate share based on claim status and only if there's a difference
          const newDistShare =
            weekChange > 0
              ? hasClaimed
                ? (newAmount / remainingToDistribute) * 100
                : (weekChange / remainingToDistribute) * 100
              : 0;

          return {
            address,
            newAmount,
            prevAmount,
            weekChange,
            hasClaimed,
            totalShare: (newAmount / totalInMerkle) * 100,
            newDistShare,
          };
        })
        .filter((h) => h.newAmount > 0)
        .sort((a, b) => b.newDistShare - a.newDistShare);

      // Calculate summary stats
      const totalHolders = holders.length;
      const claimedCount = holders.filter((h) => h.hasClaimed).length;
      const pendingCount = holders.filter((h) => !h.hasClaimed).length;

      for (const holder of holders) {
        const addressDisplay = `${holder.address.slice(
          0,
          6
        )}...${holder.address.slice(-4)}`;

        const newDistShareStr =
          holder.newDistShare.toFixed(2).padStart(6) + "%";
        const totalShareStr = holder.totalShare.toFixed(2).padStart(6) + "%";
        const prevAmountStr = holder.prevAmount.toFixed(2).padStart(12);
        const amountStr = holder.newAmount.toFixed(2).padStart(12);
        const changeStr =
          (holder.weekChange > 0 ? "+" : "") + holder.weekChange.toFixed(2);
        const claimStatus = holder.hasClaimed ? "CLAIMED" : "PENDING";

        writeToMerkleLog(
          `${addressDisplay.padEnd(16)} ${newDistShareStr.padEnd(
            14
          )} ${totalShareStr.padEnd(12)} ${prevAmountStr.padEnd(
            14
          )} ${amountStr.padEnd(14)} ${changeStr.padEnd(
            14
          )} ${claimStatus.padEnd(10)}`
        );
      }

      writeToMerkleLog("-".repeat(120));

      // Summary statistics
      writeToMerkleLog("\nDistribution Summary:");
      writeToMerkleLog(`Total Holders: ${totalHolders}`);
      writeToMerkleLog(
        `Claimed Since Last Distribution: ${claimedCount} (${(
          (claimedCount / totalHolders) *
          100
        ).toFixed(2)}%)`
      );
      writeToMerkleLog(
        `Pending Claims: ${pendingCount} (${(
          (pendingCount / totalHolders) *
          100
        ).toFixed(2)}%)`
      );
      writeToMerkleLog(
        `Active Delegators this Week: ${
          holders.filter((h) => h.weekChange > 0).length
        }`
      );
      writeToMerkleLog(
        `Total Distribution: ${remainingToDistribute.toFixed(2)} ${
          merkle.symbol
        }`
      );
    }
  }
};

/**
 * Check, for each sdTkn, if the new amount in the merkle is higher than remaining sdTkn in the merkle contract + amount to distribute
 * The sdTkn must not be freeze
 */
const checkDistribution = async (
  newMerkles: Merkle[],
  logData: Record<string, any>
) => {
  if (!logData || !logData["TotalReported"]) {
    throw new Error("Total reported not exists in log");
  }

  for (const space of Object.keys(logData["TotalReported"])) {
    const amountToDistribute = logData["TotalReported"][space];

    // Find the merkle object
    const merkle = newMerkles.find(
      (merkle) => SPACES_SYMBOL[space] === merkle.symbol
    );
    if (!merkle) {
      throw new Error("Merkle object not found for " + space);
    }

    // Get the total amount
    const totalAmount = parseFloat(
      formatUnits(BigInt(BigNumber.from(merkle.total).toString()), 18)
    );

    let chain: null | Chain = null;
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

    // Fetch remaining amount in the merkle contract
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    // Check if the token is freeze
    const merkleRootRes = await publicClient.readContract({
      address: merkle.merkleContract as any,
      abi: [
        {
          inputs: [
            {
              internalType: "address",
              name: "",
              type: "address",
            },
          ],
          name: "merkleRoot",
          outputs: [
            {
              internalType: "bytes32",
              name: "",
              type: "bytes32",
            },
          ],
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

    // - 0.01 for threshold
    if (sdTknBalanceInMerkle + amountToDistribute < totalAmount - 0.01) {
      throw new Error("Amount in the merkle to high for space " + space);
    }
  }
};

main();
