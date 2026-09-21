import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { erc20Abi, formatUnits, type PublicClient } from "viem";
import {
  WEEK,
  WETH_CHAIN_IDS,
} from "../../utils/constants";
import { getClient } from "../../utils/getClients";
import { PROTOCOLS_TOKENS } from "../../utils/reportUtils";
import { sendTelegramMessage } from "../../utils/telegramUtils";
import { checkSdAttribution } from "./reconstructSdMerkle";
import { loadCompletion, type FxnCompletion } from "../../reports/fxnCompletion";
import type { SdTransferDestination } from "./reconstructSdMerkle";
import { amountDifference, ATTRIBUTION_DUST_WEI, CSV_ROUNDING_WEI, reportAmount } from "./reportAmounts";
import { verifySourceClaims } from "./reportSources";
import { verifyCurveReportInputs } from "./reportInputs";

const REPORTS_DIR = "bounties-reports";
const WEEKLY_DIR = "weekly-bounties";
const SOURCES = ["votemarket_v1", "votemarket_v2"] as const;
const SOURCE_DIR: Record<(typeof SOURCES)[number], string> = {
  votemarket_v1: "votemarket",
  votemarket_v2: "votemarket-v2",
};
const PROTOCOLS = ["curve", "fxn"] as const;

export type ReportProtocol = (typeof PROTOCOLS)[number];

export interface ReportGateResult {
  id: "R1" | "R2" | "R3" | "R4" | "R5";
  name: string;
  ok: boolean;
  detail: string;
  warnings?: string[];
}

interface Claim {
  gauge?: unknown;
  rewardToken?: unknown;
  amount?: unknown;
  chainId?: number;
  isWrapped?: boolean;
}

interface CsvRow {
  period?: string;
  gaugeName: string;
  gauge: string;
  rewardToken: string;
  rewardAmount: bigint;
  sdAmount: bigint;
  share: bigint;
  file: string;
  lane: "sd" | "raw" | "delegation";
}

interface Attribution {
  period?: number;
  protocol?: string;
  aggregator?: string;
  perToken?: Record<string, { sd: number; mappedWeth?: number; mappedNative?: number }>;
  totals: {
    sdInTotal: number;
    sdAssigned: number;
    wethInTotal: number;
    wethOutTotal: number;
  };
  dropped?: { tokensNotSwapped?: string[] };
  txs?: Array<{
    tx?: string;
    wethIn?: number;
    wethOut?: number;
    sdIn?: number;
    nativeOut?: number;
    tokenSd?: Record<string, number>;
    tokenWeth?: Record<string, number>;
    wethBasis?: number;
    nativeShareSd?: number;
  }>;
  cleanupTransactions?: Array<{
    tx?: string;
    sdReceived?: number;
    perTokenSd?: Record<string, number>;
    residualWethConsumed?: Record<string, number>;
  }>;
}

const lc = (value: string) => value.toLowerCase();

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function sourcePath(period: number, source: (typeof SOURCES)[number]): string {
  return path.join(WEEKLY_DIR, String(period), SOURCE_DIR[source], "claimed_bounties.json");
}

function claimsForProtocol(file: string, protocol: ReportProtocol): Claim[] {
  const data = readJson<Record<string, unknown>>(file);
  const raw = data[protocol];
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object") throw new Error(`${file}: invalid ${protocol} claims`);
  return Object.values(raw as Record<string, Claim>);
}

function claimedVolumes(file: string, protocol: ReportProtocol): Map<string, bigint> {
  const volumes = new Map<string, bigint>();
  for (const claim of claimsForProtocol(file, protocol)) {
    if (typeof claim.amount !== "string" || !/^\d+$/.test(claim.amount)) {
      throw new Error(`${file} ${protocol} claim has invalid amount`);
    }
    for (const address of [claim.gauge, claim.rewardToken]) {
      if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address) || /^0x0{40}$/i.test(address)) {
        throw new Error(`${file} ${protocol} claim has invalid gauge/token`);
      }
    }
    const key = `${claim.chainId ?? 1}/${lc(claim.rewardToken as string)}`;
    volumes.set(key, (volumes.get(key) ?? 0n) + BigInt(claim.amount));
  }
  return volumes;
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return (sorted[1] + sorted[2]) / 2n;
}

