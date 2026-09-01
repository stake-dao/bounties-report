import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { utils } from "ethers";
import { formatUnits, toHex, type PublicClient } from "viem";
import {
  BOTMARKETS,
  NETWORK_TO_MERKLE,
} from "../../utils/constants";
import { getClient } from "../../utils/getClients";

const WEEK = 604_800;
const MAX_WEEKS_BACK = 8;
const ETHEREUM_CHAIN_ID = 1;
const ETHEREUM_NETWORK = "ethereum";
const NETWORK_CHAIN_IDS: Record<string, number> = { ethereum: 1, bsc: 56 };
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const CLAIMED_TOPIC =
  "0x4766921f5c59646d22d7d266a29164c8e9623684d8dfdbd931731dfdca025238";
const LOG_BLOCK_CHUNK = 50_000n;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ROOT_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const MERKLE_ABI = [
  {
    name: "merkleRoot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface SerializedBigNumber {
  type?: unknown;
  hex?: unknown;
  _hex?: unknown;
}

export interface MerkleClaim {
  index?: unknown;
  amount?: unknown;
  proof?: unknown;
}

export interface MerkleEntry {
  symbol?: unknown;
  address?: unknown;
  merkle?: unknown;
  root?: unknown;
  total?: unknown;
  chainId?: unknown;
  merkleContract?: unknown;
}

interface LogTransaction {
  network?: unknown;
  tokenAddressesToFreeze?: unknown;
  newMerkleRoots?: unknown;
}

export interface LogData {
  period?: unknown;
  postFreeze?: unknown;
  Transactions?: unknown;
  TotalReported?: unknown;
  DistributionSurplus?: unknown;
}

export interface EthereumTargets {
  tokens: string[];
  roots: string[];
}

export interface CheckResult {
  id: "V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7" | "V8" | "V9" | "V10" | "V11";
  name: string;
  ok: boolean;
  detail: string;
}

interface RawClaimedLog {
  data: string;
  topics: string[];
}

export interface ContinuityViolation {
  holder: string;
  previous: bigint;
  current: bigint;
  claimedSince: bigint;
}

export interface ClaimedTokenWindow {
  previousAmounts: Map<string, bigint>;
  currentAmounts: Map<string, bigint>;
  claimedSince: Map<string, bigint>;
  eventCount: number;
  fromBlock?: bigint;
}

export interface ClaimAwareContext {
  previousPeriod: number;
  previousMerkle: MerkleEntry[];
  tokens: Map<string, ClaimedTokenWindow>;
}

export type ClientForChain = (chainId: number) => Promise<PublicClient>;

export function parseJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${label} is not an address`);
  }
  return value.toLowerCase();
}

function normalizeRoot(value: unknown, label: string): string {
  if (typeof value !== "string" || !ROOT_PATTERN.test(value)) {
    throw new Error(`${label} is not a bytes32 root`);
  }
  return value.toLowerCase();
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`${label} is not an integer`);
    }
  }
  if (value && typeof value === "object") {
    const hex = (value as SerializedBigNumber).hex ?? (value as SerializedBigNumber)._hex;
    if (typeof hex === "string" && /^[0-9a-fA-F]+$/.test(hex.replace(/^0x/i, ""))) {
      return BigInt(hex.toLowerCase().startsWith("0x") ? hex : `0x${hex}`);
    }
  }
  throw new Error(`${label} is not an integer`);
}

function parsePeriodArg(): number | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf("--period");
  if (index < 0) return undefined;
  const period = Number(args[index + 1]);
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error("Usage: checkBeforeSetRoots [--period <timestamp>]");
  }
  return period;
}

function latestLocalPeriod(): number {
  const reportsDir = "bounties-reports";
  const periods = readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((period) =>
      existsSync(path.join(reportsDir, String(period), "merkle.json")),
    )
    .sort((a, b) => b - a);
  if (periods.length === 0) throw new Error("No archived merkle.json found");
  return periods[0];
}

function resolvePeriod(log: LogData): number {
  const explicitPeriod = parsePeriodArg();
  if (explicitPeriod !== undefined) return explicitPeriod;
  if (
    typeof log.period === "number" &&
    Number.isInteger(log.period) &&
    log.period > 0
  ) {
    return log.period;
  }
  return latestLocalPeriod();
}

export function loadMerkle(period: number): MerkleEntry[] {
  const merklePath = path.join(
    "bounties-reports",
    String(period),
    "merkle.json",
  );
  if (!existsSync(merklePath)) {
    throw new Error(`Merkle file not found: ${merklePath}`);
  }
  const parsed = parseJson<unknown>(merklePath);
  if (!Array.isArray(parsed)) throw new Error(`${merklePath} is not an array`);
  return parsed as MerkleEntry[];
}

export function ethereumTargets(log: LogData): EthereumTargets {
  if (!Array.isArray(log.Transactions)) {
    throw new Error("log.Transactions is not an array");
  }
  const transactions = (log.Transactions as LogTransaction[]).filter(
    (transaction) => transaction.network === ETHEREUM_NETWORK,
  );
  if (transactions.length === 0) {
    throw new Error("log.Transactions has no ethereum entry");
  }

  const tokens: string[] = [];
  const roots: string[] = [];
  for (const [transactionIndex, transaction] of transactions.entries()) {
    if (
      !Array.isArray(transaction.tokenAddressesToFreeze) ||
      !Array.isArray(transaction.newMerkleRoots)
    ) {
      throw new Error(`ethereum transaction ${transactionIndex} has invalid target arrays`);
    }
    if (
      transaction.tokenAddressesToFreeze.length !==
      transaction.newMerkleRoots.length
    ) {
      throw new Error(`ethereum transaction ${transactionIndex} target lengths differ`);
    }
    for (let i = 0; i < transaction.tokenAddressesToFreeze.length; i++) {
      tokens.push(
        normalizeAddress(
          transaction.tokenAddressesToFreeze[i],
          `ethereum token ${i}`,
        ),
      );
      roots.push(
        normalizeRoot(transaction.newMerkleRoots[i], `ethereum root ${i}`),
      );
    }
  }
  if (tokens.length === 0) throw new Error("ethereum target list is empty");
  return { tokens, roots };
}

export function entryKey(entry: MerkleEntry): string {
  const chainId = typeof entry.chainId === "number" ? entry.chainId : 1;
  return `${chainId}:${normalizeAddress(entry.address, "merkle token")}`;
}

function entriesByEthereumAddress(merkle: MerkleEntry[]): Map<string, MerkleEntry> {
  const entries = new Map<string, MerkleEntry>();
  for (const entry of merkle) {
    if (entry.chainId !== ETHEREUM_CHAIN_ID) continue;
    const address = normalizeAddress(entry.address, "Ethereum merkle token");
    if (entries.has(address)) throw new Error(`duplicate Ethereum token ${address}`);
    entries.set(address, entry);
  }
  return entries;
}

function hashPair(left: string, right: string): string {
  const [first, second] =
    left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left];
  return utils.keccak256(utils.concat([first, second])).toLowerCase();
}

export function recomputeMerkleRoot(entry: MerkleEntry): string {
  if (!entry.merkle || typeof entry.merkle !== "object" || Array.isArray(entry.merkle)) {
    throw new Error("merkle claims are not an object");
  }
  const indexedLeaves: Array<string | undefined> = [];
  for (const [holder, rawClaim] of Object.entries(
    entry.merkle as Record<string, unknown>,
  )) {
    if (!rawClaim || typeof rawClaim !== "object") {
      throw new Error(`claim for ${holder} is not an object`);
    }
    const claim = rawClaim as MerkleClaim;
    if (!Number.isInteger(claim.index) || (claim.index as number) < 0) {
      throw new Error(`invalid index for holder ${holder}`);
    }
    const index = claim.index as number;
    if (indexedLeaves[index] !== undefined) {
      throw new Error(`duplicate merkle index ${index}`);
    }
    const amount = toBigInt(claim.amount, `amount for holder ${holder}`);
    indexedLeaves[index] = utils.solidityKeccak256(
      ["uint256", "address", "uint256"],
      [index, normalizeAddress(holder, "holder"), amount.toString()],
    );
  }
  if (indexedLeaves.length === 0 || indexedLeaves.some((leaf) => leaf === undefined)) {
    throw new Error("merkle indices are empty or non-contiguous");
  }

  let layer = (indexedLeaves as string[]).sort((a, b) =>
    Buffer.compare(Buffer.from(a.slice(2), "hex"), Buffer.from(b.slice(2), "hex")),
  );
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    }
    layer = next;
  }
  return layer[0].toLowerCase();
}

function verifyLeaf(
  holder: string,
  claim: MerkleClaim,
  expectedRoot: string,
): boolean {
  if (!Number.isInteger(claim.index) || (claim.index as number) < 0) {
    throw new Error(`invalid index for holder ${holder}`);
  }
  const amount = toBigInt(claim.amount, `amount for holder ${holder}`);
  if (!Array.isArray(claim.proof)) {
    throw new Error(`invalid proof for holder ${holder}`);
  }
  let hash = utils.solidityKeccak256(
    ["uint256", "address", "uint256"],
    [claim.index as number, normalizeAddress(holder, "holder"), amount.toString()],
  );
  for (const [proofIndex, siblingValue] of claim.proof.entries()) {
    const sibling = normalizeRoot(
      siblingValue,
      `proof ${proofIndex} for holder ${holder}`,
    );
    hash = hashPair(hash, sibling);
  }
  return hash === expectedRoot;
}

export function checkV1(
  merkle: MerkleEntry[],
  targets: EthereumTargets,
  log?: LogData,
): CheckResult {
  let leafCount = 0;
  for (const entry of merkle) {
    const symbol = typeof entry.symbol === "string" ? entry.symbol : "unknown";
    const root = normalizeRoot(entry.root, `${symbol} root`);
    const rebuiltRoot = recomputeMerkleRoot(entry);
    if (rebuiltRoot !== root) {
      throw new Error(`${symbol} rebuilt root ${rebuiltRoot} differs from ${root}`);
    }
    if (!entry.merkle || typeof entry.merkle !== "object" || Array.isArray(entry.merkle)) {
      throw new Error(`${symbol} merkle is not an object`);
    }
    for (const [holder, claimValue] of Object.entries(
      entry.merkle as Record<string, unknown>,
    )) {
      if (!claimValue || typeof claimValue !== "object") {
        throw new Error(`${symbol} claim for ${holder} is not an object`);
      }
      if (!verifyLeaf(holder, claimValue as MerkleClaim, root)) {
        throw new Error(`${symbol} proof does not fold to root for ${holder}`);
      }
      leafCount++;
    }
  }

  const ethereumEntries = entriesByEthereumAddress(merkle);
  for (let i = 0; i < targets.tokens.length; i++) {
    const entry = ethereumEntries.get(targets.tokens[i]);
    if (!entry) throw new Error(`log token ${targets.tokens[i]} is absent from merkle.json`);
    const merkleRoot = normalizeRoot(entry.root, `${targets.tokens[i]} merkle root`);
    if (merkleRoot !== targets.roots[i]) {
      throw new Error(
        `root mismatch for ${targets.tokens[i]}: merkle=${merkleRoot} log=${targets.roots[i]}`,
      );
    }
  }

  let loggedRootCount = targets.roots.length;
  if (log) {
    if (!Array.isArray(log.Transactions)) throw new Error("log.Transactions is not an array");
    loggedRootCount = 0;
    const entries = new Map(merkle.map((entry) => [entryKey(entry), entry]));
    for (const [transactionIndex, rawTransaction] of (log.Transactions as LogTransaction[]).entries()) {
      if (typeof rawTransaction.network !== "string") {
        throw new Error(`transaction ${transactionIndex} has no network`);
      }
      const chainId = NETWORK_CHAIN_IDS[rawTransaction.network];
      if (!chainId) throw new Error(`transaction ${transactionIndex} has unsupported network ${rawTransaction.network}`);
      if (!Array.isArray(rawTransaction.tokenAddressesToFreeze) || !Array.isArray(rawTransaction.newMerkleRoots)) {
        throw new Error(`transaction ${transactionIndex} has invalid target arrays`);
      }
      if (rawTransaction.tokenAddressesToFreeze.length !== rawTransaction.newMerkleRoots.length) {
        throw new Error(`transaction ${transactionIndex} target lengths differ`);
      }
      for (let i = 0; i < rawTransaction.tokenAddressesToFreeze.length; i++) {
        const token = normalizeAddress(rawTransaction.tokenAddressesToFreeze[i], `transaction ${transactionIndex} token ${i}`);
        const loggedRoot = normalizeRoot(rawTransaction.newMerkleRoots[i], `transaction ${transactionIndex} root ${i}`);
        const entry = entries.get(`${chainId}:${token}`);
        if (!entry) throw new Error(`log token ${chainId}:${token} is absent from merkle.json`);
        const merkleRoot = normalizeRoot(entry.root, `${chainId}:${token} merkle root`);
        if (merkleRoot !== loggedRoot) {
          throw new Error(`root mismatch for ${chainId}:${token}: merkle=${merkleRoot} log=${loggedRoot}`);
        }
        loggedRootCount++;
      }
    }
  }

  return {
    id: "V1",
    name: "Rebuild",
    ok: true,
    detail: `${leafCount} leaf proofs and full roots rebuilt; ${loggedRootCount} log roots match`,
  };
}

function findPreviousMerkle(period: number): { period: number; merkle: MerkleEntry[] } {
  for (let weeksBack = 1; weeksBack <= MAX_WEEKS_BACK; weeksBack++) {
    const candidate = period - weeksBack * WEEK;
    const candidatePath = path.join(
      "bounties-reports",
      String(candidate),
      "merkle.json",
    );
    if (existsSync(candidatePath)) {
      return { period: candidate, merkle: loadMerkle(candidate) };
    }
  }
  throw new Error(`no previous merkle found within ${MAX_WEEKS_BACK} weeks`);
}

function claimsByAddress(entry: MerkleEntry): Map<string, MerkleClaim> {
  if (!entry.merkle || typeof entry.merkle !== "object" || Array.isArray(entry.merkle)) {
    throw new Error("merkle claims are not an object");
  }
  const claims = new Map<string, MerkleClaim>();
  for (const [holder, claim] of Object.entries(
    entry.merkle as Record<string, unknown>,
  )) {
    if (!claim || typeof claim !== "object") {
      throw new Error(`claim for ${holder} is not an object`);
    }
    claims.set(normalizeAddress(holder, "holder"), claim as MerkleClaim);
  }
  return claims;
}

function claimAmountsByAddress(entry: MerkleEntry | undefined): Map<string, bigint> {
  if (!entry) return new Map();
  const claims = claimsByAddress(entry);
  return new Map(
    [...claims].map(([holder, claim]) => [
      holder,
      toBigInt(claim.amount, `amount for ${holder}`),
    ]),
  );
}

export function findClaimAwareContinuityViolations(
  previous: Map<string, bigint>,
  current: Map<string, bigint>,
  claimedSince: Map<string, bigint>,
): ContinuityViolation[] {
  const violations: ContinuityViolation[] = [];
  for (const [holder, previousAmount] of previous) {
    const currentAmount = current.get(holder) ?? 0n;
    const claimedAmount = claimedSince.get(holder) ?? 0n;
    if (currentAmount + claimedAmount < previousAmount) {
      violations.push({
        holder,
        previous: previousAmount,
        current: currentAmount,
        claimedSince: claimedAmount,
      });
    }
  }
  return violations;
}

function resolveEntryChainId(
  currentEntry: MerkleEntry | undefined,
  previousEntry: MerkleEntry,
): number {
  if (typeof currentEntry?.chainId === "number") return currentEntry.chainId;
  if (typeof previousEntry.chainId === "number") return previousEntry.chainId;
  return ETHEREUM_CHAIN_ID;
}

function defaultMerkleContract(chainId: number): string {
  if (chainId === ETHEREUM_CHAIN_ID) {
    return normalizeAddress(
      NETWORK_TO_MERKLE.ethereum,
      "Ethereum default merkle contract",
    );
  }
  if (chainId === 56) {
    return normalizeAddress(NETWORK_TO_MERKLE.bsc, "BSC default merkle contract");
  }
  throw new Error(`no default merkle contract for chain ${chainId}`);
}

function resolveEntryMerkleContract(
  currentEntry: MerkleEntry | undefined,
  previousEntry: MerkleEntry,
  chainId: number,
): string {
  const candidate = currentEntry?.merkleContract ?? previousEntry.merkleContract;
  if (candidate !== undefined && candidate !== null) {
    return normalizeAddress(candidate, "merkleContract");
  }
  return defaultMerkleContract(chainId);
}

function cachedClaimStartBlock(
  chainId: number,
  merkleContract: string,
  token: string,
): bigint | undefined {
  const cachePath = path.join(
    "data",
    "merkle_updates",
    String(chainId),
    merkleContract,
    `${token}.json`,
  );
  if (!existsSync(cachePath)) return undefined;

  const cache = parseJson<{ blockNumber?: unknown }>(cachePath);
  if (
    typeof cache.blockNumber !== "number" ||
    !Number.isSafeInteger(cache.blockNumber) ||
    cache.blockNumber < 0
  ) {
    throw new Error(`invalid blockNumber in ${cachePath}`);
  }
  return BigInt(cache.blockNumber);
}

function fallbackClaimBlockRange(chainId: number): bigint {
  // Approximate three weeks at 12 seconds/block on Ethereum and 3 seconds/block on BSC.
  return chainId === 56 ? 604_800n : 151_200n;
}

function decodeClaimedLog(log: RawClaimedLog): { account: string; amount: bigint } {
  if (!Array.isArray(log.topics) || log.topics.length < 3) {
    throw new Error("Claimed log is missing topic2 account");
  }
  if (log.topics[0]?.toLowerCase() !== CLAIMED_TOPIC) {
    throw new Error(`unexpected Claimed topic0 ${String(log.topics[0])}`);
  }
  const accountTopic = log.topics[2];
  if (!ROOT_PATTERN.test(accountTopic)) {
    throw new Error("Claimed topic2 is not bytes32");
  }
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (!/^[0-9a-fA-F]+$/.test(data) || data.length < 128) {
    throw new Error("Claimed data does not contain index and amount words");
  }
  return {
    account: normalizeAddress(`0x${accountTopic.slice(-40)}`, "Claimed account"),
    amount: BigInt(`0x${data.slice(64, 128)}`),
  };
}

async function fetchClaimedSince(
  client: PublicClient,
  chainId: number,
  merkleContract: string,
  token: string,
): Promise<{ amounts: Map<string, bigint>; eventCount: number; fromBlock: bigint }> {
  const toBlock = await client.getBlockNumber();
  const cachedBlock = cachedClaimStartBlock(chainId, merkleContract, token);
  const fallbackRange = fallbackClaimBlockRange(chainId);
  const fromBlock = cachedBlock ?? (toBlock > fallbackRange ? toBlock - fallbackRange : 0n);
  if (fromBlock > toBlock) {
    throw new Error(`claim start block ${fromBlock} is after latest block ${toBlock}`);
  }

  const tokenTopic = utils.hexZeroPad(token, 32).toLowerCase();
  const logs: RawClaimedLog[] = [];
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += LOG_BLOCK_CHUNK) {
    const chunkEnd =
      chunkStart + LOG_BLOCK_CHUNK - 1n < toBlock
        ? chunkStart + LOG_BLOCK_CHUNK - 1n
        : toBlock;
    const chunk = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: merkleContract as `0x${string}`,
          fromBlock: toHex(chunkStart),
          toBlock: toHex(chunkEnd),
          topics: [CLAIMED_TOPIC, tokenTopic as `0x${string}`] as [
            `0x${string}`,
            `0x${string}`,
          ],
        },
      ],
    })) as RawClaimedLog[];
    logs.push(...chunk);
  }

  const amounts = new Map<string, bigint>();
  for (const log of logs) {
    const decoded = decodeClaimedLog(log);
    amounts.set(
      decoded.account,
      (amounts.get(decoded.account) ?? 0n) + decoded.amount,
    );
  }
  return { amounts, eventCount: logs.length, fromBlock };
}

export async function collectClaimAwareContext(
  period: number,
  merkle: MerkleEntry[],
  clientForChain: ClientForChain,
  requiredTokenKeys: ReadonlySet<string> = new Set(),
): Promise<ClaimAwareContext> {
  const previous = findPreviousMerkle(period);
  const currentByToken = new Map(merkle.map((entry) => [entryKey(entry), entry]));
  const tokens = new Map<string, ClaimedTokenWindow>();

  for (const previousEntry of previous.merkle) {
    const key = entryKey(previousEntry);
    const symbol =
      typeof previousEntry.symbol === "string" ? previousEntry.symbol : "unknown";
    const currentEntry = currentByToken.get(key);
    const previousAmounts = claimAmountsByAddress(previousEntry);
    const currentAmounts = claimAmountsByAddress(currentEntry);
    const rawDeficits = findClaimAwareContinuityViolations(
      previousAmounts,
      currentAmounts,
      new Map(),
    );

    let claimedSince = new Map<string, bigint>();
    let eventCount = 0;
    let fromBlock: bigint | undefined;
    if (rawDeficits.length > 0 || requiredTokenKeys.has(key)) {
      const chainId = resolveEntryChainId(currentEntry, previousEntry);
      const token = normalizeAddress(previousEntry.address, `${symbol} token`);
      const merkleContract = resolveEntryMerkleContract(
        currentEntry,
        previousEntry,
        chainId,
      );
      try {
        const claimed = await fetchClaimedSince(
          await clientForChain(chainId),
          chainId,
          merkleContract,
          token,
        );
        claimedSince = claimed.amounts;
        eventCount = claimed.eventCount;
        fromBlock = claimed.fromBlock;
      } catch (error) {
        throw new Error(
          `${symbol} claim lookup failed (chain=${chainId}, token=${token}, contract=${merkleContract}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    tokens.set(key, {
      previousAmounts,
      currentAmounts,
      claimedSince,
      eventCount,
      fromBlock,
    });
  }

  return {
    previousPeriod: previous.period,
    previousMerkle: previous.merkle,
    tokens,
  };
}

