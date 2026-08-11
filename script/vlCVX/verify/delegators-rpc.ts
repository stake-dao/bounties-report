/**
 * vlCVX on-chain delegator verification (post on-chain cutover).
 *
 * Recomputes each protocol's delegation attribution from epoch-pinned chain
 * state and compares it wei-exact against repartition_delegation.json
 * (+ chain-split files):
 *
 * 1. Round binding — the artifact's proposalId/epoch must match the on-chain
 *    proposal resolved for the period (same pinning as generation).
 * 2. Delegate set — on-chain delegate voters (voters with
 *    GaugeDelegation.balanceAtEpochOf > 0) vs the file's perDelegate keys;
 *    a delegate voter that earned rewards with delegated weight but was paid
 *    as a plain voter (the epoch-230 0x52ea… incident class) fails.
 * 3. Per delegate — delegator enumeration via DelegateSet logs with the
 *    exact completeness assert against the contract's own accounting,
 *    contributing weights AT THE VOTE via GaugeVoteHelper (not raw VP, not
 *    the mutable epoch table), reconciliation against the applied vote,
 *    wei-exact largest-remainder split of the file's pools, and
 *    Votium-registry forwarding facts at the proposal-end block.
 *
 * Every read is pinned to the proposal/epoch, so re-running days later gives
 * identical results.
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/delegators-rpc.ts [--timestamp <ts>] [--gauge-type <curve|fxn|all>]
 *
 * Exit code: 0 = artifact matches the recomputation, 1 = mismatch.
 */

import * as dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { formatUnits } from "viem";
import { getClient } from "../../utils/getClients";
import {
  CVX_SPACE,
  CVX_FXN_SPACE,
  WEEK,
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
  CVX_GAUGE_DELEGATION,
  CVX_GAUGE_VOTE_HELPER,
  VOTIUM_FORWARDER,
} from "../../utils/constants";
import {
  getOnChainProposal,
  getOnChainVoters,
  getVoteOf,
} from "../../utils/gaugeVotePlatform";
import {
  getOnChainDelegators,
  getContributingWeightsAtVoteRaw,
} from "../../utils/onChainDelegation";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import { splitAmountByWeights } from "../2_repartition/delegators";
import {
  MergedDelegateLeg,
  WalletTokenAmounts,
  compareDelegateAttribution,
  delegateSetIssues,
  loadDelegationArtifacts,
  loadRepartitionVoterKeys,
  mergeDelegationChainFiles,
} from "./delegatorsVerifyCore";

dotenv.config();

const BALANCE_CHUNK = 400;

