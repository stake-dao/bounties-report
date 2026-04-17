import axios from "axios";
import request, { gql } from "graphql-request";
import * as fs from "fs";
import * as path from "path";
import Table from "cli-table3";
import pc from "picocolors";
import pLimit from "p-limit";
import { getAddress, parseAbiItem } from "viem";
import { formatBytes32String } from "ethers/lib/utils";
import { getClient } from "../../utils/getClients";
import {
  DELEGATE_REGISTRY,
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  DELEGATION_ADDRESS,
  VOTIUM_FORWARDER,
  VOTIUM_FORWARDER_REGISTRY,
  CVX_SPACE,
} from "../../utils/constants";

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";
const SCORE_ENDPOINT = "https://score.snapshot.org/api/scores";
const DEFILLAMA_ENDPOINT = "https://coins.llama.fi/prices/current";
const CVX_LOCKER_V2 = "0x72a19342e8F1838460eBFCCEf09F6585e32db86E"; // Used by Snapshot cvx.eth space
const CVX_TOKEN = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";
const WEEK = 604800;

const CVX_SPACE_BYTES32 = formatBytes32String(CVX_SPACE);

const SET_DELEGATE_EVENT = parseAbiItem(
  "event SetDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)"
);
const CLEAR_DELEGATE_EVENT = parseAbiItem(
  "event ClearDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)"
);

const SET_REG_EVENT = parseAbiItem(
  "event setReg(address indexed _from, address indexed _to, uint256 indexed _start)"
);
const EXP_REG_EVENT = parseAbiItem(
  "event expReg(address indexed _from, uint256 indexed _end)"
);
const VOTIUM_REGISTRY_CREATION_BLOCK_ETH = 14872510n;

interface DelegationEvent {
  type: "Set" | "Clear";
  block: bigint;
  logIndex: number;
  space: `0x${string}`;
  delegate: string;
  timestamp?: number;
}

interface ForwarderEvent {
  type: "Set" | "Exp";
  block: bigint;
  logIndex: number;
  to: string;
  startOrEnd: number;
  timestamp?: number;
}

// ========== Rendering helpers ==========
function section(title: string): string {
  return `\n${pc.bold(pc.cyan(`── ${title} `))}${pc.dim(
    "─".repeat(Math.max(0, 60 - title.length))
  )}`;
}

function usdCell(amount: number): string {
  const str = `$${amount.toFixed(2)}`;
  return amount > 0 ? pc.green(str) : pc.dim(str);
}

function roundLabel(prefix: string, round: number, usd: number): string {
  return `${pc.dim(`#${round}`)} ${usdCell(usd)}`;
}

function statusBadge(
  status: "aligned" | "forwarder only" | "deleg only" | "neither"
): string {
  switch (status) {
    case "aligned":
      return `${pc.green("✓")} ${pc.green("aligned")}`;
    case "forwarder only":
      return `${pc.yellow("⚠")} ${pc.yellow("forwarder only")}`;
    case "deleg only":
      return `${pc.cyan("•")} ${pc.cyan("deleg only")}`;
    case "neither":
      return pc.dim("  neither");
  }
}

function colorizeAddr(formatted: string): string {
  if (formatted === "StakeDAO") return pc.magenta(formatted);
  if (formatted === "—") return pc.dim("—");
  return formatted;
}

function defaultTable(opts: {
  head: string[];
  colAligns?: ("left" | "right" | "middle")[];
}): Table.Table {
  return new Table({
    head: opts.head.map((h) => pc.bold(h)),
    colAligns: opts.colAligns,
    style: { head: [], border: ["grey"] },
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "╭",
      "top-right": "╮",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "╰",
      "bottom-right": "╯",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });
}

const LOGS_BATCH = 500_000n;
const LOGS_CONCURRENCY = 6;
// Shared across all eth_getLogs chunked fetches — keeps peak concurrent RPC
// calls ≤ LOGS_CONCURRENCY even when multiple fetchAll closures run in parallel.
const logsLimit = pLimit(LOGS_CONCURRENCY);

function chunkRange(from: bigint, to: bigint, size: bigint): [bigint, bigint][] {
  const chunks: [bigint, bigint][] = [];
  let cur = from;
  while (cur <= to) {
    const next = cur + size > to ? to : cur + size;
    chunks.push([cur, next]);
    cur = next + 1n;
  }
  return chunks;
}

async function fetchLogsChunked<TArgs>(
  client: Awaited<ReturnType<typeof getClient>>,
  params: {
    address: `0x${string}`;
    event: any;
    args: TArgs;
    from: bigint;
    to: bigint;
    label: string;
  }
): Promise<any[]> {
  const chunks = chunkRange(params.from, params.to, LOGS_BATCH);
  const results = await Promise.all(
    chunks.map(([f, t]) =>
      logsLimit(() =>
        withRetry(
          () =>
            client.getLogs({
              address: params.address,
              event: params.event,
              args: params.args as any,
              fromBlock: f,
              toBlock: t,
            }),
          2,
          500
        )
      )
    )
  );
  // Single atomic write per fetcher keeps output readable under parallel calls.
  process.stderr.write(pc.dim(`  fetched ${params.label} (${chunks.length} chunks)\n`));
  return results.flat();
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 800
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function fetchUserDelegationEvents(
  user: string,
  toBlock: bigint
): Promise<DelegationEvent[]> {
  const client = await getClient(1);
  const fromBlock = BigInt(DELEGATE_REGISTRY_CREATION_BLOCK_ETH);
  const normalizedUser = getAddress(user);
  const registry = getAddress(DELEGATE_REGISTRY);

  const [setLogs, clearLogs] = await Promise.all([
    fetchLogsChunked(client, {
      address: registry,
      event: SET_DELEGATE_EVENT,
      args: { delegator: normalizedUser },
      from: fromBlock,
      to: toBlock,
      label: "SetDelegate",
    }),
    fetchLogsChunked(client, {
      address: registry,
      event: CLEAR_DELEGATE_EVENT,
      args: { delegator: normalizedUser },
      from: fromBlock,
      to: toBlock,
      label: "ClearDelegate",
    }),
  ]);

  const events: DelegationEvent[] = [
    ...setLogs.map((l: any) => ({
      type: "Set" as const,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex ?? 0),
      space: l.args.id as `0x${string}`,
      delegate: l.args.delegate as string,
    })),
    ...clearLogs.map((l: any) => ({
      type: "Clear" as const,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex ?? 0),
      space: l.args.id as `0x${string}`,
      delegate: l.args.delegate as string,
    })),
  ].sort((a, b) => {
    if (a.block !== b.block) return Number(a.block - b.block);
    return a.logIndex - b.logIndex;
  });

  const uniqBlocks = [...new Set(events.map((e) => e.block))];
  await Promise.all(
    uniqBlocks.map(async (b) => {
      const blk = await withRetry(() => client.getBlock({ blockNumber: b }));
      const ts = Number(blk.timestamp);
      for (const e of events) if (e.block === b) e.timestamp = ts;
    })
  );

  return events;
}

