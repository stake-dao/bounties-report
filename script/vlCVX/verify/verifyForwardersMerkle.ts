import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
dotenv.config();
import { getAddress, createPublicClient, http } from "viem";
import { getSCRVUsdTransfer } from "../utils";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { mainnet } from "../../utils/chains";

const SCRVUSD = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
const FEE_RECIPIENT = getAddress("0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063");

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
      process.env.WEB3_ALCHEMY_API_KEY
        ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
        : "https://rpc.flashbots.net"
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

  function verifyGroup(label: string, addrs: string[], lcKeys: Record<string, string>, shares: Record<string, string>) {
    if (addrs.length === 0) return 0;
    const ratios: number[] = [];
    let totalDelta = 0n;
    let totalShare = 0;
    let zeroAlloc = 0;
    for (const a of addrs) {
      const sh = parseFloat(shares[lcKeys[a]]);
      const d = deltas[a] || 0n;
      totalDelta += d;
      totalShare += sh;
      if (d === 0n && sh > 0) zeroAlloc++;
      if (sh > 0) ratios.push(Number(d) / sh);
    }
    if (ratios.length === 0) return 0;
    const min = Math.min(...ratios);
    const max = Math.max(...ratios);
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const relSpread = mean > 0 ? (max - min) / mean : 0;
    console.log(`\n[${label}] addrs=${addrs.length} sumShare=${totalShare.toFixed(6)} sumDelta=${(Number(totalDelta) / 1e18).toFixed(6)}`);
    console.log(`  delta/share min=${(min / 1e18).toFixed(6)} max=${(max / 1e18).toFixed(6)} mean=${(mean / 1e18).toFixed(6)}`);
    console.log(`  rel spread=${(relSpread * 100).toFixed(4)}% ${relSpread < 1e-4 ? "✅ proportional" : "⚠ inconsistent"}`);
    console.log(`  zero-delta despite share>0: ${zeroAlloc} ${zeroAlloc === 0 ? "✅" : "⚠"}`);
    return mean;
  }

  const curveAlloc = verifyGroup("Only-Curve forwarders", onlyCurve, curveLcKeys, curveFwd);
  const fxnAlloc = fxnDeleg ? verifyGroup("Only-FXN forwarders", onlyFxn, fxnLcKeys, fxnFwd) : 0;

  if (overlap.length) {
    console.log(`\n[Overlap (Curve+FXN)] addrs=${overlap.length}`);
    let bad = 0;
    for (const a of overlap) {
      const cSh = parseFloat(curveFwd[curveLcKeys[a]]);
      const fSh = parseFloat(fxnFwd[fxnLcKeys[a]]);
      const expected = BigInt(Math.floor(cSh * curveAlloc)) + BigInt(Math.floor(fSh * fxnAlloc));
      const actual = deltas[a] || 0n;
      const diff = actual - expected;
      const rel = expected > 0n ? Math.abs(Number(diff)) / Number(expected) : 0;
      if (rel > 1e-4) bad++;
    }
    console.log(`  outliers (>1e-4 rel diff): ${bad} ${bad === 0 ? "✅" : "⚠"}`);
  }

  const feeDelta = deltas[lc(FEE_RECIPIENT)] || 0n;
  console.log("\n=== Fee recipient ===");
  console.log("Address:", FEE_RECIPIENT);
  console.log("Delta this week:", (Number(feeDelta) / 1e18).toFixed(6), "sCRVUSD");

  const votiumDir = path.join("weekly-bounties", String(periodTs), "votium");
  const hasVotium = fs.existsSync(votiumDir);
  console.log("Votium data exists:", hasVotium ? "yes" : "no (fee should be 0)");
  if (!hasVotium) {
    console.log("Fee=0 expected:", feeDelta === 0n ? "✅" : `❌ unexpected fee ${feeDelta}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
