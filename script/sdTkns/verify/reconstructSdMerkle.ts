import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { formatUnits, parseUnits, toHex, type PublicClient } from "viem";
import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  BOTMARKETS,
  DELEGATION_ADDRESS,
  ETHEREUM,
  LABELS_TO_SPACE,
  LEGACY_SD_MERKLE_TOKENS,
  MERKLE_ADDRESS,
  NETWORK_TO_MERKLE,
  SPACE_TO_NETWORK,
  SPACES_SYMBOL,
  SPACES_TOKENS,
  SPACE_TO_CHAIN_ID,
  WEEK,
} from "../../utils/constants";
import { processAllDelegators } from "../../utils/cacheUtils";
import {
  createMultiMerkle,
  eligibleDelegatorCount,
  removeDirectVoterPowerFromDelegators,
} from "../../utils/merkle/createMultiMerkle";
import { getClient } from "../../utils/getClients";
import {
  formatVotingPowerResult,
  getLastClosedProposals,
  getProposal,
  getVoters,
  getVotingPower,
} from "../../utils/snapshot";
import {
  addVotersFromAutoVoter,
  extractAllRawTokenCSVs,
  extractCSV,
  extractProposalChoices,
  getDelegationVotingPower,
} from "../../utils/utils";
import {
  collectClaimAwareContext,
  checkV1,
  checkV3,
  checkV8,
  entryKey,
  ethereumTargets,
  loadMerkle,
  parseJson,
  runCheck,
  type CheckResult,
  type ClaimAwareContext,
  type ClientForChain,
  type LogData,
  type MerkleEntry,
} from "./checkBeforeSetRoots";

const REPORTS_DIR = "bounties-reports";
const ETHEREUM_CHAIN_ID = 1;
const LOG_BLOCK_CHUNK = 50_000n;
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface ReconstructionLog extends LogData {
  SnapshotIds?: unknown;
  Delegators?: unknown;
  DelegationsAPRsDetails?: unknown;
  TotalRewards?: unknown;
  MerkleRoots?: unknown;
  TopHolders?: unknown;
}

interface Attribution {
  totals?: { sdInTotal?: unknown };
}

interface SnapshotLogEntry {
  space?: unknown;
  ids?: unknown;
}

interface RawTransferLog {
  data: string;
}

export type SdTransferDestination = "botmarket" | "distributor";

const lc = (value: string) => value.toLowerCase();

function parsePeriod(): number {
  const flag = process.argv.indexOf("--period");
  const value = flag >= 0 ? Number(process.argv[flag + 1]) : NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Usage: reconstructSdMerkle.ts --period <timestamp>");
  }
  return value;
}

function parseTransferDestination(): SdTransferDestination {
  const flag = process.argv.indexOf("--sd-destination");
  const value = flag >= 0 ? process.argv[flag + 1] : "botmarket";
  if (value !== "botmarket" && value !== "distributor") {
    throw new Error("--sd-destination must be botmarket or distributor");
  }
  return value;
}

function activeClaimTokenKeys(
  log: ReconstructionLog,
  merkle: MerkleEntry[],
): Set<string> {
  if (!Array.isArray(log.Transactions)) return new Set();
  const activeAddresses = new Set<string>();
  for (const transaction of log.Transactions as Array<{
    tokenAddressesToFreeze?: unknown;
  }>) {
    if (!Array.isArray(transaction.tokenAddressesToFreeze)) continue;
    for (const token of transaction.tokenAddressesToFreeze) {
      if (typeof token === "string") activeAddresses.add(lc(token));
    }
  }
  return new Set(
    merkle
      .filter((entry) => activeAddresses.has(lc(String(entry.address))))
      .map(entryKey),
  );
}

function amount(value: unknown, label: string): bigint {
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "bigint") return value;
  if (value && typeof value === "object") {
    const encoded = value as { hex?: unknown; _hex?: unknown };
    const hex = encoded.hex ?? encoded._hex;
    if (typeof hex === "string") return BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
  }
  throw new Error(`${label} is not an integer amount`);
}