function reconstructCvxDelegate(
  events: DelegationEvent[],
  atBlock: bigint
): string | null {
  const cvx = events.filter(
    (e) =>
      e.space.toLowerCase() === CVX_SPACE_BYTES32.toLowerCase() &&
      e.block <= atBlock
  );
  if (cvx.length === 0) return null;
  const last = cvx[cvx.length - 1];
  return last.type === "Set" ? last.delegate : null;
}

function reconstructCvxDelegateAtTime(
  events: DelegationEvent[],
  atTimestamp: number
): string | null {
  const cvx = events.filter(
    (e) =>
      e.space.toLowerCase() === CVX_SPACE_BYTES32.toLowerCase() &&
      e.timestamp !== undefined &&
      e.timestamp <= atTimestamp
  );
  if (cvx.length === 0) return null;
  const last = cvx[cvx.length - 1];
  return last.type === "Set" ? last.delegate : null;
}

async function fetchUserForwarderEvents(
  user: string,
  toBlock: bigint
): Promise<ForwarderEvent[]> {
  const client = await getClient(1);
  const fromBlock = VOTIUM_REGISTRY_CREATION_BLOCK_ETH;
  const normalizedUser = getAddress(user);
  const registry = getAddress(VOTIUM_FORWARDER_REGISTRY);

  const [setLogs, expLogs] = await Promise.all([
    fetchLogsChunked(client, {
      address: registry,
      event: SET_REG_EVENT,
      args: { _from: normalizedUser },
      from: fromBlock,
      to: toBlock,
      label: "setReg",
    }),
    fetchLogsChunked(client, {
      address: registry,
      event: EXP_REG_EVENT,
      args: { _from: normalizedUser },
      from: fromBlock,
      to: toBlock,
      label: "expReg",
    }),
  ]);

  const events: ForwarderEvent[] = [
    ...setLogs.map((l: any) => ({
      type: "Set" as const,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex ?? 0),
      to: l.args._to as string,
      startOrEnd: Number(l.args._start),
    })),
    ...expLogs.map((l: any) => ({
      type: "Exp" as const,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex ?? 0),
      to: "",
      startOrEnd: Number(l.args._end),
    })),
  ].sort((a, b) => {
    if (a.block !== b.block) return Number(a.block - b.block);
    return a.logIndex - b.logIndex;
  });

  const uniqBlocks = [...new Set(events.map((e) => e.block))];
  await Promise.all(
    uniqBlocks.map(async (b) => {
      const blk = await withRetry(() => client.getBlock({ blockNumber: b }));
      const ts = Number(blk.timestamp);
      for (const e of events) if (e.block === b) e.timestamp = ts;
    })
  );

  return events;
}

function reconstructForwarderAtTime(
  events: ForwarderEvent[],
  atTimestamp: number
): string | null {
  // Mirrors forwarderCacheUtils.processAllForwarders semantics:
  // Set: state = { to, start: _start, expiration: 0 }
  // Exp: state.expiration = _end
  // Active if start <= t AND (expiration == 0 OR expiration > t)
  let to: string | null = null;
  let start = 0;
  let expiration = 0;
  for (const e of events) {
    if (e.timestamp === undefined || e.timestamp > atTimestamp) break;
    if (e.type === "Set") {
      to = e.to;
      start = e.startOrEnd;
      expiration = 0;
    } else {
      expiration = e.startOrEnd;
    }
  }
  if (!to) return null;
  if (start > atTimestamp) return null;
  if (expiration !== 0 && expiration <= atTimestamp) return null;
  return to;
}

async function fetchVotiumForwardDestination(
  user: string,
  blockNumber?: bigint
): Promise<string | null> {
  const abi = [
    {
      name: "batchAddressCheck",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "accounts", type: "address[]" }],
      outputs: [{ name: "", type: "address[]" }],
    },
  ];
  try {
    const client = await getClient(1);
    const r = (await client.readContract({
      address: getAddress(VOTIUM_FORWARDER_REGISTRY),
      abi,
      functionName: "batchAddressCheck",
      args: [[getAddress(user)]],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    })) as string[];
    return r[0];
  } catch {
    return null;
  }
}

function formatDelegate(addr: string | null): string {
  if (!addr) return "— (not delegating)";
  if (addr.toLowerCase() === DELEGATION_ADDRESS.toLowerCase())
    return `StakeDAO (${DELEGATION_ADDRESS.slice(0, 6)}…${DELEGATION_ADDRESS.slice(-4)})`;
  return addr;
}

function formatForward(addr: string | null): string {
  if (addr === null) return "(lookup failed)";
  if (!addr || /^0x0+$/.test(addr)) return "— (not forwarding)";
  if (addr.toLowerCase() === VOTIUM_FORWARDER.toLowerCase())
    return `StakeDAO forwarder (${VOTIUM_FORWARDER.slice(0, 6)}…${VOTIUM_FORWARDER.slice(-4)})`;
  return addr;
}

interface Proposal {
  id: string;
  title: string;
  snapshot: string;
  start: number;
  end: number;
}

async function getRecentProposals(): Promise<Proposal[]> {
  const query = gql`
    query {
      proposals(
        first: 4
        orderBy: "created"
        orderDirection: desc
        where: { space: "cvx.eth", type: "weighted", title_contains: "Gauge Weight for Week" }
      ) {
        id
        title
        snapshot
        start
        end
      }
    }
  `;
  const result: any = await request(SNAPSHOT_ENDPOINT, query);
  return result.proposals.filter((p: Proposal) => !p.title.startsWith("FXN"));
}

interface VotingPowerResult {
  total: number;
  direct: number;
  delegated: number;
}

async function getVotingPower(address: string, snapshotBlock: number | "latest"): Promise<VotingPowerResult> {
  const { data } = await axios.post(SCORE_ENDPOINT, {
    params: {
      network: "1",
      snapshot: snapshotBlock,
      strategies: [
        {
          name: "erc20-balance-of",
          params: { address: CVX_LOCKER_V2, symbol: "vlCVX", decimals: 18 }
        },
        {
          name: "erc20-balance-of-delegation",
          params: { address: CVX_LOCKER_V2, symbol: "vlCVX", decimals: 18 }
        }
      ],
      space: "cvx.eth",
      addresses: [address],
    },
  });
  const direct = data.result.scores[0][address] || 0;
  const delegated = data.result.scores[1][address] || 0;
  return { total: direct + delegated, direct, delegated };
}

async function getCVXPrice(): Promise<number> {
  const { data } = await axios.get(`${DEFILLAMA_ENDPOINT}/ethereum:${CVX_TOKEN.toLowerCase()}`);
  return data.coins[`ethereum:${CVX_TOKEN.toLowerCase()}`]?.price || 0;
}

