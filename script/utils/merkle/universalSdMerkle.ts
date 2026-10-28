import { getAddress, parseEther } from "viem";
import { Distribution } from "../../interfaces/Distribution";
import { MerkleData } from "../../interfaces/MerkleData";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { findMerkleMatchingRoot } from "./findPreviousMerkle";
import { createCombineDistribution } from "./merkle";

export const REWARD_DUST = 2e-8;

export interface UniversalSdMerkle {
  merkle: MerkleData;
  previous: MerkleData;
  previousFoundAt: string | null;
  weekly: bigint;
  total: bigint;
  previousTotal: bigint;
}

export function weeklyDistribution(rewards: Record<string, number>, token: string): Distribution {
  const distribution: Distribution = {};
  for (const [address, amount] of Object.entries(rewards)) {
    if (amount < REWARD_DUST) continue;
    distribution[address.toLowerCase()] = { tokens: { [token]: parseEther(amount.toFixed(18)) } };
  }
  return distribution;
}

export function tokenTotal(merkle: MerkleData, token: string): bigint {
  const wanted = getAddress(token);
  let total = 0n;
  for (const [holder, claim] of Object.entries(merkle.claims ?? {})) {
    for (const [claimToken, data] of Object.entries(claim.tokens ?? {})) {
      if (getAddress(claimToken) !== wanted) throw new Error(`${holder} holds foreign token ${claimToken}`);
      total += BigInt(data.amount);
    }
  }
  return total;
}

export function buildUniversalSdMerkle(
  period: number,
  relPath: string,
  rewards: Record<string, number>,
  token: string,
  activeRoot: string,
): UniversalSdMerkle {
  const { data: previous, foundAt: previousFoundAt } = findMerkleMatchingRoot(period, relPath, activeRoot);
  if (!/^0x0{64}$/i.test(activeRoot) && !previousFoundAt) {
    throw new Error(`${relPath} has no baseline matching active root ${activeRoot}`);
  }
  const distribution = weeklyDistribution(rewards, token);
  const merkle = generateMerkleTree(createCombineDistribution({ distribution }, previous));
  const previousTotal = tokenTotal(previous, token);
  const total = tokenTotal(merkle, token);
  const weekly = Object.values(distribution).reduce((acc, d) => acc + d.tokens[token], 0n);
  if (total !== previousTotal + weekly) throw new Error(`${relPath} cumulative total drifted`);
  return { merkle, previous, previousFoundAt, weekly, total, previousTotal };
}