export async function checkV3(
  period: number,
  merkle: MerkleEntry[],
  clientForChain: ClientForChain,
  suppliedContext?: ClaimAwareContext,
): Promise<CheckResult> {
  const context = suppliedContext ?? await collectClaimAwareContext(
    period,
    merkle,
    clientForChain,
  );
  let holderCount = 0;
  let claimEventCount = 0;
  let claimCoveredCount = 0;

  for (const previousEntry of context.previousMerkle) {
    const symbol =
      typeof previousEntry.symbol === "string" ? previousEntry.symbol : "unknown";
    const tokenWindow = context.tokens.get(entryKey(previousEntry));
    if (!tokenWindow) throw new Error(`${symbol} has no shared claim window`);
    const { previousAmounts, currentAmounts, claimedSince } = tokenWindow;

    const violations = findClaimAwareContinuityViolations(
      previousAmounts,
      currentAmounts,
      claimedSince,
    );
    if (violations.length > 0) {
      const violation = violations[0];
      throw new Error(
        `${symbol} holder ${violation.holder} is under-covered ` +
          `(current=${violation.current}, claimedSince=${violation.claimedSince}, previous=${violation.previous})`,
      );
    }

    for (const [holder, previousAmount] of previousAmounts) {
      const currentAmount = currentAmounts.get(holder) ?? 0n;
      const claimedAmount = claimedSince.get(holder) ?? 0n;
      if (currentAmount < previousAmount && currentAmount + claimedAmount >= previousAmount) {
        claimCoveredCount++;
      }
      holderCount++;
    }
    claimEventCount += tokenWindow.eventCount;
  }

  return {
    id: "V3",
    name: "Continuity",
    ok: true,
    detail:
      `${holderCount} previous holders checked against period ${context.previousPeriod}; ` +
      `${claimCoveredCount} decreases/disappearances covered by ${claimEventCount} Claimed events`,
  };
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function displayToken(entry: MerkleEntry, address: string): string {
  return typeof entry.symbol === "string" ? `${entry.symbol} (${address})` : address;
}

async function checkV5(
  clientPromise: Promise<PublicClient>,
  merkle: MerkleEntry[],
  targets: EthereumTargets,
): Promise<CheckResult> {
  const client = await clientPromise;
  const entries = entriesByEthereumAddress(merkle);
  const details: string[] = [];

  for (const token of targets.tokens) {
    const entry = entries.get(token);
    if (!entry) throw new Error(`target token ${token} is absent from merkle.json`);
    const distributor = normalizeAddress(
      entry.merkleContract,
      `${token} merkleContract`,
    ) as `0x${string}`;
    const [distributorBalance, botmarketBalance] = await Promise.all([
      client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [distributor],
      }),
      client.readContract({
        address: token as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [BOTMARKETS[ETHEREUM_NETWORK] as `0x${string}`],
      }),
    ]);
    const treeTotal = toBigInt(entry.total, `${token} tree total`);
    const difference = absolute(distributorBalance + botmarketBalance - treeTotal);
    if (difference * 10_000n > treeTotal) {
      throw new Error(
        `${displayToken(entry, token)} difference=${formatUnits(difference, 18)} exceeds 0.01%`,
      );
    }
    details.push(
      `${typeof entry.symbol === "string" ? entry.symbol : token}: diff=${formatUnits(difference, 18)}`,
    );
  }

  return {
    id: "V5",
    name: "Funding two-way (pre-flip)",
    ok: true,
    detail: details.join("; "),
  };
}