function claims(entry: MerkleEntry): Map<string, bigint> {
  if (!entry.merkle || typeof entry.merkle !== "object" || Array.isArray(entry.merkle)) {
    throw new Error(`${String(entry.symbol)} merkle is not an object`);
  }
  return new Map(
    Object.entries(entry.merkle as Record<string, { amount?: unknown }>).map(
      ([holder, claim]) => [lc(holder), amount(claim.amount, `${holder} amount`)],
    ),
  );
}

function snapshotEntries(log: ReconstructionLog): Array<{ space: string; ids: string[] }> {
  if (!Array.isArray(log.SnapshotIds)) throw new Error("log.SnapshotIds is not an array");
  return (log.SnapshotIds as SnapshotLogEntry[]).map((entry, index) => {
    if (typeof entry.space !== "string" || !Array.isArray(entry.ids)) {
      throw new Error(`SnapshotIds[${index}] is invalid`);
    }
    const ids = entry.ids.filter((id): id is string => typeof id === "string");
    if (ids.length !== entry.ids.length || ids.length === 0) {
      throw new Error(`SnapshotIds[${index}].ids is invalid`);
    }
    return { space: entry.space, ids };
  });
}

export function compareDistributions(
  expectedEntries: MerkleEntry[],
  actualEntries: MerkleEntry[],
): string[] {
  const actual = new Map(actualEntries.map((entry) => [lc(String(entry.address)), entry]));
  const mismatches: string[] = [];
  for (const expectedEntry of expectedEntries) {
    const token = lc(String(expectedEntry.address));
    const actualEntry = actual.get(token);
    if (!actualEntry) {
      mismatches.push(`${token} missing from current merkle`);
      continue;
    }
    const expected = claims(expectedEntry);
    const current = claims(actualEntry);
    for (const holder of new Set([...expected.keys(), ...current.keys()])) {
      const expectedAmount = expected.get(holder) ?? 0n;
      const currentAmount = current.get(holder) ?? 0n;
      if (expectedAmount !== currentAmount) {
        mismatches.push(
          `${String(expectedEntry.symbol)} ${holder} expected=${expectedAmount} current=${currentAmount}`,
        );
      }
    }
  }
  return mismatches;
}

export function claimAwareWeeklyDelta(
  current: bigint,
  previous: bigint,
  claimedSince: bigint,
): bigint {
  return current - previous + claimedSince;
}

export const V2_HOLDER_EPSILON_WEI = 1_000_000_000n;
export const V2_TOKEN_EPSILON_WEI = 1_000_000_000_000n;

