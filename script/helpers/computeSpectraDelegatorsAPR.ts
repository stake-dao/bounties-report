import {
  createPublicClient,
  http,
  keccak256,
  encodePacked,
  pad,
  decodeAbiParameters,
} from "viem";
import { mainnet } from "viem/chains";
import * as moment from "moment";
import {
  getVoters,
  getLastClosedProposal,
} from "../utils/snapshot";
import {
  DELEGATION_ADDRESS,
  SPECTRA_SPACE,
  WEEK,
  VLCVX_NON_DELEGATORS_MERKLE,
} from "../utils/constants";
import { getHistoricalTokenPrices, TokenIdentifier, LLAMA_NETWORK_MAPPING } from "../utils/priceUtils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { BOTMARKET } from "../utils/reportUtils";
import { getSpectraRewards, getsdSpectraDistributed } from "./utils";
import { SPECTRA_ADDRESS } from "../spectra/utils";
import axios from "axios";

interface APRResult {
  totalVotingPower: number;
  delegationVotingPower: number;
  delegationShare: number;
  rewardValueUSD: number;
  spectraPrice: number;
  annualizedAPR: number;
  wethAPR: number;
  otherAPR: number;
  periodStartBlock: number;
  periodEndBlock: number;
  timestamp: number;
}

interface TokenTransfer {
  token: string;
  amount: bigint;
  blockNumber: number;
}

interface TokenPrice {
  address: string;
  price: number;
  decimals: number;
}

type CvxCSVType = Record<
  string,
  { rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://rpc.flashbots.net"),
});

async function getTokenPrices(
  chain: string = "ethereum",
  tokens: string[],
  currentPeriodTimestamp: number
): Promise<TokenPrice[]> {
  const tokenIdentifiers: TokenIdentifier[] = tokens.map(token => ({
    chainId: Number(chain),
    address: token
  }));

  const prices = await getHistoricalTokenPrices(tokenIdentifiers, currentPeriodTimestamp);
  
  return tokens.map(token => {
    const key = `${LLAMA_NETWORK_MAPPING[Number(chain)]}:${token.toLowerCase()}`;
    return {
      address: token,
      price: prices[key] || 0,
      decimals: 18
    };
  });
}

async function getRewards(
  startBlock: number,
  endBlock: number,
  tokens: string[]
): Promise<TokenTransfer[]> {
  const explorerUtils = createBlockchainExplorerUtils();
  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedBotmarket = pad(BOTMARKET as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const paddedNonDelegators = pad(
    VLCVX_NON_DELEGATORS_MERKLE as `0x${string}`,
    {
      size: 32,
    }
  ).toLowerCase();

  // Query for transfers from BOTMARKET
  const topicsBotmarket = {
    "0": transferHash,
    "1": paddedBotmarket,
    "2": paddedNonDelegators,
  };

  const responseBotmarket = await explorerUtils.getLogsByAddressesAndTopics(
    tokens,
    startBlock,
    endBlock,
    topicsBotmarket,
    1
  );

  // Remove duplicates with same transactionHash AND token address
  const uniqueTransfers = responseBotmarket.result.filter(
    (transfer, index, self) =>
      index ===
      self.findIndex(
        (t) =>
          t.transactionHash === transfer.transactionHash &&
          t.address === transfer.address
      )
  );

  if (uniqueTransfers.length === 0) {
    throw new Error("No token transfers found");
  }

  return uniqueTransfers.map((transfer) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], transfer.data);

    return {
      token: transfer.address.toLowerCase(),
      amount: BigInt(amount),
      blockNumber: parseInt(transfer.blockNumber, 16),
    };
  });
}