export function withinVolumeBand(current: bigint, history: bigint[]): boolean {
  if (history.length !== 4) return false;
  // Steady-state zero: no volume now and none across the whole trailing window is a
  // consistently unused source (e.g. a retired platform), not a collapse.
  if (current <= 0n) return history.every((value) => value <= 0n);
  const middle = median(history);
  if (middle <= 0n) return false;
  const difference = current > middle ? current - middle : middle - current;
  return difference * 2n <= middle;
}

export function runR1(period: number, protocols: readonly ReportProtocol[]): ReportGateResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  let checked = 0;
  for (const protocol of protocols) {
    for (const source of SOURCES) {
      const currentFile = sourcePath(period, source);
      if (!existsSync(currentFile)) {
        failures.push(`${protocol}/${source}: weekly claims file missing`);
        continue;
      }
      const historyFiles = [1, 2, 3, 4].map((back) => sourcePath(period - back * WEEK, source));
      const missingHistory = historyFiles.find((file) => !existsSync(file));
      if (missingHistory) {
        warnings.push(`${protocol}/${source}: historical comparison unavailable (${missingHistory})`);
      }
      const current = claimedVolumes(currentFile, protocol);
      if (!missingHistory) {
        const history = historyFiles.map((file) => claimedVolumes(file, protocol));
        for (const token of new Set([...current.keys(), ...history.flatMap((entry) => [...entry.keys()])])) {
          const value = current.get(token) ?? 0n;
          const trailing = history.map((entry) => entry.get(token) ?? 0n);
          if (!withinVolumeBand(value, trailing)) {
            warnings.push(`${protocol}/${source}/${token}: unusual volume, raw amount=${value}, trailing median=${median(trailing)}`);
          }
        }
      }
      checked++;
    }
  }
  return {
    id: "R1",
    name: "Source files",
    ok: failures.length === 0,
    detail: failures.length === 0
      ? `${checked} protocol-source files valid; token volume changes are advisory`
      : failures.join("; "),
    warnings,
  };
}