function absoluteWei(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function compareClaimAwareWeeklyDistributions(
  expectedEntries: MerkleEntry[],
  actualEntries: MerkleEntry[],
  claimContext: ClaimAwareContext,
): string[] {
  const actualByToken = new Map(actualEntries.map((entry) => [entryKey(entry), entry]));
  const mismatches: string[] = [];

  for (const expectedEntry of expectedEntries) {
    const key = entryKey(expectedEntry);
    const actualEntry = actualByToken.get(key);
    if (!actualEntry) {
      mismatches.push(`${key} missing from current merkle`);
      continue;
    }
    const expected = claims(expectedEntry);
    const current = claims(actualEntry);
    const tokenWindow = claimContext.tokens.get(key);
    const previous = tokenWindow?.previousAmounts ?? new Map<string, bigint>();
    const claimedSince = tokenWindow?.claimedSince ?? new Map<string, bigint>();
    let tokenAbsoluteDiff = 0n;
    let largestDiff: {
      holder: string;
      current: bigint;
      previous: bigint;
      claimedSince: bigint;
      expectedWeekly: bigint;
      actualWeekly: bigint;
      absoluteDiff: bigint;
    } | undefined;

    // Generator float rounding noise is ~1e-13 token; holder and token bounds prevent exploitable accumulation.
    for (const holder of new Set([
      ...expected.keys(),
      ...current.keys(),
      ...previous.keys(),
      ...claimedSince.keys(),
    ])) {
      const expectedDelta = expected.get(holder) ?? 0n;
      const actualDelta = claimAwareWeeklyDelta(
        current.get(holder) ?? 0n,
        previous.get(holder) ?? 0n,
        claimedSince.get(holder) ?? 0n,
      );
      const absoluteDiff = absoluteWei(actualDelta - expectedDelta);
      tokenAbsoluteDiff += absoluteDiff;
      if (!largestDiff || absoluteDiff > largestDiff.absoluteDiff) {
        largestDiff = {
          holder,
          current: current.get(holder) ?? 0n,
          previous: previous.get(holder) ?? 0n,
          claimedSince: claimedSince.get(holder) ?? 0n,
          expectedWeekly: expectedDelta,
          actualWeekly: actualDelta,
          absoluteDiff,
        };
      }
      if (absoluteDiff > V2_HOLDER_EPSILON_WEI) {
        mismatches.push(
          `${String(expectedEntry.symbol)} ${holder} current=${current.get(holder) ?? 0n} ` +
            `previous=${previous.get(holder) ?? 0n} claimedSince=${claimedSince.get(holder) ?? 0n} ` +
            `expectedWeekly=${expectedDelta} actualWeekly=${actualDelta} absDiff=${absoluteDiff} ` +
            `holderBound=${V2_HOLDER_EPSILON_WEI}`,
        );
      }
    }
    if (tokenAbsoluteDiff > V2_TOKEN_EPSILON_WEI) {
      if (!largestDiff) throw new Error("cumulative V2 mismatch has no holder");
      mismatches.push(
        `${String(expectedEntry.symbol)} tokenCumulativeAbsDiff=${tokenAbsoluteDiff} ` +
          `tokenBound=${V2_TOKEN_EPSILON_WEI} largestHolder=${largestDiff.holder} ` +
          `current=${largestDiff.current} previous=${largestDiff.previous} ` +
          `claimedSince=${largestDiff.claimedSince} expectedWeekly=${largestDiff.expectedWeekly} ` +
          `actualWeekly=${largestDiff.actualWeekly} largestAbsDiff=${largestDiff.absoluteDiff}`,
      );
    }
  }
  return mismatches;
}

async function checkV2(
  period: number,
  log: ReconstructionLog,
  current: MerkleEntry[],
  claimContext: ClaimAwareContext,
): Promise<CheckResult> {
  const rebuilt: MerkleEntry[] = [];
  let sourceBuckets = 0;

  for (const { space, ids } of snapshotEntries(log)) {
    const csv = await extractCSV(period, space);
    if (!csv) throw new Error(`${space} CSV is missing`);
    sourceBuckets += Object.keys(csv).length;
    const result = await createMultiMerkle(
      ids,
      space,
      [],
      csv,
      { total_vp: 1 },
      { total_vp: 1 },
      {},
      undefined,
      { readOnlyClaimCache: true },
    );
    rebuilt.push(result.merkle);
  }

  const raw = await extractAllRawTokenCSVs(period);
  const grouped = new Map<
    string,
    { space: string; token: string; distributions: Record<string, number> }
  >();
  for (const distribution of raw) {
    const key = `${lc(distribution.token)}|${distribution.space}`;
    const group = grouped.get(key) ?? {
      space: distribution.space,
      token: lc(distribution.token),
      distributions: {},
    };
    group.distributions[lc(distribution.gauge)] =
      (group.distributions[lc(distribution.gauge)] ?? 0) + distribution.amount;
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const snapshot = snapshotEntries(log).find((entry) => entry.space === group.space);
    if (!snapshot) throw new Error(`raw token ${group.token} has no SnapshotIds entry`);
    sourceBuckets += Object.keys(group.distributions).length;
    const result = await createMultiMerkle(
      snapshot.ids,
      group.space,
      [],
      group.distributions,
      { total_vp: 1 },
      { total_vp: 1 },
      {},
      group.token,
      { readOnlyClaimCache: true },
    );
    rebuilt.push(result.merkle);
  }

  const mismatches = compareClaimAwareWeeklyDistributions(
    rebuilt,
    current,
    claimContext,
  );
  if (mismatches.length > 0) {
    throw new Error(`${mismatches.length} wallet-token mismatches; ${mismatches.slice(0, 3).join("; ")}`);
  }
  return {
    id: "V2" as CheckResult["id"],
    name: "Conservation",
    ok: true,
    detail: `${sourceBuckets} CSV gauge buckets independently re-routed; ${rebuilt.length} claim-aware weekly distributions match wei-exact`,
  };
}

async function blockAtOrAfter(client: PublicClient, timestamp: number): Promise<bigint> {
  let low = 0n;
  let high = await client.getBlockNumber();
  while (low < high) {
    const mid = (low + high) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < BigInt(timestamp)) low = mid + 1n;
    else high = mid;
  }
  return low;
}