interface UserVote {
  vp: number;
  choice: Record<string, number> | number;
}

interface ProposalScores {
  choices: string[];
  scores: number[];
  snapshot?: string;
}

interface VotiumBribe {
  pool: string;
  token: string;
  amount: number;
  amountDollars: number;
  gauge: string;
  choice: number;
  maxPerVote?: number;
  excluded?: string[];
}

interface VotiumRoundData {
  round: number;
  chain: VotiumChain;
  end: number;
  proposal: string;
  scoresTotal: number;
  bribes: VotiumBribe[];
}

type VotiumChain = "cvx-crv" | "cvx-fxn";
const VOTIUM_CHAINS: VotiumChain[] = ["cvx-crv", "cvx-fxn"];
const ROUNDS_CACHE_PATH = path.join(process.cwd(), "data/votium-rounds-cache.json");
const TWO_MONTHS_SEC = 60 * 24 * 60 * 60;

interface RoundsCache {
  "cvx-crv": Record<string, Omit<VotiumRoundData, "round" | "chain">>;
  "cvx-fxn": Record<string, Omit<VotiumRoundData, "round" | "chain">>;
  updated: number;
}

async function fetchUserVote(user: string, proposalId: string): Promise<UserVote | null> {
  const query = gql`
    query ($voter: String!, $proposal: String!) {
      votes(
        where: { voter: $voter, proposal: $proposal }
        first: 1
        orderBy: "created"
        orderDirection: desc
      ) {
        vp
        choice
      }
    }
  `;
  const result: any = await request(SNAPSHOT_ENDPOINT, query, {
    voter: user,
    proposal: proposalId,
  });
  return result.votes?.[0] || null;
}

async function fetchProposalScores(proposalId: string): Promise<ProposalScores> {
  const query = gql`
    query ($id: String!) {
      proposal(id: $id) {
        choices
        scores
        snapshot
      }
    }
  `;
  const result: any = await request(SNAPSHOT_ENDPOINT, query, { id: proposalId });
  return result.proposal || { choices: [], scores: [] };
}

async function fetchLatestVotiumRound(chain: VotiumChain = "cvx-crv"): Promise<number> {
  const { data } = await axios.get(`https://api.llama.airforce/bribes/votium/${chain}/rounds`);
  return Math.max(...(data.rounds || []));
}

async function fetchVotiumBribes(round: number, chain: VotiumChain = "cvx-crv"): Promise<VotiumBribe[]> {
  const { data } = await axios.get(`https://api.llama.airforce/bribes/votium/${chain}/${round}`);
  return data.epoch?.bribes || [];
}

function loadRoundsCache(): RoundsCache {
  try {
    const raw = fs.readFileSync(ROUNDS_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      "cvx-crv": parsed["cvx-crv"] ?? {},
      "cvx-fxn": parsed["cvx-fxn"] ?? {},
      updated: parsed.updated ?? 0,
    };
  } catch {
    return { "cvx-crv": {}, "cvx-fxn": {}, updated: 0 };
  }
}

function saveRoundsCache(cache: RoundsCache): void {
  try {
    fs.writeFileSync(ROUNDS_CACHE_PATH, JSON.stringify({ ...cache, updated: Math.floor(Date.now() / 1000) }, null, 2));
  } catch (e: any) {
    console.log(`  ⚠  Failed to write rounds cache: ${e.message}`);
  }
}

async function fetchVotiumRoundData(
  chain: VotiumChain,
  round: number,
  cache: RoundsCache,
  latestRound: number
): Promise<VotiumRoundData | null> {
  const cached = cache[chain][String(round)];
  // Closed rounds are immutable; always re-fetch the current latest.
  if (cached && round !== latestRound) {
    return { round, chain, ...cached };
  }
  try {
    const { data } = await axios.get(`https://api.llama.airforce/bribes/votium/${chain}/${round}`);
    const e = data.epoch;
    if (!e) return cached ? { round, chain, ...cached } : null;
    const entry = {
      end: e.end as number,
      proposal: e.proposal as string,
      scoresTotal: e.scoresTotal as number,
      bribes: (e.bribes || []) as VotiumBribe[],
    };
    cache[chain][String(round)] = entry;
    return { round, chain, ...entry };
  } catch (err: any) {
    if (cached) return { round, chain, ...cached };
    console.log(`  ⚠  ${chain} round ${round} fetch failed: ${err.message}`);
    return null;
  }
}

async function fetchRoundsInWindow(
  chain: VotiumChain,
  sinceTs: number,
  cache: RoundsCache
): Promise<VotiumRoundData[]> {
  const rounds: VotiumRoundData[] = [];
  let latest: number;
  try {
    latest = await fetchLatestVotiumRound(chain);
  } catch (e: any) {
    console.log(`  ⚠  ${chain} rounds list fetch failed: ${e.message}`);
    return [];
  }
  // Walk back from latest until a round ends before the window.
  for (let r = latest; r >= 1; r--) {
    const data = await fetchVotiumRoundData(chain, r, cache, latest);
    if (!data) continue;
    if (data.end < sinceTs) break;
    rounds.push(data);
  }
  rounds.sort((a, b) => a.end - b.end);
  return rounds;
}

function findRoundForEpoch(rounds: VotiumRoundData[], epochTs: number): VotiumRoundData | null {
  // Thursday epoch T maps to the smallest round whose end >= T.
  for (const r of rounds) {
    if (r.end >= epochTs) return r;
  }
  return null;
}

type RewardAttribution =
  | { kind: "direct" }
  | { kind: "delegate"; delegate: string }
  | { kind: "no-vote" }
  | { kind: "no-delegate" }
  | { kind: "delegate-silent"; delegate: string }
  | { kind: "error" };

interface RewardEstimate {
  totalUSD: number;
  perToken: Record<string, { amount: number; usd: number }>;
  attribution: RewardAttribution;
  matchedGauges: number;
}

