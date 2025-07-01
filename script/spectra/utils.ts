import {
  decodeEventLog,
  parseAbi,
  erc20Abi,
  formatUnits,
} from "viem";
import { SPECTRA_SAFE_MODULE, SPECTRA_SPACE, WEEK } from "../utils/constants";
import SpectraSafeModuleABI from "../../abis/SpectraSafeModule.json";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import * as chains from "viem/chains";
import moment from "moment";
import {
  CvxCSVType,
  extractCSV,
} from "../utils/utils";
import * as dotenv from "dotenv";
import { getOptimizedClient } from "../utils/constants";
import axios from "axios";

dotenv.config();

export const SPECTRA_ADDRESS = "0x64fcc3a02eeeba05ef701b7eed066c6ebd5d4e51";
export const OLD_APW_ADDRESS = "0x4104b135dbc9609fc1a9490e61369036497660c8";

export interface SpectraClaimed {
  tokenRewardAddress: `0x${string}`;
  poolAddress: `0x${string}`;
  poolId: number;
  chainId: number;
  amount: bigint;
  name: string;
  tokenRewardSymbol: string;
}

const poolAbi = parseAbi([
  "function coins(uint256 id) external view returns(address)",
]);
const ptAbi = parseAbi([
  "function symbol() external view returns(string)",
  "function maturity() external view returns(uint256)",
]);

export async function getSpectraDistribution() {
  const baseClient = await getOptimizedClient(8453);

  // Fetch new claims from the start of the current epoch to now
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentEpoch = Math.floor(currentTimestamp / WEEK) * WEEK;
  const blockNumber1 = await getClosestBlockTimestamp("base", currentEpoch);
  const blockNumber2 = await baseClient.getBlockNumber();

  // Fetch logs in chunks to avoid exceeding RPC block range limit
  const MAX_BLOCK_RANGE = 50000n;
  const logs: any[] = [];
  
  let fromBlock = BigInt(blockNumber1);
  const toBlock = blockNumber2;
  
  while (fromBlock <= toBlock) {
    const chunkToBlock = fromBlock + MAX_BLOCK_RANGE - 1n < toBlock 
      ? fromBlock + MAX_BLOCK_RANGE - 1n 
      : toBlock;
    
    console.log(`Fetching logs from block ${fromBlock} to ${chunkToBlock}...`);
    
    const chunkLogs = await baseClient.getContractEvents({
      address: SPECTRA_SAFE_MODULE,
      abi: SpectraSafeModuleABI,
      eventName: "Claimed",
      fromBlock: fromBlock,
      toBlock: chunkToBlock,
    });
    
    logs.push(...chunkLogs);
    fromBlock = chunkToBlock + 1n;
  }

  const claimeds: SpectraClaimed[] = [];
  for (const log of logs) {
    const topics = decodeEventLog({
      abi: SpectraSafeModuleABI,
      data: log.data,
      topics: log.topics,
    });

    if (!topics.args) {
      continue;
    }

    const args = topics.args as any;
    const tokenAddress = args.tokenAddress as `0x${string}`;
    const tokenRewardSymbol = await baseClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "symbol",
    });

    claimeds.push({
      tokenRewardAddress: tokenAddress,
      poolAddress: args.poolAddress as `0x${string}`,
      poolId: Number(args.poolId),
      chainId: Number(args.chainId),
      amount: args.amount as bigint,
      name: "",
      tokenRewardSymbol,
    });
  }

  // Fetch names to be able to distribute with the snapshot
  for (const claim of claimeds) {
    const chain = getChain(claim.chainId);
    if (!chain) {
      continue;
    }

    const client = await getOptimizedClient(claim.chainId);

    // @ts-ignore
    const coinPT = await client.readContract({
      address: claim.poolAddress as `0x${string}`,
      abi: poolAbi,
      functionName: "coins",
      args: [BigInt(1)], // PT
    });

    if (coinPT === undefined) {
      continue;
    }

    const symbol = await client.readContract({
      address: coinPT,
      abi: ptAbi,
      functionName: "symbol",
    });

    const splits = symbol.split("-");
    const maturity = parseInt(splits.pop() as string);

    const maturityFormatted = moment.unix(maturity).format("L");
    const chainName = getChainIdName(claim.chainId)
      .toLowerCase()
      .replace(" ", "");

    claim.name = `${chainName}-${splits.join(
      "-"
    )}-${maturityFormatted}`.replace("-PT", "");
  }

  return claimeds;
}

const getChain = (chainId: number): chains.Chain | undefined => {
  for (const chain of Object.values(chains)) {
    if ("id" in chain) {
      if (chain.id === chainId) {
        return chain;
      }
    }
  }

  return undefined;
};

const getChainIdName = (chainId: number): string => {
  for (const chain of Object.values(chains)) {
    if ("id" in chain) {
      if (chain.id === chainId) {
        return chain.name;
      }
    }
  }

  return chainId.toString();
};

export const getSpectraReport = async (
  currentPeriodTimestamp: number
): Promise<CvxCSVType> => {
  const _csvResult = await extractCSV(currentPeriodTimestamp, SPECTRA_SPACE);
  if (!_csvResult) throw new Error("No CSV report found");

  return _csvResult as CvxCSVType;
};


export const getSpectraDelegationAPR = async (
  tokens: {
    [tokenAddress: string]: bigint;
  },
  stakeDaoDelegators: string[]
): Promise<number> => {
  const sumRewards = parseFloat(formatUnits(Object.values(tokens)[0], 18))
  const {data: sdSpectraWorking} = await axios.get(
    "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/lockers/sdspectra-working-supply.json"
  )

  let totalVpDelegators = 0;
  const users = Object.keys(sdSpectraWorking.users_working_balance)

  for(const delegator of stakeDaoDelegators) {
    let found = false
    for(const user of users) {
      if(delegator.toLowerCase() === user.toLowerCase()) {
        totalVpDelegators += sdSpectraWorking.users_working_balance[user];
        found = true
        break;
      }
    }

    if(!found) {
      console.log("Delegator not found" + delegator);
    }
  }
  
  // Because we do a weekly distribution
  return sumRewards / totalVpDelegators * 52 * 100;
};

