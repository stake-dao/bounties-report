/**
 * Verify vlCVX reward flow: CSV amounts match delegation + non-delegator split.
 *
 * Checks:
 * 1. CSV balance — CSV_total === delegation_total + nonDelegator_total per token (exact BigInt)
 * 2. Group split — forwarders + nonForwarders === totalTokens per token
 * 3. Attribution — per-delegate wallet sums conserve pools, groups and totals to the wei
 * 4. Cumulative merkle — curr ≈ prev + this_week_repart + nonFwd_deleg
 * 5. Forwarders sCRVUSD — cumulative monotonically increasing
 *
 * Usage:
 *   pnpm tsx script/vlCVX/verify/rewardFlow.ts [--timestamp WEEK]
 */

import * as fs from "fs";
import * as path from "path";
import { WEEK } from "../../utils/constants";
import { ChainCheck, verifyCSVBalance, REPORTS_DIR, readJSON, shortAddr } from "../../utils/verifyHelpers";
import { hasPerDelegateAttribution, getExactGroupAmounts } from "../../utils/delegationExact";

const SCRVUSD = "0x0655977feb2f289a4ab78af67bab0d17aab84367";
const LATEST_FORWARDERS_MERKLE = path.join(
  __dirname,
  "../../../bounties-reports/latest/vlCVX/vlcvx_merkle_delegators.json"
);

// ── Config ────────────────────────────────────────────────────────────────────

const VLCVX_CHECKS: ChainCheck[] = [
  {
    label: "Curve Mainnet",
    csv: "cvx.csv",
    chain: "1",
    repartition: "vlCVX/curve/repartition.json",
    delegation: "vlCVX/curve/repartition_delegation.json",
  },
  {
    label: "Curve Base",
    csv: "cvx.csv",
    chain: "8453",
    repartition: "vlCVX/curve/repartition_8453.json",
    delegation: "vlCVX/curve/repartition_delegation_8453.json",
  },
  {
    label: "FXN Mainnet",
    csv: "cvx_fxn.csv",
    chain: "1",
    repartition: "vlCVX/fxn/repartition.json",
    delegation: "vlCVX/fxn/repartition_delegation.json",
  },
];

interface GroupSplitCheck {
  label: string;
  delegation: string;
}

const GROUP_SPLIT_CHECKS: GroupSplitCheck[] = [
  { label: "Curve Mainnet", delegation: "vlCVX/curve/repartition_delegation.json" },
  { label: "Curve Base", delegation: "vlCVX/curve/repartition_delegation_8453.json" },
  { label: "FXN Mainnet", delegation: "vlCVX/fxn/repartition_delegation.json" },
];

interface CumulativeCheck {
  label: string;
  gaugeType: string;
}

