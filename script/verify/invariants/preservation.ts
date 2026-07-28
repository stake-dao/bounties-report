import { PublicClient } from "viem";
import { PairMap, TargetLabel, Violation } from "./types";

const URD_CLAIMED_ABI = [
  {
    name: "claimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "reward", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface PreservationContext {
  target: TargetLabel;
  chainId: number;
  distributor: `0x${string}`;
  pinnedBlock: bigint;
}

/** Fetch claimed(account, reward) for every pair in `pairs`, chunked multicall. */
export async function fetchClaimed(
  client: PublicClient,
  ctx: PreservationContext,
  pairKeys: [string, string][],
  chunkSize = 400
): Promise<Map<string, bigint>> {
  const claimed = new Map<string, bigint>();
  for (let i = 0; i < pairKeys.length; i += chunkSize) {
    const chunk = pairKeys.slice(i, i + chunkSize);
    const results = await client.multicall({
      contracts: chunk.map(([account, token]) => ({
        address: ctx.distributor,
        abi: URD_CLAIMED_ABI,
        functionName: "claimed" as const,
        args: [account as `0x${string}`, token as `0x${string}`],
      })),
      blockNumber: ctx.pinnedBlock,
      allowFailure: false,
    });
    chunk.forEach(([account, token], j) => {
      claimed.set(`${account}:${token}`, results[j] as bigint);
    });
  }
  return claimed;
}

/**
 * Cumulative-preservation invariants over the UNION of baseline and proposed
 * pairs (Codex review finding #3 — stronger than `new >= claimedOnChain`):
 *
 *  - a pair present in the baseline must not shrink: current >= previous;
 *  - a baseline pair may disappear only if fully claimed on-chain
 *    (claimedOnChain >= previous), otherwise the remainder becomes
 *    unclaimable because claim() only verifies against the current root;
 *  - every proposed amount must be >= claimedOnChain (URD claim() would
 *    revert with a lower cumulative amount — leaf unclaimable).
 */
export function checkPreservation(
  ctx: PreservationContext,
  current: PairMap,
  baseline: PairMap,
  claimedOnChain: Map<string, bigint>,
  violations: Violation[]
): void {
  const tag = { target: ctx.target, chainId: ctx.chainId };

  for (const [account, tokens] of baseline) {
    for (const [token, prevAmount] of tokens) {
      const key = `${account}:${token}`;
      const currAmount = current.get(account)?.get(token);
      const claimed = claimedOnChain.get(key) ?? 0n;
      if (currAmount === undefined) {
        if (claimed < prevAmount) {
          violations.push({
            invariant: "PRESERVE_PAIR_REMOVED",
            severity: "CRITICAL",
            ...tag,
            subject: `${account} / ${token}`,
            detail:
              `pair removed with unclaimed remainder: previous=${prevAmount} ` +
              `claimedOnChain=${claimed} (loses ${prevAmount - claimed})`,
            deficit: prevAmount - claimed,
          });
        }
        continue;
      }
      if (currAmount < prevAmount) {
        violations.push({
          invariant: "PRESERVE_AMOUNT_REDUCED",
          severity: "CRITICAL",
          ...tag,
          subject: `${account} / ${token}`,
          detail: `cumulative amount reduced: previous=${prevAmount} current=${currAmount}`,
          deficit: prevAmount - currAmount,
        });
      }
    }
  }

  for (const [account, tokens] of current) {
    for (const [token, currAmount] of tokens) {
      const claimed = claimedOnChain.get(`${account}:${token}`) ?? 0n;
      if (currAmount < claimed) {
        violations.push({
          invariant: "PRESERVE_BELOW_CLAIMED",
          severity: "CRITICAL",
          ...tag,
          subject: `${account} / ${token}`,
          detail: `proposed amount ${currAmount} < claimedOnChain ${claimed} (claim() would revert)`,
          deficit: claimed - currAmount,
        });
      }
    }
  }
}

/** Union of pair keys across current and baseline, for the claimed() fetch. */
export function unionPairKeys(current: PairMap, baseline: PairMap): [string, string][] {
  const seen = new Set<string>();
  const keys: [string, string][] = [];
  for (const map of [current, baseline]) {
    for (const [account, tokens] of map) {
      for (const token of tokens.keys()) {
        const key = `${account}:${token}`;
        if (!seen.has(key)) {
          seen.add(key);
          keys.push([account, token]);
        }
      }
    }
  }
  return keys;
}
