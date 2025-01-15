import {
  createPublicClient,
  http,
  decodeEventLog,
  parseAbi,
  erc20Abi,
  formatUnits,
  parseEther,
} from "viem";
import { SEPCTRA_SAFE_MODULE as SPECTRA_SAFE_MODULE, WEEK } from "../utils/constants";
import { base } from "viem/chains";
import SpectraSafeModuleABI from "../../abis/SpectraSafeModule.json";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import * as chains from 'viem/chains'
import moment from "moment";

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
  'function coins(uint256 id) external view returns(address)',
]);
const ptAbi = parseAbi([
  'function symbol() external view returns(string)',
  'function maturity() external view returns(uint256)',
]);

export async function getSpectraDistribution() {
  
  const baseClient = createPublicClient({
    chain: base,
    transport: http("https://base.drpc.org")
  });

  // Fetch new claims from the start of the current epoch to now
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentEpoch = Math.floor(currentTimestamp / WEEK) * WEEK;
  const blockNumber1 = await getClosestBlockTimestamp("base", currentEpoch);
  const blockNumber2 = await baseClient.getBlockNumber()

  const logs = await baseClient.getContractEvents({
    address: SPECTRA_SAFE_MODULE,
    abi: SpectraSafeModuleABI,
    eventName: 'Claimed',
    fromBlock: BigInt(blockNumber1),
    toBlock: blockNumber2,
  });

  const claimeds: SpectraClaimed[] = [];
  for (const log of logs) {
    const topics = decodeEventLog({
      abi: SpectraSafeModuleABI,
      data: log.data,
      topics: log.topics
    });

    if (!topics.args) {
      continue;
    }

    const args = topics.args as any;
    const tokenAddress = args.tokenAddress as `0x${string}`;
    const tokenRewardSymbol = await baseClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'symbol',
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

    const client = createPublicClient({
      chain: chain,
      transport: http()
    });

    // @ts-ignore
    const coinPT = await client.readContract({
      address: claim.poolAddress as `0x${string}`,
      abi: poolAbi,
      functionName: 'coins',
      args: [BigInt(1)] // PT
    });

    if (coinPT === undefined) {
      continue;
    }

    const symbol = await client.readContract({
      address: coinPT,
      abi: ptAbi,
      functionName: 'symbol',
    });

    const splits = symbol.split("-");
    const maturity = parseInt(splits.pop() as string);

    const maturityFormatted = moment.unix(maturity).format("L");
    const chainName = getChainIdName(claim.chainId).toLowerCase().replace(" ", "");

    claim.name = `${chainName}-${splits.join("-")}-${maturityFormatted}`.replace("-PT", "");
  }

  return claimeds;
}

const getChain = (chainId: number): chains.Chain | undefined => {
  for (const chain of Object.values(chains)) {
    if ('id' in chain) {
      if (chain.id === chainId) {
        return chain;
      }
    }
  }

  return undefined;
}

const getChainIdName = (chainId: number): string => {
  for (const chain of Object.values(chains)) {
    if ('id' in chain) {
      if (chain.id === chainId) {
        return chain.name;
      }
    }
  }

  return chainId.toString();
}