async function estimateRewardsForRound(
  user: string,
  round: VotiumRoundData,
  cvxEvents: DelegationEvent[]
): Promise<RewardEstimate> {
  const base: Omit<RewardEstimate, "attribution"> = {
    totalUSD: 0,
    perToken: {},
    matchedGauges: 0,
  };
  const userLower = user.toLowerCase();

  let userVote: UserVote | null = null;
  let proposalData: ProposalScores = { choices: [], scores: [] };
  try {
    [userVote, proposalData] = await Promise.all([
      fetchUserVote(user, round.proposal),
      fetchProposalScores(round.proposal),
    ]);
  } catch {
    return { ...base, attribution: { kind: "error" } };
  }

  let attribution: RewardAttribution = { kind: "direct" };
  let effectiveChoice: Record<string, number> | null = null;
  let effectiveVP = 0;

  if (userVote && typeof userVote.choice === "object") {
    effectiveChoice = userVote.choice as Record<string, number>;
    effectiveVP = userVote.vp;
  } else if (proposalData.snapshot) {
    // No direct vote → fall back to user's cvx.eth delegate at proposal snapshot block.
    const snapshotBlock = BigInt(proposalData.snapshot);
    const delegate = reconstructCvxDelegate(cvxEvents, snapshotBlock);
    if (!delegate) {
      return { ...base, attribution: { kind: "no-delegate" } };
    }
    let delegateVote: UserVote | null = null;
    try {
      delegateVote = await fetchUserVote(delegate, round.proposal);
    } catch {
      return { ...base, attribution: { kind: "error" } };
    }
    if (!delegateVote || typeof delegateVote.choice !== "object") {
      return { ...base, attribution: { kind: "delegate-silent", delegate } };
    }
    effectiveChoice = delegateVote.choice as Record<string, number>;
    try {
      const vp = await getVotingPower(user, parseInt(proposalData.snapshot));
      effectiveVP = vp.total;
    } catch {
      return { ...base, attribution: { kind: "error" } };
    }
    attribution = { kind: "delegate", delegate };
  } else {
    return { ...base, attribution: { kind: "no-vote" } };
  }

  const totalWeight = Object.values(effectiveChoice).reduce((a, b) => a + b, 0) || 1;
  const result: RewardEstimate = { ...base, attribution, matchedGauges: 0 };

  for (const [choiceIdStr, weight] of Object.entries(effectiveChoice)) {
    const choiceIndex = parseInt(choiceIdStr) - 1;
    const gaugeVp = proposalData.scores[choiceIndex] || 0;
    if (gaugeVp <= 0) continue;
    const userContrib = (effectiveVP * weight) / totalWeight;

    const matchingBribes = round.bribes.filter((b) => b.choice === choiceIndex);
    if (matchingBribes.length === 0) continue;
    result.matchedGauges++;

    for (const b of matchingBribes) {
      if (b.excluded?.some((addr) => addr.toLowerCase() === userLower)) continue;

      const cap = b.maxPerVote && b.maxPerVote > 0 ? gaugeVp * b.maxPerVote : Infinity;
      const effectivePayout = Math.min(b.amount, cap);
      const effectiveUSD = b.amount > 0 ? b.amountDollars * (effectivePayout / b.amount) : 0;

      const userAmount = effectivePayout * (userContrib / gaugeVp);
      const userUSD = effectiveUSD * (userContrib / gaugeVp);

      const bucket = result.perToken[b.token] ?? { amount: 0, usd: 0 };
      bucket.amount += userAmount;
      bucket.usd += userUSD;
      result.perToken[b.token] = bucket;
      result.totalUSD += userUSD;
    }
  }

  return result;
}

interface TokenInfo {
  price: number;
  decimals: number;
  symbol: string;
}

