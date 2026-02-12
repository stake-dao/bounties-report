/**
 * sdPENDLE Weighted Balance Extraction
 *
 * Computes time-weighted average balances (TWAB) of sdPENDLE holders
 * over a specified period. Includes:
 *   1. Direct sdPENDLE gauge stakers
 *   2. asdPENDLE holders (decomposed, excluding Pendle market positions)
 *
 * Usage: pnpm tsx script/special-distribs/sdPendleWeightedBalances.ts
 */

import fs from "node:fs";
import path from "node:path";
import { getAddress, parseAbiItem, formatUnits, type PublicClient, type Address } from "viem";
import { getClient } from "../utils/getClients";

// ── Period ──────────────────────────────────────────────────
// Jan 29 2026 00:00 UTC → Feb 13 2026 00:00 UTC
const PERIOD_START = Date.UTC(2026, 0, 29) / 1000;
const PERIOD_END = Date.UTC(2026, 1, 13) / 1000;

// ── Contracts ───────────────────────────────────────────────
const SDPENDLE_GAUGE: Address = "0x50DC9aE51f78C593d4138263da7088A973b8184E";
const SDPENDLE_GAUGE_DEPLOY_BLOCK = 17_321_450;

const ASDPENDLE: Address = "0x606462126E4Bd5c4D153Fe09967e4C46C9c7FeCf";
const ASDPENDLE_DEPLOY_BLOCK = 22_222_749;

// ConcentratorStakeDAOLocker — deposits sdPENDLE in gauge on behalf of asdPENDLE vault
const CONCENTRATOR_LOCKER: Address = "0x1c0D72a330F2768dAF718DEf8A19BAb019EEAd09";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

// Addresses excluded from asdPENDLE decomposition (Pendle markets + infra)
const EXCLUDED_ASDPENDLE = new Set<string>([
  // Active Pendle market (Mar 2026)
  getAddress("0xC87D2D5a2117A495e0F04EF9304dA603a86B7Ad5"), // SY-asdPENDLE (~56.6% of supply)
  getAddress("0xbe570be4238bd9019aa8d575204f1daa27ee0a15"), // Market AMM
  getAddress("0xab422a9b3767f4f1a2443882f5c0d1a01f30cde2"), // PT-asdPENDLE
  getAddress("0xbf72d17a4be0eeffe1cbab96b5d64392fb1e6bea"), // YT-asdPENDLE
  // Expired Pendle market (Sep 2025)
  getAddress("0xae08c57475cb850751aD161917Ea941E2552CDF8"), // SY-asdPENDLE
  getAddress("0xfa19d3a9f73180c9e73d2811e0b66eeed612f728"), // Market AMM
  getAddress("0x18a137fd89142aad904ff6b8c6281c6beff9ab98"), // PT-asdPENDLE
  getAddress("0xbf76df71efa782751d22de5cc1827da71f590b9d"), // YT-asdPENDLE
  // Concentrator infra
  getAddress("0x695EB50A92AD2AEBB89C6dD1f3c7546A28411403"), // PlatformFeeBurner
  getAddress("0x94992Da38bE9aDADD359c2959588FdDFa2dFE5Cd"), // SdPendleGaugeStrategy
  getAddress("0x8bde1d771423B8d2FE0B046b934FB9a7F956aDe2"), // SdPendleBribeBurner
  ZERO,
]);

// ── ABIs ────────────────────────────────────────────────────
const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);
const TOTAL_ASSETS = parseAbiItem("function totalAssets() view returns (uint256)");
const TOTAL_SUPPLY = parseAbiItem("function totalSupply() view returns (uint256)");

// ── Types ───────────────────────────────────────────────────
interface BalEvent { timestamp: number; balance: bigint }
type Histories = Map<string, BalEvent[]>;

// ── Helpers ─────────────────────────────────────────────────

/** Binary search for block at a timestamp (no Etherscan API needed). */
async function blockAtTimestamp(client: PublicClient, ts: number): Promise<number> {
  const latest = Number((await client.getBlock({ blockTag: "latest" })).number);
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const t = Number((await client.getBlock({ blockNumber: BigInt(mid) })).timestamp);
    t < ts ? (lo = mid + 1) : (hi = mid);
  }
  return lo > 0 ? lo - 1 : 0;
}

/** Fetch Transfer events in 500k-block chunks. */
async function fetchTransfers(
  client: PublicClient,
  address: Address,
  from: number,
  to: number,
) {
  const CHUNK = 500_000;
  const out: { from: string; to: string; value: bigint; block: number }[] = [];
  for (let s = from; s <= to; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, to);
    const pct = Math.round(((s - from) / (to - from)) * 100);
    process.stdout.write(`\r  Fetching ${s}..${e} (${pct}%)`);
    const logs = await client.getLogs({
      address,
      event: TRANSFER,
      fromBlock: BigInt(s),
      toBlock: BigInt(e),
    });
    for (const l of logs) {
      out.push({
        from: getAddress(l.args.from!),
        to: getAddress(l.args.to!),
        value: l.args.value!,
        block: Number(l.blockNumber),
      });
    }
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return out.sort((a, b) => a.block - b.block);
}