function addressTopic(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
}

export async function sumTransfersIntoDestinations(
  client: PublicClient,
  token: string,
  destinations: string[],
  startTimestamp: number,
  endTimestamp: number,
): Promise<{ total: bigint; events: number }> {
  const fromBlock = await blockAtOrAfter(client, startTimestamp);
  const endBlock = await blockAtOrAfter(client, endTimestamp);
  let total = 0n;
  let events = 0;
  for (const destination of new Set(destinations.map(lc))) {
    for (let start = fromBlock; start < endBlock; start += LOG_BLOCK_CHUNK) {
      const end = start + LOG_BLOCK_CHUNK < endBlock ? start + LOG_BLOCK_CHUNK - 1n : endBlock - 1n;
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [{
          address: token as `0x${string}`,
          fromBlock: toHex(start),
          toBlock: toHex(end),
          topics: [TRANSFER_TOPIC, null, addressTopic(destination)],
        }],
      })) as RawTransferLog[];
      for (const log of logs) {
        total += BigInt(log.data);
        events++;
      }
    }
  }
  return { total, events };
}

export function attributionDestinations(
  destination: SdTransferDestination,
): string[] {
  return destination === "distributor"
    ? [MERKLE_ADDRESS]
    : [BOTMARKETS[ETHEREUM]];
}