function checkV6(
  log: LogData,
  merkle: MerkleEntry[],
  targets: EthereumTargets,
): CheckResult {
  if (
    !log.DistributionSurplus ||
    typeof log.DistributionSurplus !== "object" ||
    Array.isArray(log.DistributionSurplus)
  ) {
    throw new Error("log.DistributionSurplus is not an object");
  }
  const surplus = log.DistributionSurplus as Record<string, unknown>;
  const entries = entriesByEthereumAddress(merkle);
  const details: string[] = [];

  for (const token of targets.tokens) {
    const entry = entries.get(token);
    if (!entry || typeof entry.symbol !== "string") {
      throw new Error(`cannot resolve symbol for ${token}`);
    }
    const value = surplus[entry.symbol];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`DistributionSurplus.${entry.symbol} is not a number`);
    }
    if (value > 1) {
      throw new Error(`DistributionSurplus.${entry.symbol}=${value} exceeds 1.0`);
    }
    details.push(`${entry.symbol}=${value}`);
  }

  return {
    id: "V6",
    name: "Surplus",
    ok: true,
    detail: details.join("; "),
  };
}

async function checkV7(
  clientPromise: Promise<PublicClient>,
  log: LogData,
  merkle: MerkleEntry[],
  targets: EthereumTargets,
): Promise<CheckResult> {
  const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  if (log.period !== currentPeriod) {
    throw new Error(`log.period=${String(log.period)}; current week=${currentPeriod}`);
  }
  if (log.postFreeze !== true) {
    throw new Error(`log.postFreeze=${String(log.postFreeze)}; expected true`);
  }

  const client = await clientPromise;
  const entries = entriesByEthereumAddress(merkle);
  for (const token of targets.tokens) {
    const entry = entries.get(token);
    if (!entry) throw new Error(`target token ${token} is absent from merkle.json`);
    const onchainRoot = await client.readContract({
      address: normalizeAddress(
        entry.merkleContract,
        `${token} merkleContract`,
      ) as `0x${string}`,
      abi: MERKLE_ABI,
      functionName: "merkleRoot",
      args: [token as `0x${string}`],
    });
    if (onchainRoot.toLowerCase() !== ZERO_ROOT) {
      throw new Error(`${displayToken(entry, token)} is not frozen: ${onchainRoot}`);
    }
  }

  return {
    id: "V7",
    name: "Ordering",
    ok: true,
    detail: `${targets.tokens.length} roots frozen; period=${currentPeriod}; postFreeze=true`,
  };
}

