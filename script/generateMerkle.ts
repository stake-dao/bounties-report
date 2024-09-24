import axios from "axios";
import * as dotenv from "dotenv";
import {
  fetchLastProposalsIds,
  fetchProposalsIdsBasedOnPeriods,
} from "./utils/snapshot";
import {
  abi,
  BOTMARKETS,
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
} from "./utils/constants";
import * as moment from "moment";
import { checkSpace, extractCSV, PendleCSVType } from "./utils/utils";
import { createMerkle, LogId, Merkle } from "./utils/createMerkle";
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
import { bsc, mainnet } from "viem/chains";
import { balanceOf } from "./utils/utils";

dotenv.config();

const logData: Record<string, any> = {
  TotalReported: {},
  Transactions: [],
  SnapshotIds: [],
}; // Use to store and write logs in a JSON

const main = async () => {
  const now = moment.utc().unix();

  const [{ data: lastMerkles }, proposalIdPerSpace, { data: delegationAPRs }, {data: sdFXSWorkingData}] =
    await Promise.all([
      axios.get(
        "https://raw.githubusercontent.com/stake-dao/bounties-report/main/merkle.json"
      ),
      fetchLastProposalsIds(SPACES, now),
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
      const proposalsPeriods = await fetchProposalsIdsBasedOnPeriods(
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
    "delegationsAPRs.json"
  );

  fs.writeFileSync(
    path.join(__dirname, "..", "log.json"),
    JSON.stringify(logData)
  );

  const logPath = path.join(__dirname, "..", "log.json");
  fs.writeFileSync(logPath, JSON.stringify(logData));
  console.log(logPath);
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