async function getTokenPrices(tokens: string[]): Promise<Record<string, TokenInfo>> {
  if (tokens.length === 0) return {};

  // Batch query DefiLlama
  const coins = tokens.map(t => `ethereum:${t.toLowerCase()}`).join(",");
  try {
    const { data } = await axios.get(`${DEFILLAMA_ENDPOINT}/${coins}`);
    const result: Record<string, TokenInfo> = {};

    for (const token of tokens) {
      const key = `ethereum:${token.toLowerCase()}`;
      const info = data.coins[key];
      if (info) {
        result[token.toLowerCase()] = {
          price: info.price || 0,
          decimals: info.decimals || 18,
          symbol: info.symbol || token.slice(0, 6),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function findUserInMerkle(merklePath: string, address: string): any {
  if (!fs.existsSync(merklePath)) return null;
  const data = JSON.parse(fs.readFileSync(merklePath, "utf-8"));
  const claims = data.claims || data;
  for (const [addr, value] of Object.entries(claims)) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return { address: addr, data: value };
    }
  }
  return null;
}

interface UserShareInfo {
  type: "forwarder" | "non-forwarder" | "direct-voter";
  share: number;
  totalGroupRewardUSD: number;
}


function findUserShare(repartitionPath: string, address: string): UserShareInfo | null {
  if (!fs.existsSync(repartitionPath)) return null;
  const data = JSON.parse(fs.readFileSync(repartitionPath, "utf-8"));
  const dist = data.distribution || data;

  const lowerAddr = address.toLowerCase();

  // Calculate total USD for each group from totalPerGroup
  let forwardersUSD = 0;
  let nonForwardersUSD = 0;

  if (dist.totalPerGroup) {
    for (const [token, amounts] of Object.entries(dist.totalPerGroup) as any) {
      // Rough USD estimate (assume stablecoins = $1, will be refined with prices later)
      const fwdAmount = parseFloat(amounts.forwarders || "0") / 1e18;
      const nfwdAmount = parseFloat(amounts.nonForwarders || "0") / 1e18;
      forwardersUSD += fwdAmount;
      nonForwardersUSD += nfwdAmount;
    }
  }

  if (dist.forwarders) {
    for (const [addr, share] of Object.entries(dist.forwarders)) {
      if (addr.toLowerCase() === lowerAddr) {
        return {
          type: "forwarder",
          share: parseFloat(share as string),
          totalGroupRewardUSD: forwardersUSD
        };
      }
    }
  }

  if (dist.nonForwarders) {
    for (const [addr, share] of Object.entries(dist.nonForwarders)) {
      if (addr.toLowerCase() === lowerAddr) {
        return {
          type: "non-forwarder",
          share: parseFloat(share as string),
          totalGroupRewardUSD: nonForwardersUSD
        };
      }
    }
  }

  return null;
}

function getWeekTimestamps(): { current: number; previous: number } {
  const dirs = fs.readdirSync("bounties-reports")
    .filter(d => /^\d+$/.test(d))
    .map(d => parseInt(d))
    .sort((a, b) => b - a);
  return { current: dirs[0], previous: dirs[1] };
}

interface DirectVoterData {
  cumulative: Record<string, bigint>;
  thisWeek: Record<string, bigint>;
  sources: string[]; // which reward sources (curve, fxn)
}

function loadUserTokens(filePath: string, address: string): Record<string, bigint> {
  if (!fs.existsSync(filePath)) return {};
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const claims = data.claims || data;

  for (const [addr, value] of Object.entries(claims) as any) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      const tokens: Record<string, bigint> = {};
      for (const [token, info] of Object.entries(value.tokens || {}) as any) {
        tokens[token.toLowerCase()] = BigInt(info.amount);
      }
      return tokens;
    }
  }
  return {};
}

function findDirectVoter(currentWeek: number, previousWeek: number, address: string): DirectVoterData | null {
  const sources = ["curve", "fxn"];
  const cumulative: Record<string, bigint> = {};
  const thisWeek: Record<string, bigint> = {};
  const activeSources: string[] = [];

  for (const source of sources) {
    const currentPath = `bounties-reports/${currentWeek}/vlCVX/${source}/merkle_data_non_delegators.json`;
    const previousPath = `bounties-reports/${previousWeek}/vlCVX/${source}/merkle_data_non_delegators.json`;

    const currentTokens = loadUserTokens(currentPath, address);
    const previousTokens = loadUserTokens(previousPath, address);

    if (Object.keys(currentTokens).length > 0) {
      activeSources.push(source);
    }

    // Merge tokens
    for (const [token, amount] of Object.entries(currentTokens)) {
      const prev = previousTokens[token] || 0n;
      cumulative[token] = (cumulative[token] || 0n) + amount;
      const delta = amount - prev;
      if (delta > 0n) {
        thisWeek[token] = (thisWeek[token] || 0n) + delta;
      }
    }
  }

  if (Object.keys(cumulative).length === 0) return null;
  return { cumulative, thisWeek, sources: activeSources };
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(2);
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: pnpm tsx script/diagnose/checkVlCvxRewards.ts <address>");
    process.exit(1);
  }

  const checksumAddress = getAddress(address);
  const shortAddr = `${checksumAddress.slice(0, 6)}...${checksumAddress.slice(-4)}`;

  // ===== GATHER ALL DATA SILENTLY =====

  const weeks = getWeekTimestamps();
  const proposals = await getRecentProposals();
  proposals.sort((a, b) => a.end - b.end);

  const pastProposals = proposals.filter(p => p.end <= weeks.current);
  const rewardsProposal = pastProposals[pastProposals.length - 1];
  const nextProposal = proposals.find(p => p.end > weeks.current);

  if (!rewardsProposal) {
    console.error("Could not find proposal for current week rewards");
    process.exit(1);
  }

  const snapshotBlock = parseInt(rewardsProposal.snapshot);
  const nextSnapshotBlock = nextProposal ? parseInt(nextProposal.snapshot) : null;

  // Get VP values (direct + delegated)
  let weekBeforeVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let snapshotVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let nextSnapshotVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let liveVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };

  try { weekBeforeVP = await getVotingPower(checksumAddress, snapshotBlock - 50000); } catch {}
  try { snapshotVP = await getVotingPower(checksumAddress, snapshotBlock); } catch {}
  if (nextSnapshotBlock) {
    try { nextSnapshotVP = await getVotingPower(checksumAddress, nextSnapshotBlock); } catch {}
  }
  try { liveVP = await getVotingPower(checksumAddress, "latest"); } catch { liveVP = nextSnapshotVP.total > 0 ? nextSnapshotVP : snapshotVP; }

  // Get user type and rewards
  const repartitionDelegationPath = `bounties-reports/${weeks.current}/vlCVX/curve/repartition_delegation.json`;
  const userShare = findUserShare(repartitionDelegationPath, checksumAddress);
  const directVoterInfo = !userShare ? findDirectVoter(weeks.current, weeks.previous, checksumAddress) : null;

  // Get prices and calculate rewards
  const cvxPrice = await getCVXPrice();
  const aprsPath = `bounties-reports/latest/vlCVX/APRs.json`;
  const aprs = fs.existsSync(aprsPath) ? JSON.parse(fs.readFileSync(aprsPath, "utf-8")) : null;
  const poolAPR = aprs ? (aprs.usdPerCVX / cvxPrice) * 52 * 100 : 0;

  let thisWeekReward = 0;
  let userAPR = poolAPR;
  let nextWeekReward = 0;
  let thisWeekUSD = 0;
  let cumulativeUSD = 0;
  let prices: Record<string, TokenInfo> = {};

  if (userShare && aprs) {
    const groupRewardUSD = userShare.type === "forwarder" ? aprs.rewardValueUSD : userShare.totalGroupRewardUSD;
    thisWeekReward = groupRewardUSD * userShare.share;
    if (nextSnapshotVP.total > snapshotVP.total && snapshotVP.total > 0) {
      const totalGroupVP = snapshotVP.total / userShare.share;
      const nextShare = nextSnapshotVP.total / totalGroupVP;
      nextWeekReward = groupRewardUSD * nextShare;
    }
  } else if (directVoterInfo) {
    const allTokens = Object.keys(directVoterInfo.cumulative);
    prices = await getTokenPrices(allTokens);

    for (const [token, amount] of Object.entries(directVoterInfo.thisWeek)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      thisWeekUSD += scaled * (info?.price || 0);
    }

    for (const [token, amount] of Object.entries(directVoterInfo.cumulative)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      cumulativeUSD += scaled * (info?.price || 0);
    }

    if (snapshotVP.total > 0 && thisWeekUSD > 0) {
      userAPR = (thisWeekUSD * 52 / (snapshotVP.total * cvxPrice)) * 100;
    }
  }

  // ===== PRINT OUTPUT =====

  // Helper to format VP with delegation breakdown
  const formatVP = (vp: VotingPowerResult): string => {
    if (vp.delegated > 0 && vp.direct > 0) {
      return `${formatNumber(vp.total)} (${formatNumber(vp.direct)} own + ${formatNumber(vp.delegated)} delegated)`;
    } else if (vp.delegated > 0) {
      return `${formatNumber(vp.total)} (all delegated)`;
    }
    return `${formatNumber(vp.total)}`;
  };

  console.log(`\n=== vlCVX Diagnostic: ${shortAddr} ===\n`);

  // User type header (prominent)
  if (userShare) {
    const typeLabel = userShare.type.toUpperCase();
    console.log(`>>> ${typeLabel} (delegator) <<<`);
    console.log(`    Share: ${(userShare.share * 100).toFixed(4)}% of pool`);
    console.log(`    Snapshot VP: ${formatVP(snapshotVP)} vlCVX`);
    console.log(`\nThis Week: $${thisWeekReward.toFixed(2)}  →  APR: ${poolAPR.toFixed(2)}% ✓`);
    if (nextWeekReward > thisWeekReward) {
      console.log(`Next Week: ~$${nextWeekReward.toFixed(2)} (VP ↑ to ${formatNumber(nextSnapshotVP.total)})`);
    }
  } else if (directVoterInfo) {
    console.log(`>>> DIRECT VOTER (${directVoterInfo.sources.join(" + ")}) <<<`);
    console.log(`    Snapshot VP: ${formatVP(snapshotVP)} vlCVX`);
    console.log(`    Tokens: ${Object.keys(directVoterInfo.thisWeek).length} this week, ${Object.keys(directVoterInfo.cumulative).length} cumulative`);
    console.log(`\nThis Week: +$${formatNumber(thisWeekUSD)}  →  APR: ${userAPR.toFixed(2)}%`);
    console.log(`Cumulative: $${formatNumber(cumulativeUSD)} claimable`);
    if (userAPR < poolAPR * 0.9) {
      console.log(`⚠️  Below forwarder pool APR (${poolAPR.toFixed(2)}%)`);
    } else if (userAPR > poolAPR * 1.1) {
      console.log(`✓ Above forwarder pool APR (${poolAPR.toFixed(2)}%)`);
    }
  } else {
    console.log(`>>> NOT FOUND <<<`);
    console.log(`    User not in delegation or direct votes`);
    console.log(`    Possible: not delegated, expired, or 0 VP at snapshot`);
  }

  // Diagnosis warning (if applicable)
  if (liveVP.total > snapshotVP.total * 1.1) {
    const lockedAfter = liveVP.total - snapshotVP.total;
    const pctAfter = ((lockedAfter / liveVP.total) * 100).toFixed(0);
    console.log(`\n⚠️  Locked ${formatNumber(lockedAfter)} vlCVX (${pctAfter}%) AFTER snapshot`);
    console.log(`   Rewards based on ${formatNumber(snapshotVP.total)}, not ${formatNumber(liveVP.total)}`);
    if (userShare && thisWeekReward > 0) {
      const incorrectAPR = (thisWeekReward * 52 / (liveVP.total * cvxPrice)) * 100;
      console.log(`   User perceives ${incorrectAPR.toFixed(2)}% APR (wrong calculation)`);
    }
  }

  // ===== DETAILED SECTIONS =====

  console.log(section("Context"));
  console.log(`${pc.dim("Week:")}     ${weeks.current} (${new Date(weeks.current * 1000).toISOString().split("T")[0]})`);
  console.log(`${pc.dim("Snapshot:")} block ${snapshotBlock} (${rewardsProposal.title.replace("Gauge Weight for Week of ", "")})`);
  console.log(`${pc.dim("CVX Price:")} ${pc.green(`$${cvxPrice.toFixed(2)}`)}`);

  console.log(section("VP History"));
  console.log(`${pc.dim("~1 week before :")} ${formatVP(weekBeforeVP)} vlCVX`);
  console.log(`${pc.dim("Snapshot       :")} ${pc.bold(formatVP(snapshotVP))} vlCVX ${pc.cyan("← rewards")}`);
  if (nextSnapshotVP.total > 0) {
    console.log(`${pc.dim("Next snapshot  :")} ${formatVP(nextSnapshotVP)} vlCVX`);
  }
  console.log(`${pc.dim("Live (now)     :")} ${formatVP(liveVP)} vlCVX`);

  // Token details for direct voters
  if (directVoterInfo && Object.keys(directVoterInfo.thisWeek).length > 0) {
    const thisWeekTokens = Object.keys(directVoterInfo.thisWeek);
    const pricedCount = thisWeekTokens.filter(t => prices[t.toLowerCase()]).length;

    console.log(section(`This Week's Tokens (${thisWeekTokens.length}, ${pricedCount} priced)`));
    for (const [token, amount] of Object.entries(directVoterInfo.thisWeek)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      const symbol = info?.symbol || token.slice(0, 8);
      const price = info?.price || 0;
      const usd = scaled * price;

      if (price > 0) {
        console.log(`  ${symbol.padEnd(10)}: +${scaled.toFixed(4)} × $${price.toFixed(2)} = +$${usd.toFixed(2)}`);
      } else {
        console.log(`  ${symbol.padEnd(10)}: +${scaled.toFixed(4)} (no price)`);
      }
    }
  }

  // Delegation + Votium forwarding history (answers: undelegated? still forwarding?)
  // Skip for direct voters — they voted directly, history not needed for reward math
  // and full-range eth_getLogs frequently stalls on RPC providers.
  if (!directVoterInfo) try {
    const client = await getClient(1);
    const latestBlock = await withRetry(() => client.getBlockNumber());

    let events: DelegationEvent[] = [];
    let delegationLookupOk = false;
    try {
      events = await fetchUserDelegationEvents(checksumAddress, latestBlock);
      delegationLookupOk = true;
    } catch (e: any) {
      console.log(
        `\n  ⚠  Delegation events lookup failed (${e.shortMessage ?? e.message}). Continuing with empty set.`
      );
    }

    const snapDelegate = reconstructCvxDelegate(events, BigInt(snapshotBlock));
    const nowDelegate = reconstructCvxDelegate(events, latestBlock);

    const [votiumAtSnap, votiumNow] = await Promise.all([
      fetchVotiumForwardDestination(checksumAddress, BigInt(snapshotBlock)),
      fetchVotiumForwardDestination(checksumAddress),
    ]);

    console.log(section("cvx.eth Delegation State"));
    console.log(`  ${pc.dim(`At snapshot (block ${snapshotBlock}):`)} ${formatDelegate(snapDelegate)}`);
    console.log(`  ${pc.dim(`Now (block ${latestBlock})        :`)} ${formatDelegate(nowDelegate)}`);

    console.log(section("Votium Forwarding State"));
    console.log(`  ${pc.dim("At snapshot:")} ${formatForward(votiumAtSnap)}`);
    console.log(`  ${pc.dim("Now        :")} ${formatForward(votiumNow)}`);

    let forwarderEvents: ForwarderEvent[] = [];
    let forwarderLookupOk = false;
    try {
      forwarderEvents = await fetchUserForwarderEvents(
        checksumAddress,
        latestBlock
      );
      forwarderLookupOk = true;
    } catch (e: any) {
      console.log(
        `\n  ⚠  Votium forwarder events lookup failed (${e.shortMessage ?? e.message}). Timeline/rounds will show delegation only.`
      );
    }

    // ===== View A: Unified Timeline =====
    const shortAddr = (addr: string) =>
      `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    const fmtDeleg = (addr: string | null): string =>
      !addr
        ? "—"
        : addr.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
          ? "StakeDAO"
          : shortAddr(addr);
    const fmtFwd = (addr: string | null): string =>
      !addr
        ? "—"
        : addr.toLowerCase() === VOTIUM_FORWARDER.toLowerCase()
          ? "StakeDAO"
          : shortAddr(addr);

    interface TimelineRow {
      date: string;
      block: bigint;
      stream: "deleg" | "forward";
      action: string;
      result: string;
    }
    const timeline: TimelineRow[] = [];

    // Merge same-day Clear+Set pairs on cvx.eth into one "Clear + Set" row.
    const cvxEvents = events.filter(
      (e) => e.space.toLowerCase() === CVX_SPACE_BYTES32.toLowerCase()
    );
    for (let i = 0; i < cvxEvents.length; i++) {
      const e = cvxEvents[i];
      const date = e.timestamp
        ? new Date(e.timestamp * 1000).toISOString().slice(0, 10)
        : "?";
      const next = cvxEvents[i + 1];
      const nextDate = next?.timestamp
        ? new Date(next.timestamp * 1000).toISOString().slice(0, 10)
        : null;
      if (e.type === "Clear" && next && next.type === "Set" && date === nextDate) {
        timeline.push({
          date,
          block: e.block,
          stream: "deleg",
          action: "Clear + Set",
          result: fmtDeleg(next.delegate),
        });
        i++;
      } else if (e.type === "Set") {
        timeline.push({
          date,
          block: e.block,
          stream: "deleg",
          action: "Set",
          result: fmtDeleg(e.delegate),
        });
      } else {
        timeline.push({
          date,
          block: e.block,
          stream: "deleg",
          action: "Clear",
          result: `— (was ${fmtDeleg(e.delegate)})`,
        });
      }
    }

    for (const e of forwarderEvents) {
      const date = e.timestamp
        ? new Date(e.timestamp * 1000).toISOString().slice(0, 10)
        : "?";
      if (e.type === "Set") {
        const startDate = new Date(e.startOrEnd * 1000).toISOString().slice(0, 10);
        timeline.push({
          date,
          block: e.block,
          stream: "forward",
          action: `Set (active ${startDate})`,
          result: fmtFwd(e.to),
        });
      } else {
        const endDate = new Date(e.startOrEnd * 1000).toISOString().slice(0, 10);
        timeline.push({
          date,
          block: e.block,
          stream: "forward",
          action: `Exp (ends ${endDate})`,
          result: "(expiring)",
        });
      }
    }

    timeline.sort((a, b) =>
      a.block < b.block ? -1 : a.block > b.block ? 1 : 0
    );

    console.log(
      section(`Timeline: Delegation + Votium Forwarding (${timeline.length})`)
    );
    if (timeline.length === 0) {
      console.log(pc.dim("  (no events)"));
    } else {
      const tbl = defaultTable({
        head: ["Date", "Block", "Stream", "Action", "Result"],
        colAligns: ["left", "right", "left", "left", "left"],
      });
      for (const r of timeline) {
        const streamColor =
          r.stream === "deleg" ? pc.blue(r.stream) : pc.magenta(r.stream);
        tbl.push([
          r.date,
          pc.dim(r.block.toString()),
          streamColor,
          r.action,
          colorizeAddr(r.result),
        ]);
      }
      console.log(tbl.toString());
    }

    // Fetch Votium rounds within the 2-month window (independent of event history).
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - TWO_MONTHS_SEC;
    const roundsCache = loadRoundsCache();
    const [crvRounds, fxnRounds] = await Promise.all([
      fetchRoundsInWindow("cvx-crv", windowStart, roundsCache),
      fetchRoundsInWindow("cvx-fxn", windowStart, roundsCache),
    ]);
    saveRoundsCache(roundsCache);

    // Pre-compute reward estimates for every round (in parallel) so View B can
    // attach USD values to the round-closing weekly epoch.
    const allRounds: VotiumRoundData[] = [...crvRounds, ...fxnRounds].sort(
      (a, b) => a.end - b.end
    );
    const estEntries = await Promise.all(
      allRounds.map(async (round) => ({
        round,
        est: await estimateRewardsForRound(
          checksumAddress,
          round,
          events
        ),
      }))
    );
    const estMap = new Map<string, { round: VotiumRoundData; est: RewardEstimate }>();
    for (const e of estEntries) {
      estMap.set(`${e.round.chain}:${e.round.round}`, e);
    }
    // ===== View B: Rounds (one row per Votium round) =====
    type Status = "aligned" | "forwarder only" | "deleg only" | "neither";
    const classify = (fwd: string | null, del: string | null): Status => {
      const isFwd =
        !!fwd && fwd.toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
      const isDel =
        !!del && del.toLowerCase() === DELEGATION_ADDRESS.toLowerCase();
      if (isFwd && isDel) return "aligned";
      if (isFwd) return "forwarder only";
      if (isDel) return "deleg only";
      return "neither";
    };
    const icon: Record<Status, string> = {
      aligned: "✓",
      "forwarder only": "⚠",
      "deleg only": "•",
      neither: " ",
    };

    interface RoundBucket {
      closeEpoch: number;
      crv?: VotiumRoundData;
      fxn?: VotiumRoundData;
    }
    const buckets = new Map<number, RoundBucket>();
    for (const r of crvRounds) {
      const ep = Math.floor(r.end / WEEK) * WEEK;
      const b = buckets.get(ep) ?? { closeEpoch: ep };
      b.crv = r;
      buckets.set(ep, b);
    }
    for (const r of fxnRounds) {
      const ep = Math.floor(r.end / WEEK) * WEEK;
      const b = buckets.get(ep) ?? { closeEpoch: ep };
      b.fxn = r;
      buckets.set(ep, b);
    }
    const roundBuckets = [...buckets.values()].sort(
      (a, b) => a.closeEpoch - b.closeEpoch
    );

    let pendingExpTs: number | null = null;
    const lastExp = [...forwarderEvents].reverse().find((e) => e.type === "Exp");
    const lastSet = [...forwarderEvents].reverse().find((e) => e.type === "Set");
    if (lastExp && (!lastSet || lastExp.block > lastSet.block)) {
      if (lastExp.startOrEnd > nowSec) pendingExpTs = lastExp.startOrEnd;
    }

    if (roundBuckets.length > 0 && delegationLookupOk && forwarderLookupOk) {
      console.log(
        section(`Rounds (${roundBuckets.length} rounds, last 2 months)`)
      );
      const tbl = defaultTable({
        head: ["Period", "Delegate", "Forwarder", "CRV direct (est)", "FXN direct (est)", "Status"],
        colAligns: ["left", "left", "left", "right", "right", "left"],
      });
      const tally: Record<Status, number> = {
        aligned: 0,
        "forwarder only": 0,
        "deleg only": 0,
        neither: 0,
      };
      let crvTotal = 0;
      let fxnTotal = 0;
      let forwarderOnlyLoss = 0;
      let anyChangeFlag = false;
      const alignedSuffix = pc.dim(" → sCRVUSD");
      const delegSuffix = pc.dim(" via delegate");
      for (const b of roundBuckets) {
        const openTs = b.closeEpoch - WEEK;
        const close = new Date(b.closeEpoch * 1000).toISOString().slice(0, 10);
        const open = new Date(openTs * 1000).toISOString().slice(0, 10);
        const delOpen = reconstructCvxDelegateAtTime(events, openTs);
        const delClose = reconstructCvxDelegateAtTime(events, b.closeEpoch);
        const fwdOpen = reconstructForwarderAtTime(forwarderEvents, openTs);
        const fwdClose = reconstructForwarderAtTime(forwarderEvents, b.closeEpoch);

        const delChanged = (delOpen ?? "") !== (delClose ?? "");
        const fwdChanged = (fwdOpen ?? "") !== (fwdClose ?? "");
        if (delChanged || fwdChanged) anyChangeFlag = true;

        // Classify + display by voting-time state — that's what earns rewards.
        // Mid-round changes are flagged with `*` so user can see the drift.
        const delCell =
          colorizeAddr(fmtDeleg(delOpen)) + (delChanged ? pc.yellow("*") : "");
        const fwdCell =
          colorizeAddr(fmtFwd(fwdOpen)) + (fwdChanged ? pc.yellow("*") : "");
        const status = classify(fwdOpen, delOpen);
        tally[status]++;

        const crvEntry = b.crv
          ? estMap.get(`cvx-crv:${b.crv.round}`)
          : undefined;
        const fxnEntry = b.fxn
          ? estMap.get(`cvx-fxn:${b.fxn.round}`)
          : undefined;
        const crvUSD = crvEntry?.est.totalUSD ?? 0;
        const fxnUSD = fxnEntry?.est.totalUSD ?? 0;
        // Only "neither" is a direct-claim $ for the user (user voted themselves, no forwarder).
        // "forwarder only" payouts go to the forwarder, not the user → tracked in forwarderOnlyLoss.
        // "aligned" flows via sCRVUSD merkle; "deleg only" depends on the user's forwarder state.
        if (status === "neither") {
          crvTotal += crvUSD;
          fxnTotal += fxnUSD;
        }
        if (status === "forwarder only") forwarderOnlyLoss += crvUSD + fxnUSD;
        const crvCell = b.crv
          ? status === "aligned"
            ? pc.dim(`#${b.crv.round}`) + alignedSuffix
            : status === "deleg only"
              ? pc.dim(`#${b.crv.round}`) + delegSuffix
              : roundLabel("cvx-crv", b.crv.round, crvUSD)
          : pc.dim("—");
        const fxnCell = b.fxn
          ? status === "aligned"
            ? pc.dim(`#${b.fxn.round}`) + alignedSuffix
            : status === "deleg only"
              ? pc.dim(`#${b.fxn.round}`) + delegSuffix
              : roundLabel("cvx-fxn", b.fxn.round, fxnUSD)
          : pc.dim("—");

        const isLast =
          b.closeEpoch === roundBuckets[roundBuckets.length - 1].closeEpoch;
        const note =
          isLast && pendingExpTs && status === "forwarder only"
            ? pc.dim(
                ` (exp ${new Date(pendingExpTs * 1000)
                  .toISOString()
                  .slice(5, 10)})`
              )
            : "";

        tbl.push([
          `${open} ${pc.dim("→")} ${close}`,
          delCell,
          fwdCell,
          crvCell,
          fxnCell,
          `${statusBadge(status)}${note}`,
        ]);
      }
      const allAligned = tally.aligned === roundBuckets.length;
      if (allAligned) {
        console.log(
          pc.dim(
            `  All ${roundBuckets.length} rounds aligned (StakeDAO delegate + forwarder). Rewards flow via sCRVUSD delegators merkle — see Merkle Status.`
          )
        );
      } else {
        const grandTotal = crvTotal + fxnTotal;
        tbl.push([
          pc.bold("Total"),
          "",
          "",
          pc.bold(usdCell(crvTotal)),
          pc.bold(usdCell(fxnTotal)),
          pc.bold(`= ${usdCell(grandTotal)}`),
        ]);
        console.log(tbl.toString());
        if (
          tally.aligned > 0 ||
          tally["deleg only"] > 0 ||
          tally["forwarder only"] > 0
        ) {
          const excludedParts: string[] = [];
          if (tally.aligned > 0) excludedParts.push("aligned rows flow via sCRVUSD merkle");
          if (tally["forwarder only"] > 0) excludedParts.push("forwarder-only rows are paid to the forwarder, not the user");
          if (tally["deleg only"] > 0) excludedParts.push("deleg-only rows depend on delegate + forwarder state");
          console.log(
            pc.dim(
              `  Values = direct-claim via Votium; ${excludedParts.join("; ")} — excluded from totals.`
            )
          );
        }
        if (anyChangeFlag) {
          console.log(
            pc.dim(
              `  ${pc.yellow("*")} state changed mid-round (shown value is at close); see Timeline above`
            )
          );
        }
        const summaryParts: string[] = [];
        if (tally.aligned > 0)
          summaryParts.push(pc.green(`${tally.aligned} aligned`));
        if (tally["forwarder only"] > 0)
          summaryParts.push(
            pc.yellow(`${tally["forwarder only"]} forwarder-only`)
          );
        if (tally["deleg only"] > 0)
          summaryParts.push(pc.cyan(`${tally["deleg only"]} deleg-only`));
        if (tally.neither > 0)
          summaryParts.push(pc.dim(`${tally.neither} neither`));
        console.log(`\n  ${pc.bold("Summary:")} ${summaryParts.join(pc.dim(" · "))}`);
        if (forwarderOnlyLoss > 0) {
          console.log(
            `  ${pc.bold(pc.red("Lost (forwarder-only):"))} ${pc.red(`$${forwarderOnlyLoss.toFixed(2)}`)} ${pc.dim("— forwarded to StakeDAO but not delegated; no compensating sCRVUSD")}`
          );
        }
      }
    }

    const delegatedSnap =
      snapDelegate && snapDelegate.toLowerCase() === DELEGATION_ADDRESS.toLowerCase();
    const forwardingSnap =
      votiumAtSnap && votiumAtSnap.toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
    const delegatedNow =
      nowDelegate && nowDelegate.toLowerCase() === DELEGATION_ADDRESS.toLowerCase();
    const forwardingNow =
      votiumNow && votiumNow.toLowerCase() === VOTIUM_FORWARDER.toLowerCase();

    if (delegationLookupOk && !delegatedSnap && forwardingSnap) {
      console.log(
        `\n  ⚠  At snapshot: undelegated from StakeDAO but still forwarding on Votium.`
      );
      console.log(
        `     Explains presence in cumulative delegators merkle with no new allocation this week.`
      );
      console.log(
        `     See Rounds table above for per-round direct-claim estimates in this state.`
      );
    }
    if (delegatedSnap !== delegatedNow || forwardingSnap !== forwardingNow) {
      console.log(`  ℹ  State changed between snapshot and now.`);
    }
  } catch (e: any) {
    console.log(
      section(
        `Delegation/Forwarding history: ${pc.red("lookup failed")} (${e.shortMessage ?? e.message})`
      )
    );
  }

  // Merkle status
  console.log(section("Merkle Status"));
  const delegatorsMerkle = findUserInMerkle("bounties-reports/latest/vlCVX/vlcvx_merkle_delegators.json", checksumAddress);
  const mainMerkle = findUserInMerkle("bounties-reports/latest/vlCVX/vlcvx_merkle.json", checksumAddress);

  if (delegatorsMerkle) {
    console.log("Found in: Delegators Merkle (sCRVUSD)");
    const tokens = delegatorsMerkle.data.tokens || {};
    for (const [token, info] of Object.entries(tokens) as any) {
      const amount = parseFloat(info.amount) / 1e18;
      console.log(`  ${token.slice(0, 10)}...: ${amount.toFixed(4)}`);
    }
  } else if (mainMerkle) {
    const tokens = mainMerkle.data.tokens || {};
    console.log(`Found in: Main Merkle (${Object.keys(tokens).length} tokens)`);
  } else {
    console.log("Not found in any merkle");
  }

  console.log("");
}

main().catch(console.error);