function readCsvRows(period: number, protocol: ReportProtocol, includeOtherLanes = false): CsvRow[] {
  const rows: CsvRow[] = [];
  const files: Array<[string, CsvRow["lane"]]> = [[`${protocol}.csv`, "sd"], [`${protocol}-otc.csv`, "sd"]];
  if (includeOtherLanes) files.push([`raw/${protocol}/${protocol}.csv`, "raw"], [`delegation/${protocol}.csv`, "delegation"]);
  for (const [relative, lane] of files) {
    const file = path.join(REPORTS_DIR, String(period), relative);
    if (!existsSync(file)) continue;
    const parsed = parseCsv(readFileSync(file, "utf8"), {
      columns: true,
      delimiter: ";",
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    for (const row of parsed) {
      rows.push({
        period: row.Period,
        gaugeName: (row["Gauge Name"] ?? "").trim().toLowerCase(),
        gauge: lc(row["Gauge Address"] ?? ""),
        rewardToken: lc(row["Reward Address"] ?? ""),
        rewardAmount: reportAmount(row["Reward Amount"], `${file} reward amount`),
        sdAmount: lane === "sd" ? reportAmount(row["Reward sd Value"], `${file} sd amount`) : 0n,
        share: lane === "sd" ? reportAmount(row["Share % per Protocol"], `${file} share`) : 0n,
        file,
        lane,
      });
    }
  }
  return rows;
}

function rootGaugeMap(period: number, protocol: ReportProtocol, rows: CsvRow[]): Map<string, string> {
  // claimed_bounties.json records the L2 root gauge; the CSV reports the child gauge.
  // The vlCVX report (cvx.csv) lists gauges by root address under the same name, so it
  // resolves root -> child by name. A gauge with no Convex-side claim this week is
  // missing from the current cvx.csv, so the trailing four weeks are consulted too,
  // the current period taking precedence.
  const actualByName = new Map(rows.map((row) => [row.gaugeName, row.gauge]));
  const mapping = new Map<string, string>();
  for (const back of [0, 1, 2, 3, 4]) {
    const auxiliary = path.join(
      REPORTS_DIR,
      String(period - back * WEEK),
      protocol === "curve" ? "cvx.csv" : "cvx_fxn.csv",
    );
    if (!existsSync(auxiliary)) continue;
    const parsed = parseCsv(readFileSync(auxiliary, "utf8"), {
      columns: true,
      delimiter: ";",
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    for (const row of parsed) {
      const name = (row["Gauge Name"] ?? "").trim().toLowerCase();
      const root = lc(row["Gauge Address"] ?? "");
      const actual = actualByName.get(name);
      if (root && actual && !mapping.has(root)) mapping.set(root, actual);
    }
  }
  return mapping;
}

const provenanceKey = (gauge: string, token: string) => `${lc(gauge)}|${lc(token)}`;

export async function runR2(period: number, protocols: readonly ReportProtocol[], client: PublicClient): Promise<ReportGateResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const decimals = new Map<string, number>();
  let rowCount = 0;
  let claimCount = 0;
  for (const protocol of protocols) {
    const rows = readCsvRows(period, protocol, true);
    if (!rows.some((row) => row.lane === "sd")) failures.push(`${protocol}: sd report missing or empty`);
    const gaugeMap = rootGaugeMap(period, protocol, rows);
    const rowKeys = new Set<string>();
    for (const row of rows) {
      if (row.period && Number(row.period) !== period) {
        failures.push(`${protocol} OTC row has period ${row.period}, expected ${period}`);
      }
      rowKeys.add(provenanceKey(row.gauge, row.rewardToken));
      rowCount++;
    }

    const claims: Claim[] = [];
    for (const source of SOURCES) {
      const file = sourcePath(period, source);
      if (existsSync(file)) claims.push(...claimsForProtocol(file, protocol));
    }
    const claimKeys = new Set<string>();
    const claimed = new Map<string, bigint>();
    for (const claim of claims) {
      if (typeof claim.gauge !== "string" || typeof claim.rewardToken !== "string") {
        failures.push(`${protocol} claim missing gauge or rewardToken`);
        continue;
      }
      const gauge = gaugeMap.get(lc(claim.gauge)) ?? claim.gauge;
      if (claim.chainId && claim.chainId !== 1 && claim.isWrapped !== true) {
        warnings.push(`${protocol}: ${claim.chainId}/${claim.rewardToken} is outside the Ethereum sd report`);
        continue;
      }
      const key = provenanceKey(gauge, claim.rewardToken);
      if (typeof claim.amount !== "string" || !/^\d+$/.test(claim.amount)) throw new Error(`${key}: invalid claim amount`);
      claimKeys.add(key);
      claimed.set(key, (claimed.get(key) ?? 0n) + BigInt(claim.amount));
      claimCount++;
    }

    for (const key of rowKeys) {
      if (!claimKeys.has(key)) failures.push(`${protocol} CSV row has no raw claim: ${key}`);
    }
    for (const key of claimKeys) {
      const token = key.split("|")[1];
      const matching = rows.filter((row) => provenanceKey(row.gauge, row.rewardToken) === key);
      if (!matching.length) {
        failures.push(`${protocol} raw claim has no report allocation: ${key}`);
        continue;
      }
      if (!decimals.has(token)) decimals.set(token, await client.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: "decimals" }));
      const scale = 10n ** BigInt(decimals.get(token)!);
      const reported = matching.reduce((sum, row) => sum + row.rewardAmount, 0n);
      if (amountDifference(reported * scale, claimed.get(key)! * 10n ** 18n) > BigInt(matching.length) * CSV_ROUNDING_WEI * scale) {
        failures.push(`${protocol} reward amount differs from claims: ${key}`);
      }
    }
  }
  return {
    id: "R2",
    name: "Claim amounts",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${rowCount} rows reconcile with ${claimCount} claimed bounties` : failures.join("; "),
    warnings,
  };
}

async function runR3(
  period: number,
  protocols: readonly ReportProtocol[],
  client: PublicClient,
  destination: SdTransferDestination,
  completion?: FxnCompletion,
): Promise<ReportGateResult> {
  await checkSdAttribution(period, client, protocols, destination, completion);
  const details: string[] = [];
  for (const protocol of protocols) {
    const attr = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    if (amountDifference(reportAmount(attr.totals.sdInTotal, "sdInTotal"), reportAmount(attr.totals.sdAssigned, "sdAssigned")) > ATTRIBUTION_DUST_WEI * BigInt(1 + Object.keys(attr.perToken ?? {}).length)) {
      throw new Error(
        `${protocol}: sdInTotal=${attr.totals.sdInTotal}, sdAssigned=${attr.totals.sdAssigned}`,
      );
    }
    details.push(`${protocol} assigned=${attr.totals.sdAssigned}`);
  }
  return { id: "R3", name: "Swap conservation", ok: true, detail: details.join("; ") };
}

export function runR4(
  period: number,
  protocols: readonly ReportProtocol[],
): ReportGateResult {
  const failures: string[] = [];
  let batches = 0;
  for (const protocol of protocols) {
    const attribution = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    if (attribution.period !== period || attribution.protocol !== protocol) failures.push(`${protocol}: attribution period/protocol mismatch`);
    const rows = readCsvRows(period, protocol);
    const otherRows = readCsvRows(period, protocol, true).filter((row) => row.lane !== "sd");
    const gaugeMap = rootGaugeMap(period, protocol, [...rows, ...otherRows]);
    const rawWeights = new Map<string, bigint>();
    for (const source of SOURCES) {
      for (const claim of claimsForProtocol(sourcePath(period, source), protocol)) {
        if (claim.chainId && claim.chainId !== 1 && claim.isWrapped !== true) continue;
        if (typeof claim.gauge !== "string" || typeof claim.rewardToken !== "string" || typeof claim.amount !== "string" || !/^\d+$/.test(claim.amount)) throw new Error(`${protocol}: invalid claim`);
        const key = provenanceKey(gaugeMap.get(lc(claim.gauge)) ?? claim.gauge, claim.rewardToken);
        rawWeights.set(key, (rawWeights.get(key) ?? 0n) + BigInt(claim.amount));
      }
    }
    if (!rows.length) failures.push(`${protocol}: report missing or empty`);
    const budgets = new Map<string, bigint>();
    const transactions = new Set<string>();
    const native = lc(PROTOCOLS_TOKENS[protocol].native);
    for (const tx of attribution.txs ?? []) {
      const basis = reportAmount(tx.wethBasis ?? 0, "WETH basis");
      if (basis === 0n) continue;
      const nativeSd = reportAmount(tx.nativeShareSd ?? 0, "native sd amount");
      const remaining = reportAmount(tx.sdIn, "sd received amount") - nativeSd;
      const weights = Object.entries(tx.tokenWeth ?? {});
      const sum = weights.reduce((total, [, value]) => total + reportAmount(value, "WETH weight"), 0n);
      if (remaining < 0n || amountDifference(sum, basis) > ATTRIBUTION_DUST_WEI * BigInt(weights.length + 1)) failures.push(`${protocol}/${tx.tx}: WETH attribution basis mismatch`);
      for (const token of new Set([...weights.map(([token]) => token), ...Object.keys(tx.tokenSd ?? {})])) {
        const expected = remaining * reportAmount(tx.tokenWeth?.[token] ?? 0, "token WETH weight") / basis + (lc(token) === native ? nativeSd : 0n);
        const actual = reportAmount(tx.tokenSd?.[token] ?? 0, "token sd amount");
        if (amountDifference(actual, expected) > ATTRIBUTION_DUST_WEI * BigInt(weights.length + 1)) failures.push(`${protocol}/${tx.tx}/${token}: conversion share differs from WETH input weight`);
      }
    }
    const allocations = [
      ...(attribution.txs ?? []).map((tx) => ({ tx: tx.tx, received: tx.sdIn, tokens: tx.tokenSd })),
      ...(attribution.cleanupTransactions ?? []).map((tx) => ({ tx: tx.tx, received: tx.sdReceived, tokens: tx.perTokenSd })),
    ];
    let receivedTotal = 0n;
    for (const allocation of allocations) {
      const hash = lc(allocation.tx ?? "");
      if (!/^0x[0-9a-f]{64}$/.test(hash) || transactions.has(hash)) failures.push(`${protocol}: invalid/duplicate transaction ${hash}`);
      transactions.add(hash);
      const received = reportAmount(allocation.received, `${hash} received amount`);
      const tokens = Object.entries(allocation.tokens ?? {});
      let assigned = 0n;
      for (const [token, value] of tokens) {
        const amount = reportAmount(value, `${hash}/${token} assigned amount`);
        assigned += amount;
        budgets.set(lc(token), (budgets.get(lc(token)) ?? 0n) + amount);
      }
      if (amountDifference(received, assigned) > ATTRIBUTION_DUST_WEI * BigInt(tokens.length + 1)) failures.push(`${protocol}/${hash}: converted proceeds not fully allocated`);
      receivedTotal += received;
      batches++;
    }
    const dust = ATTRIBUTION_DUST_WEI * BigInt(allocations.length + 1);
    if (amountDifference(receivedTotal, reportAmount(attribution.totals.sdInTotal, "sdInTotal")) > dust) failures.push(`${protocol}: transaction proceeds differ from sdInTotal`);
    for (const token of new Set([...budgets.keys(), ...Object.keys(attribution.perToken ?? {}).map(lc), ...rows.map((row) => row.rewardToken)])) {
      const budget = budgets.get(token) ?? 0n;
      const summary = reportAmount(attribution.perToken?.[token]?.sd ?? 0, `${token} budget`);
      // Catchup reports append their allocations separately from the base perToken summary.
      const cleanup = (attribution.cleanupTransactions ?? []).reduce((sum, tx) => sum + reportAmount(tx.perTokenSd?.[token] ?? 0, `${token} cleanup amount`), 0n);
      const matching = rows.filter((row) => row.rewardToken === token);
      const reported = matching.reduce((sum, row) => sum + row.sdAmount, 0n);
      const tolerance = dust + CSV_ROUNDING_WEI * BigInt(matching.length);
      if (amountDifference(budget, summary + cleanup) > dust) failures.push(`${protocol}/${token}: token budget differs from transaction allocations`);
      if (amountDifference(budget, reported) > tolerance) failures.push(`${protocol}/${token}: report weight differs from proceeds (expected ${formatUnits(budget, 18)}, reported ${formatUnits(reported, 18)})`);
      const gauges = [...new Set(matching.map((row) => row.gauge))];
      const splitLane = otherRows.some((row) => row.rewardToken === token);
      const weights = gauges.map((gauge) => splitLane
        ? matching.filter((row) => row.gauge === gauge).reduce((sum, row) => sum + row.rewardAmount, 0n)
        : rawWeights.get(provenanceKey(gauge, token)) ?? 0n);
      const totalClaims = weights.reduce((sum, value) => sum + value, 0n);
      for (const [index, gauge] of gauges.entries()) {
        const expected = totalClaims > 0n ? budget * weights[index] / totalClaims : 0n;
        const actual = matching.filter((row) => row.gauge === gauge).reduce((sum, row) => sum + row.sdAmount, 0n);
        // Split lanes use CSV quantities, independently reconciled to claims by R2.
        const weightRounding = splitLane && totalClaims > 0n ? budget * CSV_ROUNDING_WEI * BigInt(matching.length + 1) / totalClaims : 0n;
        if (amountDifference(actual, expected) > tolerance + weightRounding) failures.push(`${protocol}/${gauge}/${token}: gauge allocation weight differs from claim weight`);
      }
    }
    for (const file of new Set(rows.map((row) => row.file))) {
      const fileRows = rows.filter((row) => row.file === file);
      const total = fileRows.reduce((sum, row) => sum + row.sdAmount, 0n);
      for (const row of fileRows) {
        const expected = total > 0n ? row.sdAmount * 100n * 10n ** 18n / total : 0n;
        const rounding = total > 0n ? CSV_ROUNDING_WEI * BigInt(fileRows.length + 1) * 100n * 10n ** 18n / total : 0n;
        if (row.share > 100n * 10n ** 18n || amountDifference(row.share, expected) > 5n * 10n ** 15n + rounding) failures.push(`${protocol}/${row.gauge}: printed share differs from allocation`);
      }
    }
  }
  return {
    id: "R4",
    name: "Allocation weights",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${batches} conversions reconcile with token budgets, gauge weights and printed shares` : failures.join("; "),
  };
}

export function wethResidual(attribution: Attribution, cleanupWeth?: number): number {
  const settled = cleanupWeth ?? (attribution.cleanupTransactions ?? []).reduce(
    (sum, cleanup) => sum + Object.values(cleanup.residualWethConsumed ?? {}).reduce((inner, value) => inner + value, 0),
    0,
  );
  const raw = attribution.totals.wethInTotal - attribution.totals.wethOutTotal;
  return raw - settled;
}

export async function runR5(
  period: number,
  protocols: readonly ReportProtocol[],
  wethUsd: number,
  client?: PublicClient,
): Promise<ReportGateResult> {
  const failures: string[] = [];
  const details: string[] = [];
  for (const protocol of protocols) {
    const attribution = readJson<Attribution>(
      path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`),
    );
    for (const field of ["wethInTotal", "wethOutTotal"] as const) {
      const txField = field === "wethInTotal" ? "wethIn" : "wethOut";
      const sum = (attribution.txs ?? []).reduce((total, tx) => total + reportAmount(tx[txField], txField), 0n);
      if (amountDifference(sum, reportAmount(attribution.totals[field], field)) > ATTRIBUTION_DUST_WEI * BigInt(1 + (attribution.txs?.length ?? 0))) failures.push(`${protocol}: ${field} differs from transaction ledger`);
    }
    let cleanupWeth = 0n;
    for (const cleanup of attribution.cleanupTransactions ?? []) {
      if (!cleanup.tx || !attribution.aggregator) throw new Error(`${protocol}: cleanup transaction/aggregator missing`);
      const receipt = await (client ?? await getClient(1)).getTransactionReceipt({ hash: cleanup.tx as `0x${string}` });
      if (receipt.status !== "success") throw new Error(`${protocol}: cleanup transaction failed`);
      // Legacy catchups recorded native-token basis under residualWethConsumed.
      // Only real WETH transfers may settle the WETH ledger.
      for (const log of receipt.logs) {
        if (lc(log.address) !== lc(WETH_CHAIN_IDS[1]) || log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
        if (lc(`0x${log.topics[1]?.slice(-40)}`) === lc(attribution.aggregator)) cleanupWeth += BigInt(log.data);
        if (lc(`0x${log.topics[2]?.slice(-40)}`) === lc(attribution.aggregator)) cleanupWeth -= BigInt(log.data);
      }
    }
    const residual = wethResidual(attribution, Number(formatUnits(cleanupWeth, 18)));
    const usd = Math.abs(residual) * wethUsd;
    if (!Number.isFinite(usd) || usd >= 50) failures.push(`${protocol}: residual=${residual} WETH ($${usd})`);
    else details.push(`${protocol}=$${usd.toFixed(4)}`);
  }
  return {
    id: "R5",
    name: "WETH ledger",
    ok: failures.length === 0,
    detail: failures.length === 0 ? `${details.join("; ")} residual (<$50 each)` : failures.join("; "),
  };
}

async function wethUsdPrice(): Promise<number> {
  const response = await fetch(
    `https://coins.llama.fi/prices/current/ethereum:${lc(WETH_CHAIN_IDS[1])}`,
  );
  if (!response.ok) throw new Error(`WETH price HTTP ${response.status}`);
  const body = await response.json() as { coins?: Record<string, { price?: unknown }> };
  const value = Object.values(body.coins ?? {})[0]?.price;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("WETH price response is invalid");
  }
  return value;
}

async function runCheck(
  id: ReportGateResult["id"],
  name: string,
  callback: () => ReportGateResult | Promise<ReportGateResult>,
): Promise<ReportGateResult> {
  try {
    return await callback();
  } catch (error) {
    // Viem's full message includes RPC URLs, which can contain credentials.
    const rpcError = error as { shortMessage?: string; details?: string };
    const detail = rpcError?.shortMessage
      ? `${rpcError.shortMessage}${rpcError.details ? ` ${rpcError.details}` : ""}`
      : error instanceof Error ? error.message : String(error);
    return { id, name, ok: false, detail };
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

export function formatReportGateMessages(results: ReportGateResult[]): string[] {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const messages = ["<b>sdToken report verification</b>"];
  for (const result of results) {
    const lines = [`${result.ok ? "PASS" : "FAIL"} ${result.id}: ${result.detail}`,
      ...(result.warnings ?? []).map((warning) => `WARN ${result.id}: ${warning}`)];
    for (const line of lines) {
      // Bound before escaping, so an HTML entity is never split between messages.
      const safe = escape(line.length > 600 ? `${line.slice(0, 600)}… (see job log)` : line);
      if (messages[messages.length - 1].length + safe.length + 1 > 4000) messages.push(safe);
      else messages[messages.length - 1] += `\n${safe}`;
    }
  }
  return messages;
}

async function main(): Promise<void> {
  const period = Number(argValue("--period"));
  if (!Number.isInteger(period) || period <= 0) throw new Error("Usage: reportGate.ts --period <timestamp> [--protocol curve|fxn] [--sd-destination botmarket|distributor] [--notify-only]");
  const requested = argValue("--protocol");
  if (requested && !PROTOCOLS.includes(requested as ReportProtocol)) throw new Error(`unsupported protocol ${requested}`);
  const protocols: readonly ReportProtocol[] = requested ? [requested as ReportProtocol] : PROTOCOLS;
  const destination = argValue("--sd-destination") ?? "botmarket";
  if (destination !== "botmarket" && destination !== "distributor") {
    throw new Error("--sd-destination must be botmarket or distributor");
  }
  const notifyOnly = process.argv.includes("--notify-only");
  const completionPath = argValue("--completion");
  const completion = completionPath ? loadCompletion(completionPath) : undefined;
  if (completion && (requested !== "fxn" || completion.epoch !== period || destination !== "botmarket" || notifyOnly)) {
    throw new Error("FXN completion requires a blocking weekly gate for the same epoch and Botmarket destination");
  }
  const results: ReportGateResult[] = [];
  results.push(await runCheck("R1", "Source completeness", async () => {
    const result = runR1(period, protocols);
    if (!result.ok) return result;
    const claims = await verifySourceClaims(period, protocols);
    return { ...result, name: "Source completeness", detail: `${claims} claims match on-chain events; volume changes are advisory` };
  }));
  const clientPromise = getClient(1);
  results.push(await runCheck("R2", "Claim amounts", async () => {
    const client = await clientPromise;
    const result = await runR2(period, protocols, client);
    if (result.ok && protocols.includes("curve")) {
      const tokens = await verifyCurveReportInputs(period, client);
      result.detail += `; ${tokens} Curve token quantities consumed by attributed conversions`;
    }
    return result;
  }));
  results.push(await runCheck("R3", "Swap conservation", async () => runR3(period, protocols, await clientPromise, destination, completion)));
  results.push(await runCheck("R4", "Allocation weights", () => runR4(period, protocols)));
  results.push(await runCheck("R5", "WETH ledger", async () => {
    const residuals = protocols.map((protocol) => wethResidual(readJson<Attribution>(path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`))));
    const price = residuals.every((value) => Math.abs(value) < 0.0005) ? 100_000 : await wethUsdPrice();
    return runR5(period, protocols, price, await clientPromise);
  }));

  console.log(`sdToken report gate: period=${period} protocols=${protocols.join(",")}`);
  for (const result of results) {
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.id} ${result.name} — ${result.detail}`);
    for (const warning of result.warnings ?? []) console.log(`[WARN] ${result.id} — ${warning}`);
  }
  console.log(`RESULT: ${results.every((result) => result.ok) ? "PASS" : "FAIL"} — ${results.filter((result) => result.ok).length}/${results.length} checks passed`);

  if (notifyOnly) {
    for (const message of formatReportGateMessages(results)) await sendTelegramMessage(message, "HTML");
  } else if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[FAIL] setup — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