function formatSet(values: Set<string>): string {
  return [...values].sort().join(",") || "(empty)";
}

export function nonzeroReportedSymbols(
  totalReported: Record<string, unknown>,
): string[] {
  const symbols: string[] = [];
  for (const [symbol, rawDelta] of Object.entries(totalReported)) {
    if (symbol.startsWith("RawToken_")) continue;
    if (typeof rawDelta !== "number" || !Number.isFinite(rawDelta)) {
      throw new Error(`TotalReported.${symbol} is not a number`);
    }
    if (rawDelta !== 0) symbols.push(symbol);
  }
  return symbols;
}

export function checkV8(
  log: LogData,
  merkle: MerkleEntry[],
  targets: EthereumTargets,
): CheckResult {
  if (
    !log.TotalReported ||
    typeof log.TotalReported !== "object" ||
    Array.isArray(log.TotalReported)
  ) {
    throw new Error("log.TotalReported is not an object");
  }
  const ethereumEntries = merkle.filter(
    (entry) => entry.chainId === ETHEREUM_CHAIN_ID,
  );
  const addressBySymbol = new Map<string, string>();
  for (const entry of ethereumEntries) {
    if (typeof entry.symbol !== "string") continue;
    const address = normalizeAddress(entry.address, `${entry.symbol} address`);
    const existing = addressBySymbol.get(entry.symbol);
    if (existing && existing !== address) {
      throw new Error(`multiple Ethereum addresses for symbol ${entry.symbol}`);
    }
    addressBySymbol.set(entry.symbol, address);
  }

  const expected = new Set<string>();
  for (const symbol of nonzeroReportedSymbols(
    log.TotalReported as Record<string, unknown>,
  )) {
    const token = addressBySymbol.get(symbol);
    if (!token) throw new Error(`nonzero TotalReported.${symbol} has no Ethereum merkle`);
    expected.add(token);
  }

  const actual = new Set(targets.tokens);
  const missing = [...expected].filter((token) => !actual.has(token));
  const extra = [...actual].filter((token) => !expected.has(token));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `scope differs; missing=${formatSet(new Set(missing))}; extra=${formatSet(new Set(extra))}`,
    );
  }

  return {
    id: "V8",
    name: "Scope",
    ok: true,
    detail: `${actual.size} tokens match nonzero TotalReported deltas`,
  };
}