/** Batch-fetch unique block timestamps. */
async function fetchBlockTimestamps(client: PublicClient, blocks: number[]) {
  const map = new Map<number, number>();
  const unique = [...new Set(blocks)].sort((a, b) => a - b);
  const BATCH = 100;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((b) => client.getBlock({ blockNumber: BigInt(b) }))
    );
    results.forEach((r, j) => map.set(batch[j], Number(r.timestamp)));
    if (i + BATCH < unique.length)
      process.stdout.write(`\r  Timestamps: ${i + BATCH}/${unique.length}`);
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return map;
}

/** Build per-address balance event histories from Transfer logs. */
function buildHistories(
  events: { from: string; to: string; value: bigint; block: number }[],
  blockTs: Map<number, number>,
  exclude = new Set<string>(),
): Histories {
  const bal = new Map<string, bigint>();
  const hist: Histories = new Map();

  const push = (addr: string, ts: number, after: bigint) => {
    if (!hist.has(addr)) hist.set(addr, []);
    hist.get(addr)!.push({ timestamp: ts, balance: after });
  };

  for (const { from, to, value, block } of events) {
    const ts = blockTs.get(block)!;
    if (from !== ZERO && !exclude.has(from)) {
      const v = (bal.get(from) || 0n) - value;
      const safe = v < 0n ? 0n : v;
      bal.set(from, safe);
      push(from, ts, safe);
    }
    if (to !== ZERO && !exclude.has(to)) {
      const v = (bal.get(to) || 0n) + value;
      bal.set(to, v);
      push(to, ts, v);
    }
  }
  return hist;
}

