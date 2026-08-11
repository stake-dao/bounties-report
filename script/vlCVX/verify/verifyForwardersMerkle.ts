/**
 * Aggregate + per-address check of the Tuesday delegators merkle.
 *
 * Runs as a deterministic gate (see script/verify/verificationScripts.ts): it
 * exits non-zero when the week's delta does not match what the period was
 * entitled to distribute, so a mispriced or mis-split pot stops the pipeline
 * before any root reaches the chain instead of being argued about by judges.
 *
 * Since ENG-2105 "entitled to distribute" is no longer "everything that
 * arrived": a period may hold back half of its Votium swap proceeds for the
 * next distribution, and may pay in a half withheld earlier. Both come from
 * the split breakdown the merkle wrote.
 */

import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config();
import { createPublicClient, http } from "viem";
import { getSCRVUsdTransfer } from "../utils";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { mainnet } from "../../utils/chains";
import { getPrimaryRpcUrl } from "../../utils/rpcConfig";
import { findPreviousMerkle } from "../../utils/merkle/findPreviousMerkle";
import { WEEK } from "../../utils/constants";
import {
  assertCarryoverMatchesChain,
  carryoverPath,
  classifyVotiumDeposits,
  findUnconsumedCarryovers,
  isVotiumSplitActive,
  parseCarryover,
  pooledVotiumRemainder,
  splitVotiumProceeds,
} from "../votiumSplit";

const SCRVUSD = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";

function parseTimestamp(argv: string[]): number {
  const flagIndex = argv.indexOf("--timestamp");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return Number.parseInt(argv[flagIndex + 1], 10);
  }
  const positional = argv.find((arg) => /^\d+$/.test(arg));
  if (positional) return Number.parseInt(positional, 10);
  return Math.floor(Date.now() / 1000 / WEEK) * WEEK;
}

const periodTs = parseTimestamp(process.argv.slice(2));
const reportsDir = path.join("bounties-reports", String(periodTs), "vlCVX");

const lc = (s: string) => s.toLowerCase();

const sumScrv = (m: any): bigint => {
  let t = 0n;
  for (const c of Object.values(m.claims || {}) as any[]) {
    const a = c?.tokens?.[SCRVUSD]?.amount;
    if (a) t += BigInt(a);
  }
  return t;
};

function buildClaimMap(m: any): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [addr, c] of Object.entries(m.claims || {}) as any[]) {
    const a = c?.tokens?.[SCRVUSD]?.amount;
    out[lc(addr)] = a ? BigInt(a) : 0n;
  }
  return out;
}

