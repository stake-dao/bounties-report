import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config();
import { createPublicClient, http } from "viem";
import { getSCRVUsdTransfer } from "../utils";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { mainnet } from "../../utils/chains";
import { getPrimaryRpcUrl } from "../../utils/rpcConfig";

const SCRVUSD = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";

const periodTs = parseInt(process.argv[2] || "1777507200", 10);
const reportsDir = path.join("bounties-reports", String(periodTs), "vlCVX");

const curveDeleg = JSON.parse(
  fs.readFileSync(path.join(reportsDir, "curve", "repartition_delegation.json"), "utf8")
).distribution;
let fxnDeleg: any = null;
const fxnPath = path.join(reportsDir, "fxn", "repartition_delegation.json");
if (fs.existsSync(fxnPath)) {
  fxnDeleg = JSON.parse(fs.readFileSync(fxnPath, "utf8")).distribution;
}

const currMerkle = JSON.parse(
  fs.readFileSync(path.join(reportsDir, "merkle_data_delegators.json"), "utf8")
);
const prevMerkle = JSON.parse(
  fs.readFileSync("bounties-reports/latest/vlCVX/vlcvx_merkle_delegators.json", "utf8")
);

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
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(
      getPrimaryRpcUrl(1)
    ),
  });
  const currentBlock = Number(await publicClient.getBlockNumber());
  const minBlock = await getClosestBlockTimestamp("ethereum", periodTs);
  console.log(`Block range: ${minBlock} → ${currentBlock}`);

  const t = await getSCRVUsdTransfer(minBlock, currentBlock);
  console.log("On-chain sCRVUSD received this week:", (Number(t.amount) / 1e18).toFixed(6));
  console.log("Tx hashes:", t.txHashes.length);

  const onchainTotal = t.amount;
  const prevTotal = sumScrv(prevMerkle);
  const currTotal = sumScrv(currMerkle);
  const delta = currTotal - prevTotal;

  console.log("\n=== Cumulative merkle ===");
  console.log("Prev cumulative:", (Number(prevTotal) / 1e18).toFixed(6));
  console.log("Curr cumulative:", (Number(currTotal) / 1e18).toFixed(6));
  console.log("Delta (this week):", (Number(delta) / 1e18).toFixed(6));

  const tolerance = BigInt(10 ** 15);
  const buffer = BigInt(10 ** 14);
  const expectedDistributed = onchainTotal - buffer;

  console.log("\n=== On-chain vs merkle delta ===");
  console.log("Expected (onchain - buffer 1e14):", (Number(expectedDistributed) / 1e18).toFixed(6));
  console.log("Actual delta in merkle:          ", (Number(delta) / 1e18).toFixed(6));
  const overshoot = delta - expectedDistributed;
  console.log("Overshoot:", overshoot.toString(), "wei");
  console.log("Match (±1e15):", (overshoot >= -tolerance && overshoot <= tolerance) ? "✅" : "❌");

  const prevMap = buildClaimMap(prevMerkle);
  const currMap = buildClaimMap(currMerkle);
  let regressions = 0, zeroDelta = 0, positiveDelta = 0;
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
  console.log("Negative delta:", regressions, regressions === 0 ? "✅ no overclaim" : "❌ OVERCLAIM");
  if (overclaimers.length) console.log(overclaimers.slice(0, 10));
  console.log("Sum per-addr deltas:", (Number(totalDeltaPerAddr) / 1e18).toFixed(6));
  console.log("Matches cumulative delta:", totalDeltaPerAddr === delta ? "✅" : "❌");

  const curveFwd: Record<string, string> = curveDeleg.forwarders || {};
  const fxnFwd: Record<string, string> = fxnDeleg?.forwarders || {};
  const curveLcKeys = Object.fromEntries(Object.keys(curveFwd).map(k => [lc(k), k]));
  const fxnLcKeys = Object.fromEntries(Object.keys(fxnFwd).map(k => [lc(k), k]));
  const curveAddrs = Object.keys(curveLcKeys);
  const fxnAddrs = Object.keys(fxnLcKeys);
  const onlyCurve = curveAddrs.filter(a => !fxnAddrs.includes(a));
  const onlyFxn = fxnAddrs.filter(a => !curveAddrs.includes(a));
  const overlap = curveAddrs.filter(a => fxnAddrs.includes(a));

  console.log("\n=== Forwarders breakdown ===");
  console.log("Curve forwarders:", curveAddrs.length, "| only-curve:", onlyCurve.length);
  console.log("FXN forwarders:  ", fxnAddrs.length, "| only-fxn:  ", onlyFxn.length);
  console.log("Overlap (both):  ", overlap.length);

  // Votium legs never appear in this merkle: individually attributed legs
  // are paid raw in the Thursday combined merkle, and the pooled legs' value
  // arrives swapped inside the pot. The whole pot follows the split
  // breakdown — no carve to subtract.

  // Individual raw payouts replaced the aggregate fee claim: the legacy fee
  // recipient must not receive anything new, ever.
  const LEGACY_FEE_RECIPIENT = "0xf930ebbd05ef8b25b1797b9b2109ddc9b0d43063";
  const feeDelta = deltas[LEGACY_FEE_RECIPIENT] || 0n;
  console.log(
    `\nLegacy fee recipient delta: ${(Number(feeDelta) / 1e18).toFixed(6)} sCRVUSD ` +
      (feeDelta === 0n ? "✅" : "❌ individual payouts should have replaced the fee")
  );

  const adjustedDeltas: Record<string, bigint> = { ...deltas };

  // Per-address check against the split breakdown createDelegatorsMerkle
  // wrote: every wallet's delegator delta must equal the artifact's total
  // EXACTLY, and no wallet may have moved outside it.
  const breakdownPath = path.join(reportsDir, "delegators_split_breakdown.json");
  if (!fs.existsSync(breakdownPath)) {
    console.log(
      "\n⚠️  No delegators_split_breakdown.json for this period — per-address " +
        "delegator deltas cannot be verified (artifact is written by " +
        "createDelegatorsMerkle since the on-chain cutover).",
    );
    return;
  }

  const breakdown = JSON.parse(fs.readFileSync(breakdownPath, "utf8"));
  const expected: Record<string, bigint> = {};
  for (const [addr, row] of Object.entries(
    (breakdown.perWallet || {}) as Record<string, { total: string }>
  )) {
    expected[lc(addr)] = BigInt(row.total);
  }

  console.log("\n=== Split breakdown ===");
  console.log("Artifact:", breakdownPath);
  console.log("Mode:", breakdown.mode);
  if (breakdown.pricesUsd) {
    console.log("Price vector used:", JSON.stringify(breakdown.pricesUsd));
  }

  let mismatches = 0;
  for (const [addr, exp] of Object.entries(expected)) {
    const actual = adjustedDeltas[addr] || 0n;
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
  for (const [addr, d] of Object.entries(adjustedDeltas)) {
    if (d !== 0n && expected[addr] === undefined) {
      unexpected++;
      if (unexpected <= 10) {
        console.log(
          `  ❌ ${addr}: nonzero delegator delta ${(Number(d) / 1e18).toFixed(6)} but absent from breakdown`
        );
      }
    }
  }
  console.log(
    `Per-address check: ${mismatches === 0 && unexpected === 0 ? "✅ all match" : `❌ ${mismatches} mismatch(es), ${unexpected} unexplained`}`
  );

})().catch(e => { console.error(e); process.exit(1); });