const DELEGATION_BALANCE_ABI = [
  {
    inputs: [
      { name: "epoch", type: "uint256" },
      { name: "delegate", type: "address" },
    ],
    name: "balanceAtEpochOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const delegatedBalances = async (
  voters: string[],
  epoch: number,
  client: any
): Promise<bigint[]> => {
  const out: bigint[] = [];
  for (let i = 0; i < voters.length; i += BALANCE_CHUNK) {
    const chunk = voters.slice(i, i + BALANCE_CHUNK);
    const results = (await client.multicall({
      allowFailure: false,
      contracts: chunk.map((voter) => ({
        address: CVX_GAUGE_DELEGATION as `0x${string}`,
        abi: DELEGATION_BALANCE_ABI,
        functionName: "balanceAtEpochOf",
        args: [BigInt(epoch), voter],
      })),
    })) as bigint[];
    out.push(...results);
  }
  return out;
};

const verifyGaugeType = async (
  gt: "curve" | "fxn",
  timestamp: number,
  client: any
): Promise<string[]> => {
  const issues: string[] = [];
  const platform =
    gt === "curve" ? CVX_GAUGE_VOTE_PLATFORM_CURVE : CVX_GAUGE_VOTE_PLATFORM_FXN;
  const space = gt === "curve" ? CVX_SPACE : CVX_FXN_SPACE;
  const dirAbs = path.join(
    __dirname,
    `../../../bounties-reports/${timestamp}/vlCVX/${gt}`
  );

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Verifying ${gt.toUpperCase()} against on-chain state`);
  console.log("=".repeat(70));

  if (!fs.existsSync(path.join(dirAbs, "repartition.json"))) {
    issues.push(`${gt}: repartition.json missing — round artifacts absent`);
    console.log(`❌ repartition.json missing`);
    return issues;
  }

  const files = loadDelegationArtifacts(dirAbs);
  const proposal = await getOnChainProposal(platform, space, client, {
    targetPeriod: timestamp,
  });
  const proposalId = Number(proposal.id);
  const epoch = Number(proposal.snapshot);
  console.log(
    `On-chain proposal ${proposalId} (vlCVX epoch ${epoch}), end ${proposal.end}`
  );

  if (files.length > 0) {
    const [main] = files;
    if (String(main.proposalId) !== String(proposal.id)) {
      issues.push(
        `${gt}: artifact proposal ${main.proposalId} != on-chain proposal ${proposal.id} for this period`
      );
    }
    if (Number(main.snapshotBlock) !== epoch) {
      issues.push(
        `${gt}: artifact epoch ${main.snapshotBlock} != on-chain epoch ${epoch}`
      );
    }
    if (issues.length > 0) {
      for (const issue of issues) console.log(`❌ ${issue}`);
      return issues;
    }
  } else {
    console.log(
      `No repartition_delegation.json — legitimacy decided by the delegate-set check below`
    );
  }

  const votes = await getOnChainVoters(platform, proposalId, proposal, client);
  const voterAddresses = votes.map((v: { voter: string }) => v.voter);
  const balances = await delegatedBalances(voterAddresses, epoch, client);
  const delegateVoters = voterAddresses.filter((_, i) => balances[i] > 0n);
  console.log(
    `Voters: ${voterAddresses.length}, delegate voters (delegated weight > 0): ${delegateVoters.length}`
  );

  let merged: Record<string, MergedDelegateLeg> = {};
  try {
    merged = mergeDelegationChainFiles(files.map((f) => f.summary));
  } catch (error) {
    issues.push(`${gt}: ${(error as Error).message}`);
    console.log(`❌ ${(error as Error).message}`);
    return issues;
  }
  const fileDelegates = Object.keys(merged);
  const repartitionVoters = loadRepartitionVoterKeys(dirAbs);

  const delegateVoterSet = new Set(delegateVoters);
  const adjustedWeights: Record<string, bigint> = {};
  for (const d of delegateVoters) {
    if (fileDelegates.includes(d) || !repartitionVoters.has(d)) continue;
    const vote = await getVoteOf(platform, proposalId, d, client);
    adjustedWeights[d] = vote.adjustedWeight;
  }

  const setIssues = delegateSetIssues({
    fileDelegates,
    delegateVoters,
    repartitionVoters,
    adjustedWeights,
  });
  for (const issue of setIssues) console.log(`❌ ${issue}`);
  issues.push(...setIssues.map((i) => `${gt}: ${i}`));

  if (fileDelegates.length === 0) {
    if (issues.length === 0) {
      console.log(`✅ ${gt.toUpperCase()}: no delegation rewards this round — consistent`);
    }
    return issues;
  }

  const blockEnd = await getBlockNumberByTimestamp(proposal.end, "after", 1);
  console.log(`Votium forwarding facts read at block ${blockEnd} (proposal end)`);

  for (const delegate of fileDelegates) {
    if (!delegateVoterSet.has(delegate)) continue; // already flagged above

    let delegators: string[];
    try {
      delegators = await getOnChainDelegators(
        CVX_GAUGE_DELEGATION,
        delegate,
        epoch,
        client
      );
    } catch (error) {
      const msg = `delegate ${delegate}: delegator enumeration failed — ${(error as Error).message}`;
      issues.push(`${gt}: ${msg}`);
      console.log(`❌ ${msg}`);
      continue;
    }

    const weightsWei = await getContributingWeightsAtVoteRaw(
      CVX_GAUGE_VOTE_HELPER,
      platform,
      proposalId,
      delegate,
      delegators,
      client
    );
    const contributing = Object.values(weightsWei).filter((w) => w > 0n).length;

    const vote = await getVoteOf(platform, proposalId, delegate, client);
    const totalVp = Number(
      formatUnits(
        Object.values(weightsWei).reduce((acc, w) => acc + w, 0n),
        18
      )
    );
    const baseWeight = Number(formatUnits(vote.baseWeight, 18));
    const effectiveWeight = Number(
      formatUnits(vote.baseWeight + vote.adjustedWeight, 18)
    );
    const tolerance = 0.1 * delegators.length + 1;
    const drift = baseWeight + totalVp - effectiveWeight;
    if (!vote.voted || Math.abs(drift) > tolerance) {
      const msg =
        `delegate ${delegate}: contributing weights do not reconcile with the applied ` +
        `vote (base ${baseWeight.toFixed(2)} + helper ${totalVp.toFixed(2)} vs ` +
        `effective ${effectiveWeight.toFixed(2)}, drift ${drift.toFixed(2)}, ` +
        `tolerance ±${tolerance.toFixed(1)})`;
      issues.push(`${gt}: ${msg}`);
      console.log(`❌ ${msg}`);
      continue;
    }

    const recomputed: WalletTokenAmounts = {};
    try {
      for (const [token, amount] of Object.entries(merged[delegate].poolTokens)) {
        const split = splitAmountByWeights(amount, weightsWei);
        for (const [addr, amt] of Object.entries(split)) {
          if (amt === 0n) continue;
          (recomputed[addr] ??= {})[token] = amt;
        }
      }
    } catch (error) {
      const msg = `delegate ${delegate}: ${(error as Error).message}`;
      issues.push(`${gt}: ${msg}`);
      console.log(`❌ ${msg}`);
      continue;
    }

    const members = Object.keys(recomputed);
    const forwarded = await getForwardedDelegators(members, blockEnd);
    const forwarderFlags: Record<string, boolean> = {};
    members.forEach((wallet, i) => {
      forwarderFlags[wallet] =
        forwarded[i].toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
    });

    const legIssues = compareDelegateAttribution({
      delegate,
      fileLeg: merged[delegate],
      recomputed,
      forwarderFlags,
    });
    const fileFwd = Object.keys(merged[delegate].forwarders).length;
    const fileNonFwd = Object.keys(merged[delegate].nonForwarders).length;
    console.log(
      `delegate ${delegate}: ${delegators.length} delegators, ${contributing} contributing, ` +
        `${members.length} earning → file ${fileFwd} fwd + ${fileNonFwd} non-fwd — ` +
        (legIssues.length === 0 ? `exact match` : `MISMATCH (${legIssues.length})`)
    );
    for (const issue of legIssues.slice(0, 10)) console.log(`  ❌ ${issue}`);
    if (legIssues.length > 10) {
      console.log(`  … and ${legIssues.length - 10} more`);
    }
    issues.push(...legIssues.map((i) => `${gt}: ${i}`));
  }

  if (issues.length === 0) {
    const wallets = Object.values(merged).reduce(
      (acc, leg) =>
        acc +
        Object.keys(leg.forwarders).length +
        Object.keys(leg.nonForwarders).length,
      0
    );
    console.log(
      `✅ ${gt.toUpperCase()}: ${fileDelegates.length} delegate(s), ${wallets} wallets — ` +
        `wei-exact match with on-chain recomputation, forwarding flags match`
    );
  }
  return issues;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;
  let gaugeType: "curve" | "fxn" | "all" = "all";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) {
      timestamp = parseInt(args[++i]);
    } else if (args[i] === "--gauge-type" && args[i + 1]) {
      gaugeType = args[++i] as "curve" | "fxn" | "all";
    }
  }
  if (!timestamp) {
    timestamp = Math.floor(Math.floor(Date.now() / 1000) / WEEK) * WEEK;
  }

  console.log("=".repeat(70));
  console.log(`vlCVX On-Chain Delegator Verification — period ${timestamp}`);
  console.log("=".repeat(70));

  const gaugeTypes: Array<"curve" | "fxn"> =
    gaugeType === "all" ? ["curve", "fxn"] : [gaugeType];
  const client = await getClient(1);

  const allIssues: string[] = [];
  for (const gt of gaugeTypes) {
    allIssues.push(...(await verifyGaugeType(gt, timestamp, client)));
  }

  console.log("\n" + "=".repeat(70));
  if (allIssues.length === 0) {
    console.log("RESULT: artifacts match the on-chain recomputation");
  } else {
    console.log(`RESULT: FAILED — ${allIssues.length} violation(s)`);
    process.exitCode = 1;
  }
  console.log("=".repeat(70));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