function csvSdTotal(period: number, protocol: string): bigint {
  let total = 0n;
  for (const suffix of [".csv", "-otc.csv"]) {
    const file = path.join(REPORTS_DIR, String(period), `${protocol}${suffix}`);
    if (!existsSync(file)) continue;
    const rows = parseCsv(readFileSync(file, "utf8"), {
      columns: true,
      delimiter: ";",
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
    for (const row of rows) {
      const value = row["Reward sd Value"];
      if (value) total += parseUnits(Number(value).toFixed(18), 18);
    }
  }
  return total;
}

function withinOneTenthPercent(left: bigint, right: bigint): boolean {
  const scale = left > right ? left : right;
  if (scale === 0n) return true;
  const difference = left > right ? left - right : right - left;
  return difference * 1_000n <= scale;
}

export async function checkSdAttribution(
  period: number,
  client: PublicClient,
  protocols: readonly ("curve" | "fxn")[] = ["curve", "fxn"],
  destination: SdTransferDestination = "botmarket",
): Promise<{ ok: boolean; detail: string }> {
  const details: string[] = [];
  for (const protocol of protocols) {
    const space = LABELS_TO_SPACE[protocol];
    const token = SPACES_TOKENS[space];
    const attrPath = path.join(REPORTS_DIR, String(period), `${protocol}-attribution.json`);
    if (!existsSync(attrPath)) throw new Error(`${protocol}-attribution.json is missing`);
    const attribution = parseJson<Attribution>(attrPath);
    if (typeof attribution.totals?.sdInTotal !== "number") {
      throw new Error(`${protocol} attribution.totals.sdInTotal is invalid`);
    }
    const events = await sumTransfersIntoDestinations(
      client,
      token,
      attributionDestinations(destination),
      period,
      period + WEEK,
    );
    const csv = csvSdTotal(period, protocol);
    const attributed = parseUnits(attribution.totals.sdInTotal.toFixed(18), 18);
    if (!withinOneTenthPercent(events.total, csv) || !withinOneTenthPercent(events.total, attributed)) {
      throw new Error(
        `${protocol}: events=${formatUnits(events.total, 18)}, CSV=${formatUnits(csv, 18)}, attribution=${formatUnits(attributed, 18)}`,
      );
    }
    details.push(
      `${protocol} ${events.events} ${destination} events=${formatUnits(events.total, 18)}`,
    );
  }
  return { ok: true, detail: details.join("; ") };
}

async function checkV4(
  period: number,
  client: PublicClient,
  destination: SdTransferDestination,
): Promise<CheckResult> {
  const result = await checkSdAttribution(period, client, ["curve", "fxn"], destination);
  return { id: "V4" as CheckResult["id"], name: "Attribution", ...result };
}

export function withinMedianBand(value: number, history: number[], fraction = 0.3): boolean {
  if (value <= 0 || history.length < 4) return false;
  const sorted = [...history].sort((a, b) => a - b);
  const median = (sorted[1] + sorted[2]) / 2;
  return median > 0 && Math.abs(value - median) / median <= fraction;
}

function delegatorCounts(log: ReconstructionLog): Map<string, number> {
  if (!Array.isArray(log.Delegators)) throw new Error("log.Delegators is not an array");
  const counts = new Map<string, number>();
  for (const item of log.Delegators) {
    if (typeof item !== "string") continue;
    const [id, rawCount] = item.split(":", 2).map((part) => part.trim());
    const count = Number(rawCount);
    if (id && Number.isInteger(count)) counts.set(lc(id), count);
  }
  return counts;
}

export async function proposalEligibleDelegatorCount(
  space: string,
  proposal: Awaited<ReturnType<typeof getProposal>>,
): Promise<number> {
  let voters = await getVoters(proposal.id);
  const votingPower = await getVotingPower(
    proposal,
    voters.map((voter) => voter.voter),
    SPACE_TO_CHAIN_ID[space],
    false,
    10,
    1000,
  );
  voters = formatVotingPowerResult(voters, votingPower);
  voters = await addVotersFromAutoVoter(
    space,
    proposal,
    voters,
    extractProposalChoices(proposal),
  );
  voters = voters.filter(
    (voter) =>
      voter.voter.toLowerCase() !== AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase(),
  );

  const delegators = await processAllDelegators(
    space,
    proposal.created,
    DELEGATION_ADDRESS,
  );
  const delegatorsVotingPower = await getDelegationVotingPower(
    proposal,
    delegators.concat([DELEGATION_ADDRESS]),
    SPACE_TO_CHAIN_ID[space],
  );
  removeDirectVoterPowerFromDelegators(delegatorsVotingPower, voters);
  const delegationVotingPower = voters.find(
    (voter) => voter.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase(),
  )?.vp ?? 0;
  return eligibleDelegatorCount(delegatorsVotingPower, delegationVotingPower);
}

async function checkV9(period: number, log: ReconstructionLog): Promise<CheckResult> {
  const counts = delegatorCounts(log);
  const details: string[] = [];
  for (const { space, ids } of snapshotEntries(log)) {
    for (const id of ids) {
      const proposal = await getProposal(id);
      if (!proposal || proposal.state !== "closed") throw new Error(`${space} ${id} is not closed`);
      if (proposal.end < period - 2 * WEEK || proposal.end >= period) {
        throw new Error(`${space} ${id} end=${proposal.end} is outside the distribution window [${period - 2 * WEEK}, ${period})`);
      }
      const currentCount = counts.get(lc(id)) ?? 0;
      const recomputedCurrentCount = await proposalEligibleDelegatorCount(
        space,
        proposal,
      );
      if (currentCount !== recomputedCurrentCount) {
        throw new Error(
          `${space} logged eligible delegators=${currentCount}, recomputed=${recomputedCurrentCount}`,
        );
      }
      const prior = (await getLastClosedProposals(space, 8))
        .filter((candidate) => candidate.created < proposal.created)
        .slice(0, 4);
      if (prior.length < 4) throw new Error(`${space} has fewer than four prior closed proposals`);
      const history: number[] = [];
      for (const candidate of prior) {
        history.push(await proposalEligibleDelegatorCount(space, candidate));
      }
      if (!withinMedianBand(currentCount, history)) {
        throw new Error(`${space} delegators=${currentCount}, trailing counts=${history.join(",")}`);
      }
      details.push(`${space} eligible=${currentCount} vs [${history.join(",")}]`);
    }
  }
  return { id: "V9" as CheckResult["id"], name: "Snapshot", ok: true, detail: details.join("; ") };
}

export function checkRegistry(merkle: MerkleEntry[]): { ok: boolean; detail: string } {
  const registry = new Map(
    LEGACY_SD_MERKLE_TOKENS.map((entry) => [`${entry.chainId}:${entry.symbol}:${lc(entry.address)}`, entry]),
  );
  for (const entry of merkle) {
    const chainId = typeof entry.chainId === "number" ? entry.chainId : ETHEREUM_CHAIN_ID;
    const token = lc(String(entry.address));
    const key = `${chainId}:${String(entry.symbol)}:${token}`;
    const expected = registry.get(key);
    if (!expected) throw new Error(`unregistered merkle token ${key}`);
    const contract = lc(String(entry.merkleContract ?? NETWORK_TO_MERKLE[SPACE_TO_NETWORK[
      Object.keys(SPACES_SYMBOL).find((space) => SPACES_SYMBOL[space] === entry.symbol) ?? ""
    ]] ?? MERKLE_ADDRESS));
    if (contract !== lc(expected.merkleContract)) {
      throw new Error(`${String(entry.symbol)} merkleContract=${contract}, expected=${expected.merkleContract}`);
    }
  }
  return { ok: true, detail: `${merkle.length} token/address/contract tuples match constants` };
}

function checkV10(merkle: MerkleEntry[]): CheckResult {
  const result = checkRegistry(merkle);
  return { id: "V10" as CheckResult["id"], name: "Registry", ...result };
}

export function checkAprPresence(
  log: ReconstructionLog,
  aprs: Record<string, unknown>,
): { ok: boolean; detail: string } {
  if (!log.TotalReported || typeof log.TotalReported !== "object" || Array.isArray(log.TotalReported)) {
    throw new Error("log.TotalReported is not an object");
  }
  const required: string[] = [];
  for (const [symbol, raw] of Object.entries(log.TotalReported as Record<string, unknown>)) {
    if (symbol.startsWith("RawToken_") || raw === 0) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`TotalReported.${symbol} is invalid`);
    const space = Object.keys(SPACES_SYMBOL).find((candidate) => SPACES_SYMBOL[candidate] === symbol);
    if (!space) throw new Error(`no Snapshot space for nonzero ${symbol}`);
    if (aprs[space] === null || aprs[space] === undefined || typeof aprs[space] !== "number") {
      throw new Error(`delegationsAPRs.json has no numeric ${space} entry`);
    }
    required.push(space);
  }
  return { ok: true, detail: `${required.length} nonzero sdToken APR entries present: ${required.join(",")}` };
}

function checkV11(period: number, log: ReconstructionLog): CheckResult {
  const aprs = parseJson<Record<string, unknown>>(
    path.join(REPORTS_DIR, String(period), "delegationsAPRs.json"),
  );
  const result = checkAprPresence(log, aprs);
  return { id: "V11" as CheckResult["id"], name: "APR presence", ...result };
}

function abbreviate(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return value.toFixed(2);
}

export function buildNotifyDigest(
  log: ReconstructionLog,
  previousAprs: Record<string, number> = {},
): string {
  const lines = ["Merkle Generation Check", "Snapshots:"];
  for (const entry of snapshotEntries(log)) {
    for (const id of entry.ids) lines.push(`- ${entry.space}: ${id} (${delegatorCounts(log).get(lc(id)) ?? 0} delegators)`);
  }
  lines.push("New Distribution:");
  const reported = (log.TotalReported ?? {}) as Record<string, number>;
  const totals = (log.TotalRewards ?? {}) as Record<string, number>;
  for (const [symbol, delta] of Object.entries(reported)) {
    lines.push(`- ${symbol}: +${abbreviate(delta)} -> ${abbreviate(totals[symbol] ?? 0)} on merkle`);
  }
  const aprs = (log.DelegationsAPRsDetails ?? {}) as Record<string, number>;
  lines.push(`APRs: ${Object.entries(aprs).map(([space, value]) => {
    const previous = previousAprs[space] ?? 0;
    const warning = previous > 0 && Math.abs(value - previous) / previous > 0.5 ? " WARN ±50%" : "";
    return `${space} ${previous.toFixed(2)}->${value.toFixed(2)}%${warning}`;
  }).join(" | ")}`);
  const surplus = (log.DistributionSurplus ?? {}) as Record<string, number>;
  lines.push(`Surplus: ${Object.entries(surplus).map(([symbol, value]) => `${symbol}: ${value}`).join(" | ")}`);
  lines.push(`Roots: ${Array.isArray(log.MerkleRoots) ? log.MerkleRoots.join(" | ") : ""}`);
  lines.push("Top Holders Detail");
  for (const [symbol, rawHolders] of Object.entries((log.TopHolders ?? {}) as Record<string, unknown>)) {
    lines.push(`${symbol}:`);
    for (const holder of (Array.isArray(rawHolders) ? rawHolders.slice(0, 5) : []) as Array<Record<string, unknown>>) {
      lines.push(`- ${String(holder.address)}: previous=${String(holder.prevAmount)} current=${String(holder.newAmount)} ${holder.claimed ? "claimed" : "unclaimed"}`);
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const period = parsePeriod();
  const transferDestination = parseTransferDestination();
  const log = parseJson<ReconstructionLog>("log.json");
  const merkle = loadMerkle(period);
  const targets = ethereumTargets(log);
  const clients = new Map<number, Promise<PublicClient>>();
  const clientForChain: ClientForChain = (chainId) => {
    const existing = clients.get(chainId);
    if (existing) return existing;
    const created = getClient(chainId);
    clients.set(chainId, created);
    return created;
  };
  const claimContext = collectClaimAwareContext(
    period,
    merkle,
    clientForChain,
    activeClaimTokenKeys(log, merkle),
  );

  const results: CheckResult[] = [];
  results.push(await runCheck("V1", "Rebuild", () => checkV1(merkle, targets, log)));
  results.push(await runCheck("V2" as CheckResult["id"], "Conservation", async () => checkV2(period, log, merkle, await claimContext)));
  results.push(await runCheck("V3", "Continuity", async () => checkV3(period, merkle, clientForChain, await claimContext)));
  results.push(await runCheck("V4", "Attribution", async () => checkV4(period, await clientForChain(1), transferDestination)));
  results.push(await runCheck("V8", "Scope", () => checkV8(log, merkle, targets)));
  results.push(await runCheck("V9" as CheckResult["id"], "Snapshot", () => checkV9(period, log)));
  results.push(await runCheck("V10" as CheckResult["id"], "Registry", () => checkV10(merkle)));
  results.push(await runCheck("V11" as CheckResult["id"], "APR presence", () => checkV11(period, log)));

  console.log(`sdMerkle reconstruction: period=${period}`);
  for (const result of results) console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.id} ${result.name} — ${result.detail}`);
  console.log(`RESULT: ${results.every((result) => result.ok) ? "PASS" : "FAIL"} — ${results.filter((result) => result.ok).length}/${results.length} checks passed`);
  const latestAprPath = path.join(REPORTS_DIR, "latest", "delegationsAPRs.json");
  const previousAprs = existsSync(latestAprPath)
    ? parseJson<Record<string, number>>(latestAprPath)
    : {};
  console.log("\n--- notify digest (non-gating) ---\n" + buildNotifyDigest(log, previousAprs));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[FAIL] setup — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