async function computeAPR(): Promise<APRResult> {
  const now = moment.utc().unix();
  const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

  // Fetch last proposal
  console.log("Fetching latest proposal...");
  const proposal = await getLastClosedProposal(SPECTRA_SPACE);
  console.log("Using proposal:", proposal.id);

  const votes = await getVoters(proposal.id);

  let totalVotingPower = 0;
  let delegationVotingPower = 0;

  // Process votes for each gauge
  for (const vote of votes) {
    let vpChoiceSum = 0;

    for (const value of Object.values(vote.choice)) {
      vpChoiceSum += Number(value);
    }

    if (vpChoiceSum > 0) {
      const effectiveVp = vote.vp;
      totalVotingPower += effectiveVp;
      if (vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        delegationVotingPower += effectiveVp;
      }
    }
  }

  // Remove delegation vp has different distribution
  totalVotingPower -= delegationVotingPower;

  // Get all rewards on the Week received by the Merkles
  const allRewards = await getSpectraRewards(currentPeriodTimestamp);
  const totalSdSpectraDistributed = getsdSpectraDistributed(currentPeriodTimestamp);

  // TODO : Get ratio (no pool for now, so 1:1)
  const prices = await getTokenPrices("base", [SPECTRA_ADDRESS], currentPeriodTimestamp);

  const rewardPerToken: Record<string, number> = {};
  let wethRewardValueUSD = 0;
  let otherRewardValueUSD = 0;

  // Calculate reward value in USD (per token)
  for (const token of Object.keys(allRewards)) {
    const price = prices.find(p => p.address.toLowerCase() === token.toLowerCase());
    if (price) {
      const amount = allRewards[token] || BigInt(0);
      const rewardValue = Number(amount) * price.price;
      rewardPerToken[token] = rewardValue;

      // Separate WETH and other tokens
      if (token.toLowerCase() === "0x4200000000000000000000000000000000000006") { // WETH address on Base
        wethRewardValueUSD += rewardValue;
      } else {
        otherRewardValueUSD += rewardValue;
      }
    }
  }

  // Get sdSpectra rewards (this is the total reward value)
  const spectraPrice = prices.find(p => p.address.toLowerCase() === SPECTRA_ADDRESS.toLowerCase())?.price || 0;
  const totalRewardUSD = totalSdSpectraDistributed * spectraPrice;

  // Calculate delegation share
  const delegationShare = delegationVotingPower / totalVotingPower;

  console.log("\n=== Detailed Calculations ===");
  console.log("Total SD Spectra Distributed:", totalSdSpectraDistributed);
  console.log("Spectra Price (from API):", spectraPrice);
  console.log("Total Voting Power:", totalVotingPower);
  console.log("Delegation Voting Power:", delegationVotingPower);
  console.log("Delegation Share:", (delegationShare * 100).toFixed(2) + "%");
  console.log("Total Reward USD:", totalRewardUSD);
  console.log("WETH Reward USD:", wethRewardValueUSD);
  console.log("Other Reward USD:", otherRewardValueUSD);

  // Calculate annualized APRs
  // Because we do a weekly distribution, multiply by 52
  const {data: sdSpectraWorking} = await axios.get(
    "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/lockers/sdspectra-working-supply.json"
  )

  const annualizedAPR = ((totalSdSpectraDistributed * 52) / ( sdSpectraWorking.total_vp)) * 100;
  const wethAPR = ((wethRewardValueUSD * 52) / ( sdSpectraWorking.total_vp)) * 100;
  const otherAPR = ((otherRewardValueUSD * 52) / ( sdSpectraWorking.total_vp)) * 100;

  console.log("\n=== APR Calculations ===");
  console.log("Weekly Reward:", totalRewardUSD);
  console.log("Annual Reward:", totalRewardUSD * 52);
  console.log("Delegation VP in Spectra:", delegationVotingPower);
  console.log("APR Formula: (Annual Reward / (Spectra Price * Delegation VP)) * 100");
  console.log("APR:", annualizedAPR.toFixed(2) + "%");

  // Get block range for the period
  const periodStartBlock = await getClosestBlockTimestamp("base", currentPeriodTimestamp - WEEK);
  const periodEndBlock = await getClosestBlockTimestamp("base", currentPeriodTimestamp);

  return {
    totalVotingPower,
    delegationVotingPower,
    delegationShare,
    rewardValueUSD: totalRewardUSD,
    spectraPrice,
    annualizedAPR,
    wethAPR,
    otherAPR,
    periodStartBlock,
    periodEndBlock,
    timestamp: currentPeriodTimestamp
  };
}

async function main() {
  try {
    const result = await computeAPR();

    console.log("\n=== Voters APR Calculation ===");
    console.log(`Period Timestamp: ${result.timestamp}`);
    console.log(`Total Voting Power: ${result.totalVotingPower.toFixed(2)}`);
    console.log(`Delegation Voting Power: ${result.delegationVotingPower.toFixed(2)}`);
    console.log(`Delegation Share: ${(result.delegationShare * 100).toFixed(2)}%`);
    console.log(`Total Reward Value: $${result.rewardValueUSD.toFixed(2)}`);
    console.log(`Spectra Price: $${result.spectraPrice.toFixed(2)}`);
    console.log(`Total Annualized APR: ${result.annualizedAPR.toFixed(2)}%`);
    console.log(`WETH Annualized APR: ${result.wethAPR.toFixed(2)}%`);
    console.log(`Other Annualized APR: ${result.otherAPR.toFixed(2)}%`);
    console.log(
      `Period: ${result.periodStartBlock} - ${result.periodEndBlock}`
    );
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}

export { computeAPR };
