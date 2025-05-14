import fs from "fs";
import path from "path";
import { getAddress } from "viem";
const { parse } = require("csv-parse/sync");

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
    totalTokens: Record<string, string>;
    totalPerGroup: DelegationGroupData;
    totalForwardersShare: string;
    totalNonForwardersShare: string;
    forwarders: Record<string, string>;
    nonForwarders: Record<string, string>;
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

// ============ vlCVX ============

export function getAllRewardsForVotersOnChain(
  chainId: number,
  periodTimestamp: number
): TokenRewards {
  const basePath = path.join("bounties-reports", `${periodTimestamp}`, "vlCVX");

  const getRepartitionPath = (subdir: string, isDelegation: boolean): string =>
    isDelegation
      ? path.join(basePath, subdir, `repartition_delegation.json`)
      : chainId === 1
        ? path.join(basePath, subdir, `repartition.json`)
        : path.join(basePath, subdir, `repartition_${chainId}.json`);

  const curveRepartition = loadJSON<RepartitionData>(
    getRepartitionPath("curve", false),
    {
      distribution: {},
    }
  );

  const fxnRepartition = loadJSON<RepartitionData>(
    getRepartitionPath("fxn", false),
    {
      distribution: {},
    }
  );
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

export function getAllRewardsForDelegators(periodTimestamp: number): {
  rewards: TokenRewards;
  forwarders: string[];
  rewardsPerGroup: {
    forwarders: TokenRewards;
    nonForwarders: TokenRewards;
  };
  chainRewards: Record<number, {
    rewards: TokenRewards;
    rewardsPerGroup: {
      forwarders: TokenRewards;
      nonForwarders: TokenRewards;
    };
  }>;
} {
  const basePath = path.join("bounties-reports", `${periodTimestamp}`, "vlCVX");
  const SUPPORTED_CHAINS = [1, 8453, 42161]; // Ethereum, Base, Arbitrum

  // Helper function to get repartition path for a specific chain
  const getRepartitionPath = (subdir: string, chainId: number): string =>
    chainId === 1
      ? path.join(basePath, subdir, `repartition_delegation.json`)
      : path.join(basePath, subdir, `repartition_delegation_${chainId}.json`);

  // Initialize chain-specific rewards
  const chainRewards: Record<number, {
    rewards: TokenRewards;
    rewardsPerGroup: {
      forwarders: TokenRewards;
      nonForwarders: TokenRewards;
    };
  }> = {};

  // Process each chain
  for (const chainId of SUPPORTED_CHAINS) {
    const curveRepartition = loadJSON<RepartitionDelegationData>(
      getRepartitionPath("curve", chainId),
      {
        distribution: {
          totalTokens: {},
          totalPerGroup: {},
          totalForwardersShare: "0",
          totalNonForwardersShare: "0",
          forwarders: {},
          nonForwarders: {},
        },
      }
    );

    const fxnRepartition = loadJSON<RepartitionDelegationData>(
      getRepartitionPath("fxn", chainId),
      {
        distribution: {
          totalTokens: {},
          totalPerGroup: {},
          totalForwardersShare: "0",
          totalNonForwardersShare: "0",
          forwarders: {},
          nonForwarders: {},
        },
      }
    );

    // Initialize chain rewards
    chainRewards[chainId] = {
      rewards: {},
      rewardsPerGroup: {
        forwarders: {},
        nonForwarders: {},
      },
    };

    // Process curve rewards for this chain
    for (const [token, amount] of Object.entries(curveRepartition.distribution.totalTokens)) {
      chainRewards[chainId].rewards[getAddress(token)] = BigInt(amount);
    }

    // Process fxn rewards for this chain
    for (const [token, amount] of Object.entries(fxnRepartition.distribution.totalTokens)) {
      const normalizedToken = getAddress(token);
      chainRewards[chainId].rewards[normalizedToken] = 
        (chainRewards[chainId].rewards[normalizedToken] || 0n) + BigInt(amount);
    }

    // Process rewards per group for this chain
    for (const [token, groups] of Object.entries(curveRepartition.distribution.totalPerGroup || {})) {
      const normalizedToken = getAddress(token);
      chainRewards[chainId].rewardsPerGroup.forwarders[normalizedToken] = BigInt(groups.forwarders || "0");
      chainRewards[chainId].rewardsPerGroup.nonForwarders[normalizedToken] = BigInt(groups.nonForwarders || "0");
    }

    // Add fxn rewards per group for this chain
    for (const [token, groups] of Object.entries(fxnRepartition.distribution.totalPerGroup || {})) {
      const normalizedToken = getAddress(token);
      chainRewards[chainId].rewardsPerGroup.forwarders[normalizedToken] = 
        (chainRewards[chainId].rewardsPerGroup.forwarders[normalizedToken] || 0n) + BigInt(groups.forwarders || "0");
      chainRewards[chainId].rewardsPerGroup.nonForwarders[normalizedToken] = 
        (chainRewards[chainId].rewardsPerGroup.nonForwarders[normalizedToken] || 0n) + BigInt(groups.nonForwarders || "0");
    }
  }

  // Combine all chain rewards for the main return value
  const rewards: TokenRewards = {};
  const forwardersRewards: TokenRewards = {};
  const nonForwardersRewards: TokenRewards = {};

  // Combine rewards from all chains
  for (const chainData of Object.values(chainRewards)) {
    for (const [token, amount] of Object.entries(chainData.rewards)) {
      rewards[token] = (rewards[token] || 0n) + amount;
    }
    for (const [token, amount] of Object.entries(chainData.rewardsPerGroup.forwarders)) {
      forwardersRewards[token] = (forwardersRewards[token] || 0n) + amount;
    }
    for (const [token, amount] of Object.entries(chainData.rewardsPerGroup.nonForwarders)) {
      nonForwardersRewards[token] = (nonForwardersRewards[token] || 0n) + amount;
    }
  }

  // Get forwarders from all chains
  const allForwarders = new Set<string>();
  for (const chainId of SUPPORTED_CHAINS) {
    const curveRepartition = loadJSON<RepartitionDelegationData>(
      getRepartitionPath("curve", chainId),
      {
        distribution: {
          totalTokens: {},
          totalPerGroup: {},
          totalForwardersShare: "0",
          totalNonForwardersShare: "0",
          forwarders: {},
          nonForwarders: {},
        },
      }
    );
    const fxnRepartition = loadJSON<RepartitionDelegationData>(
      getRepartitionPath("fxn", chainId),
      {
        distribution: {
          totalTokens: {},
          totalPerGroup: {},
          totalForwardersShare: "0",
          totalNonForwardersShare: "0",
          forwarders: {},
          nonForwarders: {},
        },
      }
    );

    // Add forwarders from both repartitions
    Object.keys(curveRepartition.distribution.forwarders || {}).forEach(addr => allForwarders.add(getAddress(addr)));
    Object.keys(fxnRepartition.distribution.forwarders || {}).forEach(addr => allForwarders.add(getAddress(addr)));
  }

  return {
    rewards,
    forwarders: Array.from(allForwarders),
    rewardsPerGroup: {
      forwarders: forwardersRewards,
      nonForwarders: nonForwardersRewards,
    },
    chainRewards,
  };
}

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

// ============ Spectra ============

export async function getSpectraRewards(periodTimestamp: number): Promise<Record<string, number>> {
  const csvFilePath = path.join(
    __dirname,
    `../../bounties-reports/${periodTimestamp}/spectra.csv`
  );

  if (!csvFilePath || !fs.existsSync(csvFilePath)) {
    throw new Error("No CSV report found");
  }

  const csvFile = fs.readFileSync(csvFilePath, "utf8");

  let records = parse(csvFile, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ";",
  });


  // Get sum of all tokens + amounts
  const rewards: Record<string, number> = {};
  for (const record of records) {
    const token = record["Reward Address"];
    const amount = record["Reward Amount"];
    rewards[token] = (rewards[token] || 0) + parseFloat(amount);
  }
  return rewards;
}

export function getsdSpectraDistributed(periodTimestamp: number): number {
  const basePath = path.join("bounties-reports", `${periodTimestamp}`, "spectra");
  const result = loadJSON<{ distribution: Record<string, { tokens: Record<string, string> }> }>(
    path.join(basePath, `repartition.json`),
    { distribution: {} }
  );

  let totalAmount = 0n;
  const targetToken = "0x8e7801bAC71E92993f6924e7D767D7dbC5fCE0AE";

  for (const gaugeData of Object.values(result.distribution)) {
    if (gaugeData.tokens[targetToken]) {
      totalAmount += BigInt(gaugeData.tokens[targetToken]);
    }
  }
  return Number(totalAmount / 10n ** 18n);
}

// TEST
function main() {
  const rewards = getAllRewardsForVotersOnChain(1, 1743638400);
  console.log(rewards);
}

main();
