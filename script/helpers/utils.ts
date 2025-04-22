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

function sumTokensFromDelegation(
  data: RepartitionDelegationData
): TokenRewards {
  const result: TokenRewards = {};
  for (const [token, amount] of Object.entries(data.distribution.totalTokens)) {
    result[token] = BigInt(amount);
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
} {
  const basePath = path.join("bounties-reports", `${periodTimestamp}`, "vlCVX");

  // Delegation repartition (forwarders)
  const getRepartitionPath = (subdir: string): string =>
    path.join(basePath, subdir, `repartition_delegation.json`);

  const curveRepartition = loadJSON<RepartitionDelegationData>(
    getRepartitionPath("curve"),
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
    getRepartitionPath("fxn"),
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

  const rewards: TokenRewards = {
    ...sumTokensFromDelegation(curveRepartition),
  };

  const fxnRewards = sumTokensFromDelegation(fxnRepartition);
  for (const [token, amount] of Object.entries(fxnRewards)) {
    rewards[token] = (rewards[token] || 0n) + amount;
  }

  // Initialize rewards per group
  const forwardersRewards: TokenRewards = {};
  const nonForwardersRewards: TokenRewards = {};

  // Extract rewards per group from curve repartition
  for (const [token, groups] of Object.entries(curveRepartition.distribution.totalPerGroup || {})) {
    forwardersRewards[token] = BigInt(groups.forwarders || "0");
    nonForwardersRewards[token] = BigInt(groups.nonForwarders || "0");
  }

  // Add rewards per group from fxn repartition
  for (const [token, groups] of Object.entries(fxnRepartition.distribution.totalPerGroup || {})) {
    forwardersRewards[token] = (forwardersRewards[token] || 0n) + BigInt(groups.forwarders || "0");
    nonForwardersRewards[token] = (nonForwardersRewards[token] || 0n) + BigInt(groups.nonForwarders || "0");
  }

  // Format properly token addresses
  let formattedRewards: Record<string, bigint> = {};
  let formattedForwardersRewards: Record<string, bigint> = {};
  let formattedNonForwardersRewards: Record<string, bigint> = {};

  for (const [token, amount] of Object.entries(rewards)) {
    formattedRewards[getAddress(token)] = amount;
  }

  for (const [token, amount] of Object.entries(forwardersRewards)) {
    formattedForwardersRewards[getAddress(token)] = amount;
  }

  for (const [token, amount] of Object.entries(nonForwardersRewards)) {
    formattedNonForwardersRewards[getAddress(token)] = amount;
  }

  // Extract forwarders addresses from both repartitions
  const curveForwarders = Object.keys(
    curveRepartition.distribution.forwarders || {}
  );
  const fxnForwarders = Object.keys(
    fxnRepartition.distribution.forwarders || {}
  );

  // Combine and deduplicate forwarders
  const allForwarders = [...new Set([...curveForwarders, ...fxnForwarders])];

  // Format forwarder addresses to checksum format
  const formattedForwarders = allForwarders.map((address) =>
    getAddress(address)
  );

  return {
    rewards: formattedRewards,
    forwarders: formattedForwarders,
    rewardsPerGroup: {
      forwarders: formattedForwardersRewards,
      nonForwarders: formattedNonForwardersRewards,
    }
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

// TEST
function main() {
  const rewards = getAllRewardsForVotersOnChain(1, 1743638400);
  console.log(rewards);
}

main();