export async function runCheck(
  id: CheckResult["id"],
  name: string,
  check: () => CheckResult | Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await check();
  } catch (error) {
    return {
      id,
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const log = parseJson<LogData>("log.json");
  const period = resolvePeriod(log);
  const merkle = loadMerkle(period);
  const targets = ethereumTargets(log);
  const clients = new Map<number, Promise<PublicClient>>();
  const clientForChain: ClientForChain = (chainId) => {
    let client = clients.get(chainId);
    if (!client) {
      client = getClient(chainId);
      clients.set(chainId, client);
    }
    return client;
  };
  const clientPromise = clientForChain(ETHEREUM_CHAIN_ID);

  console.log(`sdMerkle pre-set verification: period=${period}`);
  const results: CheckResult[] = [];
  results.push(await runCheck("V1", "Rebuild", () => checkV1(merkle, targets, log)));
  results.push(
    await runCheck("V3", "Continuity", () =>
      checkV3(period, merkle, clientForChain),
    ),
  );
  results.push(
    await runCheck("V5", "Funding two-way (pre-flip)", () =>
      checkV5(clientPromise, merkle, targets),
    ),
  );
  results.push(await runCheck("V6", "Surplus", () => checkV6(log, merkle, targets)));
  results.push(
    await runCheck("V7", "Ordering", () =>
      checkV7(clientPromise, log, merkle, targets),
    ),
  );
  results.push(await runCheck("V8", "Scope", () => checkV8(log, merkle, targets)));

  for (const result of results) {
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.id} ${result.name} — ${result.detail}`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `RESULT: ${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[FAIL] setup — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
