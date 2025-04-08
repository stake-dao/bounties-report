import fs from "fs";
import path from "path";
import { getAddress } from "viem";

type TokenRewards = Record<string, bigint>;

interface RepartitionEntry {
  tokens: Record<string, string>; // tokenAddress -> amount as string
}

interface RepartitionData {
  distribution: Record<string, RepartitionEntry>;
}

interface DelegationGroupData {
  [tokenAddress: string]: {
    forwarders: string;
    nonForwarders: string;
  };
}

interface RepartitionDelegationData {
  distribution: {
    totalPerGroup: DelegationGroupData;
  };
}

// ============ Utility ============

function loadJSON<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw) as T;
    }
    console.warn(`File not found, skipping: ${filePath}`);
  } catch (error) {
    console.warn(`Error loading file ${filePath}:`, error);
  }
  return defaultValue;
}

function sumTokensFromRepartition(data: RepartitionData): TokenRewards {
  const result: TokenRewards = {};
  for (const entry of Object.values(data.distribution)) {
    for (const [token, amount] of Object.entries(entry.tokens)) {
      result[token] = (result[token] || 0n) + BigInt(amount);
    }
  }
  return result;
}

function sumTokensFromDelegation(
  data: RepartitionDelegationData
): TokenRewards {
  const result: TokenRewards = {};
  for (const [token, group] of Object.entries(
    data.distribution.totalPerGroup
  )) {
    result[token] = (result[token] || 0n) + BigInt(group.nonForwarders);
  }
  return result;
}

// ============ vlCVX ============

export function getAllRewardsForVotersOnChain(
  chainId: number,
  periodTimestamp: number
): TokenRewards {
  const basePath = path.join("bounties-reports", `${periodTimestamp}`, "vlCVX");

  const getRepartitionPath = (subdir: string): string =>
    chainId === 1
      ? path.join(basePath, subdir, `repartition.json`)
      : path.join(basePath, subdir, `repartition_${chainId}.json`);

  const curveRepartition = loadJSON<RepartitionData>(
    getRepartitionPath("curve"),
    {
      distribution: {},
    }
  );

  const fxnRepartition = loadJSON<RepartitionData>(getRepartitionPath("fxn"), {
    distribution: {},
  });

  const rewards: TokenRewards = {
    ...sumTokensFromRepartition(curveRepartition),
  };

  const fxnRewards = sumTokensFromRepartition(fxnRepartition);
  for (const [token, amount] of Object.entries(fxnRewards)) {
    rewards[token] = (rewards[token] || 0n) + amount;
  }

  // Format properly token addresses
  let formattedRewards: Record<string, bigint> = {};
  for (const [token, amount] of Object.entries(rewards)) {
    formattedRewards[getAddress(token)] = amount;
  }

  return formattedRewards;
}

const getAllRewardsForDelegators = (periodTimestamp: number) => {};
/*
  const annualizedRewards = rewardValueUSD * 52; // Multiply weekly rewards by 52 weeks
  const annualizedAPR =
    (annualizedRewards / (cvxPrice * totalVotingPower)) * 100; // Multiply by 100 for percentage
*/

export function computeAnnualizedAPR(
  totalVotingPower: number,
  rewardValueUSD: number,
  cvxPrice: number
) {
  const annualizedRewards = rewardValueUSD * 52; // Multiply weekly rewards by 52 weeks
  const annualizedAPR =
    (annualizedRewards / (cvxPrice * totalVotingPower)) * 100; // Multiply by 100 for percentage

  return annualizedAPR;
}

// TEST
function main() {
  const rewards = getAllRewardsForVotersOnChain(1, 1743638400);
  console.log(rewards);
}

main();