(async () => {
  const merklePath = path.join(reportsDir, "merkle_data_delegators.json");
  if (!fs.existsSync(merklePath)) {
    // Thursday (voters) runs reach this check before any delegators merkle
    // exists for the period — nothing to verify yet.
    console.log(
      `No delegators merkle for period ${periodTs} — nothing to verify (skipping).`
    );
    return;
  }

  const currMerkle = JSON.parse(fs.readFileSync(merklePath, "utf8"));
  // Baseline is the previous PERIOD's archived merkle, never `latest/`: once
  // this period has been published `latest/` IS this merkle, and the delta
  // would read as zero and match nothing.
  const { data: prevMerkle, foundAt } = findPreviousMerkle(
    periodTs,
    "vlCVX/merkle_data_delegators.json"
  );
  console.log(
    foundAt
      ? `Previous merkle: ${foundAt}`
      : "No previous merkle found (scanned 12 weeks) — treating as first week"
  );

  const breakdownPath = path.join(reportsDir, "delegators_split_breakdown.json");
  const breakdown = fs.existsSync(breakdownPath)
    ? JSON.parse(fs.readFileSync(breakdownPath, "utf8"))
    : null;

  if (!breakdown) {
    const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
    if (periodTs < currentPeriod) {
      // Archived periods predate this artifact; there is nothing to reconcile
      // against, and failing here would block every historical rerun.
      console.log(
        `No delegators_split_breakdown.json for archived period ${periodTs} ` +
          "(predates the artifact) — reconciliation skipped."
      );
      return;
    }
    console.error(
      `\n❌ No delegators_split_breakdown.json for period ${periodTs} — the ` +
        "merkle step writes it, so its absence means the artifacts do not " +
        "describe this merkle."
    );
    process.exit(1);
  }

  const curveDelegPath = path.join(
    reportsDir,
    "curve",
    "repartition_delegation.json"
  );
  if (!fs.existsSync(curveDelegPath)) {
    console.error(`❌ Missing curve repartition delegation: ${curveDelegPath}`);
    process.exit(1);
  }
  const curveDeleg = JSON.parse(
    fs.readFileSync(curveDelegPath, "utf8")
  ).distribution;
  let fxnDeleg: any = null;
  const fxnPath = path.join(reportsDir, "fxn", "repartition_delegation.json");
  if (fs.existsSync(fxnPath)) {
    fxnDeleg = JSON.parse(fs.readFileSync(fxnPath, "utf8")).distribution;
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(getPrimaryRpcUrl(1)),
  });
  // Re-read the SAME window the merkle measured, not "up to now": a deposit
  // landing between the merkle and this check would otherwise show up as a
  // mismatch and stop the pipeline over money nobody claimed to distribute.
  const minBlock =
    typeof breakdown.fromBlock === "number"
      ? breakdown.fromBlock
      : await getClosestBlockTimestamp("ethereum", periodTs);
  const currentBlock =
    typeof breakdown.toBlock === "number"
      ? breakdown.toBlock
      : Number(await publicClient.getBlockNumber());
  console.log(`Block range: ${minBlock} → ${currentBlock}`);

  const t = await getSCRVUsdTransfer(minBlock, currentBlock);
  console.log(
    "On-chain sCRVUSD received this week:",
    (Number(t.amount) / 1e18).toFixed(6)
  );
  console.log("Tx hashes:", t.txHashes.length);

  const onchainTotal = t.amount;
  const prevTotal = sumScrv(prevMerkle);
  const currTotal = sumScrv(currMerkle);
  const delta = currTotal - prevTotal;

  console.log("\n=== Cumulative merkle ===");
  console.log("Prev cumulative:", (Number(prevTotal) / 1e18).toFixed(6));
  console.log("Curr cumulative:", (Number(currTotal) / 1e18).toFixed(6));
  console.log("Delta (this week):", (Number(delta) / 1e18).toFixed(6));

  const withheld = BigInt(breakdown.votium?.withheld ?? "0");
  const carriedIn = BigInt(breakdown.votium?.carriedIn ?? "0");

  const tolerance = BigInt(10 ** 15);
  const buffer = BigInt(10 ** 14);
  const expectedDistributed = onchainTotal - withheld + carriedIn - buffer;

  // Three-way check, in two independent parts:
  //  - merkle vs artifact: the week's delta must be the pot the merkle says it
  //    distributed. Always checked, and immune to deposits landing between the
  //    merkle and this run.
  //  - artifact vs chain: only when the artifact recorded the window it
  //    measured. Older artifacts (pre-ENG-2105) cannot be reproduced exactly,
  //    so those two checks are reported as skipped rather than failed on drift.
  const recordedAvailable = BigInt(breakdown.availableForDistribution);
  const hasRecordedWindow =
    typeof breakdown.fromBlock === "number" &&
    typeof breakdown.toBlock === "number";
  const recordedReceived =
    breakdown.received !== undefined ? BigInt(breakdown.received) : onchainTotal;
  const receivedMatchesChain = recordedReceived === onchainTotal;
  const potArithmeticOk = recordedAvailable === expectedDistributed;
  const potDrift = delta - recordedAvailable;
  const potOk = potDrift >= -tolerance && potDrift <= tolerance;

  // Re-derive the Votium adjustments from their own sources — chain receipts,
  // the period's claim data, the carryover artifacts — instead of trusting the
  // numbers the merkle recorded. Without this the gate only proves the
  // breakdown agrees with itself, and a merkle that withheld nothing when it
  // should have would sail through.
  const votiumFailures: string[] = [];
  if (hasRecordedWindow) {
    const splitActive = isVotiumSplitActive(periodTs);
    const classification = await classifyVotiumDeposits(
      (txHash) =>
        publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` }),
      t.transfers
    );
    const remainder = splitActive
      ? pooledVotiumRemainder(periodTs)
      : { claimDataPresent: false, hasRemainder: false };
    const expectedWithheld =
      splitActive && remainder.hasRemainder
        ? splitVotiumProceeds(classification.votiumAmount).carried
        : 0n;
    if (expectedWithheld !== withheld) {
      votiumFailures.push(
        `breakdown withheld ${withheld} wei but the chain and claim data imply ` +
          `${expectedWithheld} wei (votium receipts ${classification.votiumAmount}, ` +
          `week A: ${splitActive && remainder.hasRemainder})`
      );
    }

    const carriedInFrom: number[] = breakdown.votium?.carriedInFrom ?? [];
    let expectedCarriedIn = 0n;
    for (const carryPeriod of carriedInFrom) {
      const file = carryoverPath(carryPeriod);
      if (!fs.existsSync(file)) {
        votiumFailures.push(
          `breakdown claims a carryover from period ${carryPeriod} but ${file} does not exist`
        );
        continue;
      }
      const carry = parseCarryover(
        JSON.parse(fs.readFileSync(file, "utf8")),
        carryPeriod
      );
      await assertCarryoverMatchesChain(carry, async (fromBlock, toBlock) => {
        const range = await getSCRVUsdTransfer(fromBlock, toBlock);
        return classifyVotiumDeposits(
          (txHash) =>
            publicClient.getTransactionReceipt({
              hash: txHash as `0x${string}`,
            }),
          range.transfers
        );
      });
      expectedCarriedIn += carry.carried;
    }
    if (expectedCarriedIn !== carriedIn) {
      votiumFailures.push(
        `breakdown carried in ${carriedIn} wei but the artifacts it names hold ${expectedCarriedIn} wei`
      );
    }

    if (splitActive) {
      // A half that was available and simply not paid would sit there
      // indefinitely — the whole point of the carryover is that it cannot.
      const missed = findUnconsumedCarryovers(periodTs).filter(
        (found) => !carriedInFrom.includes(found.period)
      );
      for (const found of missed) {
        votiumFailures.push(
          `carryover from period ${found.period} (${found.carry.carried} wei) ` +
            "was available but this merkle did not distribute it"
        );
      }
    }
  }

  console.log("\n=== On-chain vs merkle delta ===");
  if (withheld > 0n || carriedIn > 0n) {
    console.log("Votium withheld for next week:", withheld.toString());
    console.log(
      `Votium carried in from [${(breakdown.votium?.carriedInFrom ?? []).join(", ")}]:`,
      carriedIn.toString()
    );
  }
  console.log(
    "Expected (onchain - withheld + carried - buffer 1e14):",
    (Number(expectedDistributed) / 1e18).toFixed(6)
  );
  console.log(
    "Actual delta in merkle:          ",
    (Number(delta) / 1e18).toFixed(6)
  );
  console.log("Pot recorded by the merkle:      ", recordedAvailable.toString());
  console.log("Drift vs recorded pot:", potDrift.toString(), "wei");
  console.log("Merkle pays its own pot (±1e15):", potOk ? "✅" : "❌");
  if (hasRecordedWindow) {
    console.log(
      "Artifact matches chain over its window:",
      receivedMatchesChain && potArithmeticOk ? "✅" : "❌"
    );
  } else {
    console.log(
      "Artifact predates the recorded block window — chain reconciliation skipped"
    );
  }

  const prevMap = buildClaimMap(prevMerkle);
  const currMap = buildClaimMap(currMerkle);
  let regressions = 0,
    zeroDelta = 0,
    positiveDelta = 0;
  let totalDeltaPerAddr = 0n;
  const deltas: Record<string, bigint> = {};
  const overclaimers: { addr: string; prev: bigint; curr: bigint }[] = [];
  for (const [addr, curr] of Object.entries(currMap)) {
    const prev = prevMap[addr] || 0n;
    const d = curr - prev;
    deltas[addr] = d;
    if (d < 0n) {
      regressions++;
      overclaimers.push({ addr, prev, curr });
    } else if (d === 0n) zeroDelta++;
    else positiveDelta++;
    totalDeltaPerAddr += d;
  }
  console.log("\n=== Per-claimer delta ===");
  console.log("Positive delta:", positiveDelta);
  console.log("Zero delta:    ", zeroDelta);
  console.log(
    "Negative delta:",
    regressions,
    regressions === 0 ? "✅ no overclaim" : "❌ OVERCLAIM"
  );
  if (overclaimers.length) console.log(overclaimers.slice(0, 10));
  console.log(
    "Sum per-addr deltas:",
    (Number(totalDeltaPerAddr) / 1e18).toFixed(6)
  );
  console.log(
    "Matches cumulative delta:",
    totalDeltaPerAddr === delta ? "✅" : "❌"
  );

  const curveFwd: Record<string, string> = curveDeleg.forwarders || {};
  const fxnFwd: Record<string, string> = fxnDeleg?.forwarders || {};
  const curveLcKeys = Object.fromEntries(
    Object.keys(curveFwd).map((k) => [lc(k), k])
  );
  const fxnLcKeys = Object.fromEntries(
    Object.keys(fxnFwd).map((k) => [lc(k), k])
  );
  const curveAddrs = Object.keys(curveLcKeys);
  const fxnAddrs = Object.keys(fxnLcKeys);
  const onlyCurve = curveAddrs.filter((a) => !fxnAddrs.includes(a));
  const onlyFxn = fxnAddrs.filter((a) => !curveAddrs.includes(a));
  const overlap = curveAddrs.filter((a) => fxnAddrs.includes(a));

  console.log("\n=== Forwarders breakdown ===");
  console.log(
    "Curve forwarders:",
    curveAddrs.length,
    "| only-curve:",
    onlyCurve.length
  );
  console.log("FXN forwarders:  ", fxnAddrs.length, "| only-fxn:  ", onlyFxn.length);
  console.log("Overlap (both):  ", overlap.length);

  // Votium legs never appear in this merkle individually: individually
  // attributed legs are paid raw in the Thursday combined merkle, and the
  // pooled legs' value arrives swapped inside the pot. The whole pot follows
  // the split breakdown — no carve to subtract.

  // Per-address check against the split breakdown createDelegatorsMerkle
  // wrote: every wallet's delegator delta must equal the artifact's total
  // EXACTLY, and no wallet may have moved outside it.
  const expected: Record<string, bigint> = {};
  for (const [addr, row] of Object.entries(
    (breakdown.perWallet || {}) as Record<string, { total: string }>
  )) {
    expected[lc(addr)] = BigInt(row.total);
  }

  // Individual raw payouts replaced the aggregate fee claim: the legacy fee
  // recipient must not receive anything BEYOND what it earns as an ordinary
  // delegator-forwarder. It IS one (contributing weight under the Stake DAO
  // delegate on both platforms, Votium registry forwarding to our forwarder),
  // so a flat non-zero check would fire on organic earnings every week — the
  // incident class is a delta OUTSIDE the planned per-wallet entitlement.
  const LEGACY_FEE_RECIPIENT = "0xf930ebbd05ef8b25b1797b9b2109ddc9b0d43063";
  const feeDelta = deltas[LEGACY_FEE_RECIPIENT] || 0n;
  const feeEntitled = expected[LEGACY_FEE_RECIPIENT] ?? 0n;
  const feeOk = feeDelta === feeEntitled;
  console.log(
    `\nLegacy fee recipient delta: ${(Number(feeDelta) / 1e18).toFixed(6)} sCRVUSD ` +
      `(entitled as forwarder: ${(Number(feeEntitled) / 1e18).toFixed(6)}) ` +
      (feeOk ? "✅" : "❌ received value beyond its forwarder entitlement — legacy fee resurfacing")
  );

  console.log("\n=== Split breakdown ===");
  console.log("Artifact:", breakdownPath);
  console.log("Mode:", breakdown.mode);
  if (breakdown.pricesUsd) {
    console.log("Price vector used:", JSON.stringify(breakdown.pricesUsd));
  }

  let mismatches = 0;
  for (const [addr, exp] of Object.entries(expected)) {
    const actual = deltas[addr] || 0n;
    if (actual !== exp) {
      mismatches++;
      if (mismatches <= 10) {
        console.log(
          `  ❌ ${addr}: delegator delta ${(Number(actual) / 1e18).toFixed(6)} != expected ${(Number(exp) / 1e18).toFixed(6)}`
        );
      }
    }
  }
  let unexpected = 0;
  for (const [addr, d] of Object.entries(deltas)) {
    if (d !== 0n && expected[addr] === undefined) {
      unexpected++;
      if (unexpected <= 10) {
        console.log(
          `  ❌ ${addr}: nonzero delegator delta ${(Number(d) / 1e18).toFixed(6)} but absent from breakdown`
        );
      }
    }
  }
  const perAddressOk = mismatches === 0 && unexpected === 0;
  console.log(
    `Per-address check: ${perAddressOk ? "✅ all match" : `❌ ${mismatches} mismatch(es), ${unexpected} unexplained`}`
  );

  const failures: string[] = [];
  if (!potOk) {
    failures.push(
      `weekly delta ${delta} does not match the pot the merkle recorded ` +
        `${recordedAvailable} (drift ${potDrift} wei)`
    );
  }
  if (hasRecordedWindow && !receivedMatchesChain) {
    failures.push(
      `breakdown records ${recordedReceived} wei received but the chain shows ` +
        `${onchainTotal} wei over the same window (${minBlock} → ${currentBlock})`
    );
  }
  if (hasRecordedWindow && !potArithmeticOk) {
    failures.push(
      `breakdown pot ${recordedAvailable} does not equal received ${onchainTotal} ` +
        `- withheld ${withheld} + carried ${carriedIn} - buffer ${buffer}`
    );
  }
  failures.push(...votiumFailures);
  if (regressions > 0) failures.push(`${regressions} address(es) lost claimable value`);
  if (totalDeltaPerAddr !== delta) {
    failures.push("per-address deltas do not sum to the cumulative delta");
  }
  if (!feeOk) {
    failures.push(
      "legacy fee recipient received value beyond its forwarder entitlement"
    );
  }
  if (!perAddressOk) {
    failures.push(
      `${mismatches} per-address mismatch(es), ${unexpected} unexplained delta(s)`
    );
  }

  if (failures.length) {
    console.error(`\n❌ Forwarders merkle verification failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\n✅ Forwarders merkle verification passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
