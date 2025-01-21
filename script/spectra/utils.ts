import {
  createPublicClient,
  http,
  decodeEventLog,
  parseAbi,
  erc20Abi,
  formatUnits,
} from "viem";
import { SPECTRA_SAFE_MODULE, SPECTRA_SPACE, WEEK } from "../utils/constants";
import { base } from "viem/chains";
import SpectraSafeModuleABI from "../../abis/SpectraSafeModule.json";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import * as chains from 'viem/chains'
import moment from "moment";
import { CvxCSVType, extractCSV, getHistoricalTokenPrice } from "../utils/utils";

const SPECTRA_ADDRESS = "0x64fcc3a02eeeba05ef701b7eed066c6ebd5d4e51";
const OLD_APW_ADDRESS = "0x4104b135dbc9609fc1a9490e61369036497660c8";

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
    transport: http("https://lb.drpc.org/ogrpc?network=base&dkey=Ak80gSCleU1Frwnafb5Ka4VRKGAHTlER77RpvmJKmvm9")
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

export const getSpectraReport = async (currentPeriodTimestamp: number): Promise<CvxCSVType> => {
  const _csvResult = (await extractCSV(
      currentPeriodTimestamp,
      SPECTRA_SPACE
    ));
    if (!_csvResult) throw new Error("No CSV report found");
  
    return _csvResult as CvxCSVType;
}

export const getSpectraDelegationAPR = async (
  tokens: {
    [tokenAddress: string]: bigint;
  },
  currentPeriodTimestamp: number,
  delegationVp: number
): Promise<number> => {

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  // Fetch reward token prices and compute the total USD distributed
  let totalDistributedUSD = 0;
  for (const rewardAddress of Object.keys(tokens)) {
    // Fetch token price and decimals
    const [tokenPrice, decimals] = await Promise.all([
      getHistoricalTokenPrice(currentPeriodTimestamp, "base", rewardAddress),
      publicClient.readContract({
        address: rewardAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      })
    ]);
    totalDistributedUSD += (parseFloat(formatUnits(tokens[rewardAddress], decimals)) * tokenPrice);
  }

  // Fetch Spectra price
  const [spectraPrice, oldApwPrice] = await Promise.all([
    getHistoricalTokenPrice(currentPeriodTimestamp, "base", SPECTRA_ADDRESS),
    getHistoricalTokenPrice(currentPeriodTimestamp, "ethereum", OLD_APW_ADDRESS)
  ]);

  const ratio = spectraPrice / oldApwPrice;

  // Delegation vp USD
  const delegationVpUsd = delegationVp * spectraPrice;

  // Because we do a weekly distribution
  totalDistributedUSD *= 52;
  let apr = totalDistributedUSD * 100 / delegationVpUsd; 

  return apr * ratio;
}