const CUMULATIVE_CHECKS: CumulativeCheck[] = [
  { label: "Curve Mainnet", gaugeType: "curve" },
  { label: "FXN Mainnet", gaugeType: "fxn" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function bp(timestamp: number, rel: string): string {
  return path.join(REPORTS_DIR, String(timestamp), rel);
}

// ── Check 2: Group Split ──────────────────────────────────────────────────────

function verifyGroupSplit(timestamp: number): { allOk: boolean; results: string[] } {
  let allOk = true;
  const results: string[] = [];

  for (const cfg of GROUP_SPLIT_CHECKS) {
    results.push(`\n  === ${cfg.label}: Group Split ===`);

    const delegPath = bp(timestamp, cfg.delegation);
    if (!fs.existsSync(delegPath)) { results.push(`  ⚠️  File not found — skipping`); continue; }

    const data = readJSON(delegPath);
    const dist = data.distribution;

    if (!dist.totalPerGroup || !dist.totalTokens) {
      results.push(`  ⚠️  No totalPerGroup/totalTokens — skipping`);
      continue;
    }

    let checkOk = true;
    for (const [token, amounts] of Object.entries(dist.totalPerGroup) as [string, any][]) {
      const fwd = BigInt(amounts.forwarders);
      const nfwd = BigInt(amounts.nonForwarders);
      const total = BigInt(dist.totalTokens[token]);
      const sum = fwd + nfwd;
      const diff = total - sum;
      const ok = diff === 0n;
      if (!ok) { checkOk = false; allOk = false; }

      const icon = ok ? "✅" : "❌";
      results.push(
        `  ${icon} ${shortAddr(token.toLowerCase())} | fwd+nfwd=${sum.toString().padStart(28)} | total=${total.toString().padStart(28)} | diff=${diff.toString()}`
      );
    }
    results.push(checkOk ? `  RESULT: ✅ Group split exact` : `  RESULT: ❌ Group split MISMATCH`);
  }

  return { allOk, results };
}

// ── Check 3: Attribution Consistency ─────────────────────────────────────────
// Per-token group ratios legitimately diverge from the global VP scalar — the
// binding invariants are:
//   a. per delegate, per token: forwarder + non-forwarder wallet amounts sum
//      EXACTLY to the delegate's pool (checked by the reader),
//   b. across delegates: pools sum EXACTLY to totalTokens,
//   c. flattened wallet amounts sum EXACTLY to totalPerGroup (reader-checked).
// Files from before the on-chain cutover carry no perDelegate section and are
// skipped with a notice (historical periods only).

function verifyAttribution(timestamp: number): { allOk: boolean; results: string[] } {
  let allOk = true;
  const results: string[] = [];

  for (const cfg of GROUP_SPLIT_CHECKS) {
    results.push(`\n  === ${cfg.label}: Attribution ===`);

    const delegPath = bp(timestamp, cfg.delegation);
    if (!fs.existsSync(delegPath)) {
      results.push(`  ⚠️  File not found — skipping`);
      continue;
    }

    const data = readJSON(delegPath);
    const dist = data.distribution;

    if (!hasPerDelegateAttribution(dist)) {
      results.push(`  ⚠️  No perDelegate attribution (pre-cutover file) — skipping`);
      continue;
    }

    try {
      // Reader throws unless wallet sums == totalPerGroup, token by token.
      getExactGroupAmounts(dist, "forwarders");
      getExactGroupAmounts(dist, "nonForwarders");

      // Pools must sum exactly to totalTokens.
      const poolSums: Record<string, bigint> = {};
      for (const d of Object.values(dist.perDelegate) as any[]) {
        for (const [token, amount] of Object.entries(d.poolTokens as Record<string, string>)) {
          const key = token.toLowerCase();
          poolSums[key] = (poolSums[key] || 0n) + BigInt(amount);
        }
      }
      let poolOk = true;
      for (const [token, totalStr] of Object.entries(dist.totalTokens) as [string, string][]) {
        if ((poolSums[token.toLowerCase()] || 0n) !== BigInt(totalStr)) {
          poolOk = false;
          allOk = false;
          results.push(
            `  ❌ ${shortAddr(token.toLowerCase())} | delegate pools ${poolSums[token.toLowerCase()] || 0n} != totalTokens ${totalStr}`
          );
        }
      }
      if (poolOk) {
        results.push(
          `  ✅ ${Object.keys(dist.perDelegate).length} delegate pool(s) conserve exactly (wallet sums == totalPerGroup == totalTokens)`
        );
      }
    } catch (e: any) {
      allOk = false;
      results.push(`  ❌ Attribution inconsistent: ${e.message}`);
    }
  }

  return { allOk, results };
}

// ── Check 4: Cumulative Merkle ────────────────────────────────────────────────

function verifyCumulativeMerkle(timestamp: number): { allOk: boolean; results: string[] } {
  let allOk = true;
  const results: string[] = [];
  const prevTimestamp = timestamp - WEEK;

  for (const cfg of CUMULATIVE_CHECKS) {
    results.push(`\n  === ${cfg.label}: Cumulative Merkle ===`);

    const currPath = bp(timestamp, `vlCVX/${cfg.gaugeType}/merkle_data_non_delegators.json`);
    const prevPath = bp(prevTimestamp, `vlCVX/${cfg.gaugeType}/merkle_data_non_delegators.json`);
    const repartPath = bp(timestamp, `vlCVX/${cfg.gaugeType}/repartition.json`);
    const delegPath = bp(timestamp, `vlCVX/${cfg.gaugeType}/repartition_delegation.json`);

    if (!fs.existsSync(currPath) || !fs.existsSync(prevPath)) {
      results.push(`  ⚠️  Missing merkle files — skipping`);
      continue;
    }

    let currMerkle: any, prevMerkle: any, repartition: any, delegation: any;
    try {
      currMerkle = readJSON(currPath);
      prevMerkle = readJSON(prevPath);
      repartition = readJSON(repartPath);
      delegation = readJSON(delegPath);
    } catch (e: any) {
      results.push(`  ❌ Error reading files: ${e.message}`);
      allOk = false;
      continue;
    }

    const sumClaims = (merkle: any): Record<string, bigint> => {
      const totals: Record<string, bigint> = {};
      for (const [, claimData] of Object.entries(merkle.claims) as [string, any][]) {
        for (const [token, info] of Object.entries(claimData.tokens) as [string, any][]) {
          const key = token.toLowerCase();
          const amt = BigInt(typeof info === "string" ? info : info.amount);
          totals[key] = (totals[key] || 0n) + amt;
        }
      }
      return totals;
    };

    const currTotals = sumClaims(currMerkle);
    const prevTotals = sumClaims(prevMerkle);

    const repartPerToken: Record<string, bigint> = {};
    for (const [, gaugeData] of Object.entries(repartition.distribution) as [string, any][]) {
      for (const [token, amount] of Object.entries(gaugeData.tokens) as [string, string][]) {
        const key = token.toLowerCase();
        repartPerToken[key] = (repartPerToken[key] || 0n) + BigInt(amount);
      }
    }

    const nonFwdPerToken: Record<string, bigint> = {};
    if (delegation.distribution.totalPerGroup) {
      for (const [token, amounts] of Object.entries(delegation.distribution.totalPerGroup) as [string, any][]) {
        nonFwdPerToken[token.toLowerCase()] = BigInt(amounts.nonForwarders);
      }
    }

    const allTokens = new Set([...Object.keys(currTotals), ...Object.keys(prevTotals)]);
    let checkOk = true;
    let tokenCount = 0;

    for (const token of [...allTokens].sort()) {
      tokenCount++;
      const curr = currTotals[token] || 0n;
      const prev = prevTotals[token] || 0n;
      const repart = repartPerToken[token] || 0n;
      const nonFwd = nonFwdPerToken[token] || 0n;
      const expected = prev + repart + nonFwd;
      const diff = curr - expected;

      if (diff !== 0n) {
        const relError = curr > 0n ? Number(diff < 0n ? -diff : diff) / Number(curr) : Infinity;
        if (relError > 1e-6) {
          checkOk = false;
          allOk = false;
          results.push(
            `  ❌ ${shortAddr(token)} | curr=${curr.toString().padStart(28)} | expected=${expected.toString().padStart(28)} | diff=${diff.toString()} (${relError.toExponential(2)})`
          );
        }
      }
    }

    if (checkOk) results.push(`  ✅ All ${tokenCount} tokens: prev + repart + nonFwd = curr`);
  }

  return { allOk, results };
}

// ── Check 5: Forwarders sCRVUSD Coherence ─────────────────────────────────────

function verifyForwardersCRVUSD(timestamp: number): { allOk: boolean; results: string[] } {
  const results: string[] = ["\n  === Forwarders Merkle (sCRVUSD cumulative) ==="];

  const currPath = bp(timestamp, "vlCVX/merkle_data_delegators.json");

  if (!fs.existsSync(currPath)) {
    results.push("  ⚠️  merkle_data_delegators.json not found — delegators run (Tuesday) pending");
    return { allOk: true, results };
  }

  if (!fs.existsSync(LATEST_FORWARDERS_MERKLE)) {
    results.push("  ⚠️  No previous merkle at latest/vlCVX/vlcvx_merkle_delegators.json");
    return { allOk: true, results };
  }

  let currMerkle: any, prevMerkle: any;
  try {
    currMerkle = readJSON(currPath);
    prevMerkle = readJSON(LATEST_FORWARDERS_MERKLE);
  } catch (e: any) {
    results.push(`  ❌ Error reading forwarders merkle: ${e.message}`);
    return { allOk: false, results };
  }

  // Merkle token keys are checksummed; SCRVUSD const is lowercase — match case-insensitively.
  const sumScrvUsd = (claims: Record<string, any>): bigint => {
    let total = 0n;
    for (const c of Object.values(claims || {}) as any[]) {
      for (const [token, data] of Object.entries(c.tokens || {})) {
        if (token.toLowerCase() === SCRVUSD) total += BigInt((data as any)?.amount ?? 0);
      }
    }
    return total;
  };

  const currTotal = sumScrvUsd(currMerkle.claims);
  const prevTotal = sumScrvUsd(prevMerkle.claims);

  const weeklyAdd = currTotal - prevTotal;
  const ok = weeklyAdd > 0n;
  const icon = ok ? "✅" : "❌";

  results.push(
    `  ${icon} sCRVUSD cumulative: ${(Number(prevTotal) / 1e18).toFixed(2)} → ${(Number(currTotal) / 1e18).toFixed(2)} (+${(Number(weeklyAdd) / 1e18).toFixed(2)} this week)${!ok ? " — weekly addition must be > 0" : ""}`
  );
  results.push(
    `  Forwarder addresses: ${Object.keys(currMerkle.claims || {}).length} (curr) vs ${Object.keys(prevMerkle.claims || {}).length} (prev)`
  );

  return { allOk: ok, results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  let timestamp: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timestamp" && args[i + 1]) { timestamp = parseInt(args[++i]); }
    else if (args[i] === "--help") {
      console.log(`
Usage: pnpm tsx script/vlCVX/verify/rewardFlow.ts [options]

Options:
  --timestamp <ts>   Week epoch (default: current week)
  --help             Show this message
`);
      process.exit(0);
    }
  }

  if (!timestamp) {
    const now = Math.floor(Date.now() / 1000);
    timestamp = Math.floor(now / WEEK) * WEEK;
  }

  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  console.log("═".repeat(70));
  console.log(`  vlCVX Reward Flow Verification: ${timestamp} (${date})`);
  console.log("═".repeat(70));

  let allOk = true;

  const csvResult = verifyCSVBalance(timestamp, VLCVX_CHECKS);
  for (const line of csvResult.results) console.log(line);
  if (!csvResult.allOk) allOk = false;

  const splitResult = verifyGroupSplit(timestamp);
  for (const line of splitResult.results) console.log(line);
  if (!splitResult.allOk) allOk = false;

  const ratioResult = verifyAttribution(timestamp);
  for (const line of ratioResult.results) console.log(line);
  if (!ratioResult.allOk) allOk = false;

  const cumulResult = verifyCumulativeMerkle(timestamp);
  for (const line of cumulResult.results) console.log(line);
  if (!cumulResult.allOk) allOk = false;

  const forwardersResult = verifyForwardersCRVUSD(timestamp);
  for (const line of forwardersResult.results) console.log(line);
  if (!forwardersResult.allOk) allOk = false;

  console.log(`\n${"═".repeat(70)}`);
  console.log(allOk ? "  ✅ All vlCVX reward flow checks passed" : "  ❌ Some checks failed — see above");
  console.log("═".repeat(70));

  process.exit(allOk ? 0 : 1);
}

main();