/** Time-weighted average balance over [start, end). */
function twab(events: BalEvent[], start: number, end: number): bigint {
  let cur = 0n;
  for (const e of events) {
    if (e.timestamp <= start) cur = e.balance;
    else break;
  }

  let last = start, sum = 0n;
  for (const e of events) {
    if (e.timestamp > start && e.timestamp <= end) {
      sum += cur * BigInt(e.timestamp - last);
      cur = e.balance;
      last = e.timestamp;
    }
  }
  sum += cur * BigInt(end - last);

  const dur = BigInt(end - start);
  return dur > 0n ? sum / dur : 0n;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const days = (PERIOD_END - PERIOD_START) / 86400;
  console.log("sdPENDLE Weighted Balance Extraction");
  console.log(`Period: ${new Date(PERIOD_START * 1000).toISOString()} → ${new Date(PERIOD_END * 1000).toISOString()} (${days}d)`);

  const client = await getClient(1);

  // 1. Period blocks
  console.log("\n1. Resolving period blocks...");
  const [startBlock, endBlock] = await Promise.all([
    blockAtTimestamp(client, PERIOD_START),
    blockAtTimestamp(client, PERIOD_END),
  ]);
  console.log(`  start=${startBlock}  end=${endBlock}`);

  // 2. Fetch Transfer events
  console.log("\n2. Fetching gauge Transfer events...");
  const gaugeEvts = await fetchTransfers(client, SDPENDLE_GAUGE, SDPENDLE_GAUGE_DEPLOY_BLOCK, endBlock);
  console.log(`  ${gaugeEvts.length} events`);

  console.log("\n3. Fetching asdPENDLE Transfer events...");
  const asdEvts = await fetchTransfers(client, ASDPENDLE, ASDPENDLE_DEPLOY_BLOCK, endBlock);
  console.log(`  ${asdEvts.length} events`);

  // 3. Block timestamps
  console.log("\n4. Fetching block timestamps...");
  const blockTs = await fetchBlockTimestamps(client, [
    ...gaugeEvts.map((e) => e.block),
    ...asdEvts.map((e) => e.block),
  ]);
  console.log(`  ${blockTs.size} unique blocks`);

  // 4. Balance histories
  console.log("\n5. Building balance histories...");
  const gaugeHist = buildHistories(gaugeEvts, blockTs);
  const asdHist = buildHistories(asdEvts, blockTs, EXCLUDED_ASDPENDLE);
  console.log(`  gauge: ${gaugeHist.size} addrs  asdPENDLE: ${asdHist.size} addrs`);

  // 5. Find Concentrator locker in gauge
  console.log("\n6. Identifying Concentrator locker in gauge...");
  let concentratorTWAB = 0n;
  if (gaugeHist.has(CONCENTRATOR_LOCKER)) {
    concentratorTWAB = twab(gaugeHist.get(CONCENTRATOR_LOCKER)!, PERIOD_START, PERIOD_END);
    console.log(`  ${formatUnits(concentratorTWAB, 18)} sdPENDLE (to decompose)`);
  } else {
    console.log("  WARNING: Concentrator locker not found in gauge");
  }

  // 6. Gauge staker TWABs (excluding concentrator)
  console.log("\n7. Computing gauge TWABs...");
  const final = new Map<string, bigint>();
  for (const [addr, evts] of gaugeHist) {
    if (addr === ZERO || addr === CONCENTRATOR_LOCKER) continue;
    const t = twab(evts, PERIOD_START, PERIOD_END);
    if (t > 0n) final.set(addr, t);
  }
  console.log(`  ${final.size} direct stakers`);

  // 7. asdPENDLE TWABs + decompose
  console.log("\n8. Decomposing asdPENDLE holders...");
  let totalAsd = 0n;
  const asdTwabs = new Map<string, bigint>();
  for (const [addr, evts] of asdHist) {
    const t = twab(evts, PERIOD_START, PERIOD_END);
    if (t > 0n) { asdTwabs.set(addr, t); totalAsd += t; }
  }
  console.log(`  ${asdTwabs.size} eligible holders, ${formatUnits(totalAsd, 18)} asdPENDLE total`);

  // Fetch exchange rate (for logging only — decomposition uses pro-rata of gauge position)
  const SCALE = 10n ** 18n;
  const [sA, sS, eA, eS] = await Promise.all([
    client.readContract({ address: ASDPENDLE, abi: [TOTAL_ASSETS], functionName: "totalAssets", blockNumber: BigInt(startBlock) }),
    client.readContract({ address: ASDPENDLE, abi: [TOTAL_SUPPLY], functionName: "totalSupply", blockNumber: BigInt(startBlock) }),
    client.readContract({ address: ASDPENDLE, abi: [TOTAL_ASSETS], functionName: "totalAssets", blockNumber: BigInt(endBlock) }),
    client.readContract({ address: ASDPENDLE, abi: [TOTAL_SUPPLY], functionName: "totalSupply", blockNumber: BigInt(endBlock) }),
  ]);
  const rateStart = sS > 0n ? (sA * SCALE) / sS : SCALE;
  const rateEnd = eS > 0n ? (eA * SCALE) / eS : SCALE;
  console.log(`  rate: ${formatUnits(rateStart, 18)} → ${formatUnits(rateEnd, 18)} sdPENDLE/asdPENDLE`);

  let decomposed = 0;
  if (concentratorTWAB > 0n && totalAsd > 0n) {
    for (const [addr, t] of asdTwabs) {
      const share = (t * concentratorTWAB) / totalAsd;
      if (share > 0n) {
        final.set(addr, (final.get(addr) || 0n) + share);
        decomposed++;
      }
    }
  }
  console.log(`  ${decomposed} holders decomposed`);

  // 8. Output
  const results = [...final.entries()].filter(([, t]) => t > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const total = results.reduce((s, [, t]) => s + t, 0n);

  const outDir = path.join(__dirname, "../../data");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // CSV
  const csv = [
    "address,weighted_balance_wei,weighted_balance,share_pct",
    ...results.map(([a, t]) => {
      const pct = total > 0n ? ((Number(t) / Number(total)) * 100).toFixed(6) : "0";
      return `${a},${t},${formatUnits(t, 18)},${pct}`;
    }),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "sdpendle_weighted_balances.csv"), csv);

  // JSON
  fs.writeFileSync(
    path.join(outDir, "sdpendle_weighted_balances.json"),
    JSON.stringify({
      metadata: {
        generatedAt: new Date().toISOString(),
        periodStart: new Date(PERIOD_START * 1000).toISOString(),
        periodEnd: new Date(PERIOD_END * 1000).toISOString(),
        startBlock, endBlock,
        durationDays: days,
        asdPendleRate: { start: formatUnits(rateStart, 18), end: formatUnits(rateEnd, 18) },
        totalHolders: results.length,
        directGaugeStakers: results.length - decomposed,
        asdPendleHolders: decomposed,
        totalWeightedBalance: formatUnits(total, 18),
      },
      holders: results.map(([address, t]) => ({
        address,
        weighted_balance_wei: t.toString(),
        weighted_balance: formatUnits(t, 18),
        share_pct: total > 0n ? ((Number(t) / Number(total)) * 100).toFixed(6) : "0",
      })),
    }, null, 2),
  );

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Total: ${results.length} holders, ${formatUnits(total, 18)} sdPENDLE`);
  console.log(`  ${results.length - decomposed} direct + ${decomposed} via asdPENDLE`);
  console.log(`\nTop 10:`);
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const [a, t] = results[i];
    console.log(`  ${i + 1}. ${a}: ${formatUnits(t, 18)} (${((Number(t) / Number(total)) * 100).toFixed(2)}%)`);
  }
  console.log(`\nSaved to data/sdpendle_weighted_balances.{csv,json}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
