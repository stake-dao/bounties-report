import "dotenv/config";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { decodeEventLog, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { createMultiMerkle } from "../utils/merkle/createMultiMerkle";
import { getClient } from "../utils/getClients";
import { ALL_MIGHT_V2, BOTMARKETS, FXN_STAKE_DAO_LOCKER, LABELS_TO_SPACE, MERKLE_ADDRESS, SPACES_SYMBOL, SPACES_TOKENS, STAKE_DAO_LOCKER, WEEK } from "../utils/constants";

interface Transfer {
  chainId: number;
  transaction: `0x${string}`;
  logIndex: number;
  token: Address;
  from: Address;
  to: Address;
  amount: string;
}

interface HistoricalVote {
  source: number;
  epoch: number;
  gauge: Address;
  campaignId: string;
  claimLogIndex: number;
  sourceCommit: string;
  proposalId: string;
  proposalLogCommit: string;
}

export interface Recovery {
  id: string;
  reason: string;
  protocol: "curve" | "fxn";
  sources: Array<Transfer & { usedAmount: string }>;
  trail: Transfer[];
  allocation: { type: "historical-votes"; votes: HistoricalVote[] } | { type: "wallets"; amounts: Record<string, string> };
  funding: null | { period: number; transaction: `0x${string}`; logIndex: number; from: Address; amount: string };
}

interface RecoveryEvidence {
  input: Recovery;
  fundingBlock: string;
  fundingBlockHash: string;
  rewards: Record<string, string>;
}

interface RecoveryRun {
  schema: number;
  period: number;
  entries: RecoveryEvidence[];
}

const FILE = "data/sdtokens-recoveries.json";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const claimEvent = parseAbiItem("event Claim(uint256 indexed campaignId, address indexed account, uint256 amount, uint256 fee, uint256 epoch)");
const campaignAbi = parseAbi(["function getCampaign(uint256) view returns (uint256,address,address,address,uint8,uint256,uint256,uint256,uint256,uint256,address)"]);
const lc = (value: string) => value.toLowerCase();
const uint = (value: string) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid recovery amount");
  return BigInt(value);
};
const epoch = (value: number) => Number.isSafeInteger(value) && value > 0 && value % WEEK === 0;
const index = (value: number) => Number.isSafeInteger(value) && value >= 0;
const transferKey = (transfer: Pick<Transfer, "chainId" | "transaction" | "logIndex">) => `${transfer.chainId}/${transfer.transaction}/${transfer.logIndex}`;
const evidenceFile = (period: number) => `bounties-reports/${period}/sdtokens-recoveries.json`;
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function validateTransfer(transfer: Transfer): void {
  if (!Number.isSafeInteger(transfer.chainId) || transfer.chainId <= 0 || !HASH.test(transfer.transaction) || !index(transfer.logIndex) ||
      [transfer.token, transfer.from, transfer.to].some((address) => !ADDRESS.test(address)) || uint(transfer.amount) <= 0n) throw new Error("Invalid recovery transfer");
}

export function loadRecoveries(period?: number): Recovery[] {
  const data = existsSync(FILE) ? readJson(FILE) : { schema: 1, recoveries: [] };
  if (data.schema !== 1 || !Array.isArray(data.recoveries)) throw new Error("Invalid recovery ledger");
  const recoveries = data.recoveries as Recovery[];
  const ids = new Set<string>();
  const funding = new Set<string>();
  const claims = new Map<string, string>();
  const sources = new Map<string, { transfer: Transfer; used: bigint }>();
  for (const recovery of recoveries) {
    if (!/^[a-zA-Z0-9_-]+$/.test(recovery.id) || ids.has(recovery.id) || typeof recovery.reason !== "string" || !recovery.reason.trim() ||
        !["curve", "fxn"].includes(recovery.protocol) || !Array.isArray(recovery.sources) || !recovery.sources.length || !Array.isArray(recovery.trail)) throw new Error("Invalid or duplicate recovery");
    ids.add(recovery.id);
    const localSources = new Set<string>();
    for (const { usedAmount, ...transfer } of recovery.sources) {
      validateTransfer(transfer);
      const key = transferKey(transfer);
      if (localSources.has(key) || uint(usedAmount) <= 0n || uint(usedAmount) > uint(transfer.amount)) throw new Error(`${recovery.id}: invalid source usage`);
      localSources.add(key);
      const previous = sources.get(key);
      if (previous && !isDeepStrictEqual(previous.transfer, transfer)) throw new Error("Recovery source identity changed");
      const used = (previous?.used ?? 0n) + uint(usedAmount);
      if (used > uint(transfer.amount)) throw new Error("Recovery source credited more than once");
      sources.set(key, { transfer, used });
    }
    for (const transfer of recovery.trail) validateTransfer(transfer);
    const allocation = recovery.allocation;
    if (allocation?.type === "historical-votes") {
      const selected = new Set<number>();
      if (!Array.isArray(allocation.votes) || allocation.votes.length !== recovery.sources.length) throw new Error("Recovery votes do not cover every source");
      for (const vote of allocation.votes) {
        const source = recovery.sources[vote.source];
        if (!index(vote.source) || !source || selected.has(vote.source) || !epoch(vote.epoch) || !ADDRESS.test(vote.gauge) || !index(vote.claimLogIndex) ||
            !COMMIT.test(vote.sourceCommit) || !COMMIT.test(vote.proposalLogCommit) || !HASH.test(vote.proposalId) || source.chainId === 1 ||
            source.chainId !== recovery.sources[0].chainId || source.token !== recovery.sources[0].token) throw new Error("Invalid historical recovery allocation");
        uint(vote.campaignId);
        const claim = `${source.chainId}/${source.transaction}/${vote.claimLogIndex}`;
        if (claims.has(claim) && claims.get(claim) !== transferKey(source)) throw new Error("Recovery claim linked to another transfer");
        claims.set(claim, transferKey(source));
        selected.add(vote.source);
      }
    } else if (allocation?.type === "wallets") {
      if (!allocation.amounts || Array.isArray(allocation.amounts) || !Object.keys(allocation.amounts).length) throw new Error("Missing recovery wallet amounts");
      for (const [address, amount] of Object.entries(allocation.amounts)) {
        if (!ADDRESS.test(address) || /^0x0{40}$/.test(address) || uint(amount) <= 0n) throw new Error("Invalid recovery wallet amount");
      }
    } else throw new Error("Unsupported recovery allocation");
    const receipt = recovery.funding;
    if (receipt !== null) {
      if (!receipt || !epoch(receipt.period) || !HASH.test(receipt.transaction) || !index(receipt.logIndex) || !ADDRESS.test(receipt.from) || uint(receipt.amount) <= 0n ||
          [MERKLE_ADDRESS, BOTMARKETS.ethereum, ALL_MIGHT_V2].map(lc).includes(receipt.from)) throw new Error("Invalid direct recovery funding");
      const key = transferKey({ ...receipt, chainId: 1 });
      if (funding.has(key) || recoveries.some((r) => r !== recovery && r.funding?.transaction === receipt.transaction)) throw new Error("Recovery funding credited more than once");
      funding.add(key);
      if (allocation.type === "historical-votes" && allocation.votes.some((vote) => vote.epoch >= receipt.period)) throw new Error("Recovery must follow its historical epochs");
      if (allocation.type === "wallets" && Object.values(allocation.amounts).reduce((sum, amount) => sum + uint(amount), 0n) !== uint(receipt.amount)) throw new Error("Recovery wallet amounts do not equal funding");
    }
  }
  if (existsSync("bounties-reports")) for (const directory of readdirSync("bounties-reports")) {
    if (!/^[0-9]+$/.test(directory) || !existsSync(evidenceFile(Number(directory)))) continue;
    const archived = readJson(evidenceFile(Number(directory))) as RecoveryRun;
    if (archived.schema !== 1 || archived.period !== Number(directory) || !Array.isArray(archived.entries)) throw new Error("Invalid archived recovery evidence");
    const expected = recoveries.filter((recovery) => recovery.funding?.period === archived.period);
    if (expected.length !== archived.entries.length || expected.some((recovery) => !archived.entries.some((entry) => isDeepStrictEqual(entry.input, recovery)))) {
      throw new Error(`Recovery inputs changed after generation for ${directory}`);
    }
  }
  if (period !== undefined && recoveries.some((recovery) => recovery.funding && recovery.funding.period < period && !existsSync(evidenceFile(recovery.funding.period)))) {
    throw new Error("A funded recovery missed its target distribution");
  }
  return period === undefined ? recoveries : recoveries.filter((recovery) => recovery.funding?.period === period);
}

export function verifyRecoverySources(recovery: Recovery): void {
  if (recovery.allocation.type !== "historical-votes") return;
  const at = (commit: string, file: string) => JSON.parse(execFileSync("git", ["show", `${commit}:${file}`], { encoding: "utf8" }));
  for (const vote of recovery.allocation.votes) {
    const source = recovery.sources[vote.source];
    const file = `weekly-bounties/${vote.epoch}/votemarket-v2/claimed_bounties.json`;
    for (const data of [at(vote.sourceCommit, file), readJson(file)]) {
      const matches = Object.values(data[recovery.protocol]).filter((claim: any) => claim.chainId === source.chainId &&
        String(claim.bountyId) === vote.campaignId && lc(claim.gauge) === vote.gauge && lc(claim.rewardToken) === source.token &&
        claim.isWrapped === false) as Array<{ amount: string }>;
      if (matches.length !== 1 || matches[0].amount !== source.amount) throw new Error(`${recovery.id}: historical claim changed`);
    }
    const log = at(vote.proposalLogCommit, "log.json");
    const snapshots = log.SnapshotIds.filter((entry: any) => entry.space === LABELS_TO_SPACE[recovery.protocol]);
    if (log.period !== vote.epoch || log.postFreeze !== true || snapshots.length !== 1 || snapshots[0].ids.length !== 1 || snapshots[0].ids[0] !== vote.proposalId) throw new Error(`${recovery.id}: historical proposal changed`);
  }
}

export function splitRecoveryAmount(total: bigint, weights: Record<string, bigint>): Record<string, bigint> {
  const entries = Object.entries(weights).sort(([a], [b]) => a.localeCompare(b));
  const sum = entries.reduce((value, [, weight]) => value + weight, 0n);
  if (total < 0n || sum <= 0n || entries.some(([, weight]) => weight < 0n)) throw new Error("Invalid recovery weights");
  const amounts = Object.fromEntries(entries.map(([key, weight]) => [key, total * weight / sum]));
  let remainder = total - Object.values(amounts).reduce((value, amount) => value + amount, 0n);
  entries.sort(([a, wa], [b, wb]) => {
    const difference = total * wb % sum - total * wa % sum;
    return difference > 0n ? 1 : difference < 0n ? -1 : a.localeCompare(b);
  });
  for (const [key] of entries) {
    if (remainder-- <= 0n) break;
    amounts[key] += 1n;
  }
  return amounts;
}

export async function allocateRecovery(recovery: Recovery, total: bigint): Promise<Record<string, bigint>> {
  if (recovery.allocation.type === "wallets") {
    const amounts = Object.fromEntries(Object.entries(recovery.allocation.amounts).sort(([a], [b]) => a.localeCompare(b)).map(([address, amount]) => [address, uint(amount)]));
    if (Object.values(amounts).reduce((sum, amount) => sum + amount, 0n) !== total) throw new Error("Recovery wallet amounts do not equal funding");
    return amounts;
  }
  const votes = recovery.allocation.votes;
  const portions = splitRecoveryAmount(total, Object.fromEntries(votes.map((vote) => [transferKey(recovery.sources[vote.source]), uint(recovery.sources[vote.source].usedAmount)])));
  const groups = new Map<string, { vote: HistoricalVote; amount: bigint }>();
  for (const vote of votes) {
    const key = `${vote.proposalId}/${vote.gauge}`;
    groups.set(key, { vote, amount: (groups.get(key)?.amount ?? 0n) + portions[transferKey(recovery.sources[vote.source])] });
  }
  const rewards: Record<string, bigint> = {};
  for (const [, { vote, amount }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const result = await createMultiMerkle([vote.proposalId], LABELS_TO_SPACE[recovery.protocol], [], { [vote.gauge]: 1_000_000 },
      { total_vp: 1 }, { total_vp: 1 }, {}, undefined, { readOnlyClaimCache: true });
    const weights = Object.fromEntries(Object.entries(result.merkle.merkle).map(([address, leaf]: [string, any]) => [lc(address), BigInt(leaf.amount.toString())]));
    const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0n);
    if (weightTotal < 10n ** 24n - 10n ** 12n || weightTotal > 10n ** 24n + 10n ** 12n) throw new Error("Historical recovery did not conserve rewards");
    for (const [address, value] of Object.entries(splitRecoveryAmount(amount, weights))) if (value > 0n) rewards[address] = (rewards[address] ?? 0n) + value;
  }
  return Object.fromEntries(Object.entries(rewards).sort(([a], [b]) => a.localeCompare(b)));
}

export async function verifyRecoveryFunding(recovery: Recovery, mainnet?: PublicClient) {
  verifyRecoverySources(recovery);
  const clients = new Map<number, PublicClient>();
  if (mainnet) clients.set(1, mainnet);
  const receipts = new Map<string, Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>>();
  const verifyTransfer = async (transfer: Transfer) => {
    if (!clients.has(transfer.chainId)) clients.set(transfer.chainId, await getClient(transfer.chainId));
    const client = clients.get(transfer.chainId)!;
    const key = `${transfer.chainId}/${transfer.transaction}`;
    if (!receipts.has(key)) receipts.set(key, await client.getTransactionReceipt({ hash: transfer.transaction }));
    const receipt = receipts.get(key)!;
    const log = receipt.logs.find((entry) => entry.logIndex === transfer.logIndex);
    if (receipt.status !== "success" || !log || lc(log.address) !== transfer.token || log.topics[0] !== TRANSFER ||
        lc(`0x${log.topics[1]?.slice(-40)}`) !== transfer.from || lc(`0x${log.topics[2]?.slice(-40)}`) !== transfer.to || BigInt(log.data) !== uint(transfer.amount)) throw new Error(`${recovery.id}: transfer receipt mismatch ${transferKey(transfer)}`);
    return receipt;
  };
  for (const transfer of [...recovery.sources, ...recovery.trail]) await verifyTransfer(transfer);
  if (recovery.allocation.type === "historical-votes") for (const vote of recovery.allocation.votes) {
    const source = recovery.sources[vote.source];
    const receipt = receipts.get(`${source.chainId}/${source.transaction}`)!;
    const event = receipt.logs.find((log) => log.logIndex === vote.claimLogIndex && lc(log.address) === source.from);
    if (!event) throw new Error("Recovery claim event missing");
    const claim = decodeEventLog({ abi: [claimEvent], ...event }).args;
    const campaign = await clients.get(source.chainId)!.readContract({ address: source.from, abi: campaignAbi, functionName: "getCampaign", args: [uint(vote.campaignId)] });
    const locker = recovery.protocol === "curve" ? STAKE_DAO_LOCKER : FXN_STAKE_DAO_LOCKER;
    if (claim.campaignId !== uint(vote.campaignId) || claim.epoch !== BigInt(vote.epoch) || claim.amount !== uint(source.amount) || lc(claim.account) !== lc(locker) ||
        lc(campaign[1]) !== vote.gauge || lc(campaign[3]) !== source.token) throw new Error("Recovery claim/campaign mismatch");
  }
  const funding = recovery.funding;
  if (!funding) return undefined;
  const token = lc(SPACES_TOKENS[LABELS_TO_SPACE[recovery.protocol]]) as Address;
  const receipt = await verifyTransfer({ ...funding, chainId: 1, token, to: lc(MERKLE_ADDRESS) as Address });
  const client = clients.get(1)!;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash || await client.getBlockNumber() < receipt.blockNumber + 12n || Number(block.timestamp) >= funding.period + WEEK) throw new Error("Recovery funding is unconfirmed or outside its target period");
  for (const transfer of [...recovery.sources, ...recovery.trail]) {
    if (transfer.chainId === 1 && receipts.get(`1/${transfer.transaction}`)!.blockNumber >= receipt.blockNumber) throw new Error("Recovery funding precedes its source evidence");
  }
  const movements = receipt.logs.filter((log) => lc(log.address) === token && log.topics[0] === TRANSFER &&
    [log.topics[1], log.topics[2]].some((topic) => lc(`0x${topic?.slice(-40)}`) === lc(MERKLE_ADDRESS)));
  if (movements.length !== 1) throw new Error("Recovery funding must be an isolated distributor transfer");
  return { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, timestamp: Number(block.timestamp) };
}

export function recoveryTotals(period: number): Record<string, bigint> {
  const totals: Record<string, bigint> = {};
  for (const recovery of loadRecoveries(period).filter((entry) => entry.funding?.period === period)) {
    const symbol = SPACES_SYMBOL[LABELS_TO_SPACE[recovery.protocol]];
    totals[symbol] = (totals[symbol] ?? 0n) + uint(recovery.funding!.amount);
  }
  return totals;
}

export function validateRecoveryLog(log: { period?: unknown; PrefundedRewards?: unknown; Recoveries?: unknown }): void {
  const period = Number(log.period);
  const totals = Object.fromEntries(Object.entries(recoveryTotals(period)).map(([symbol, amount]) => [symbol, amount.toString()]));
  if (!isDeepStrictEqual(log.PrefundedRewards ?? {}, totals)) throw new Error("Prefunded recovery log does not match the ledger");
  const entries: RecoveryEvidence[] = existsSync(evidenceFile(period)) ? readJson(evidenceFile(period)).entries : [];
  if (Object.keys(totals).length && !entries.length) throw new Error("Recovery allocation evidence missing");
  const expected = recoverySummary({ schema: 1, period, entries });
  if (!isDeepStrictEqual(log.Recoveries ?? [], expected)) throw new Error("Recovery summary does not match allocation evidence");
}

export function recoverySummary(run: RecoveryRun) {
  return run.entries.map((entry) => ({ id: entry.input.id, protocol: entry.input.protocol, allocation: entry.input.allocation.type,
    amount: entry.input.funding!.amount, fundingTransaction: entry.input.funding!.transaction, recipients: Object.keys(entry.rewards).length,
    sourceEpochs: entry.input.allocation.type === "historical-votes" ? [...new Set(entry.input.allocation.votes.map((vote) => vote.epoch))].sort((a, b) => a - b) : [] }));
}

export async function buildRecoveries(period: number): Promise<RecoveryRun> {
  const entries: RecoveryEvidence[] = [];
  for (const recovery of loadRecoveries(period)) {
    const funding = await verifyRecoveryFunding(recovery);
    if (!funding) throw new Error("Recovery funding missing");
    const rewards = await allocateRecovery(recovery, uint(recovery.funding!.amount));
    entries.push({ input: recovery, fundingBlock: funding.blockNumber, fundingBlockHash: funding.blockHash, rewards: Object.fromEntries(Object.entries(rewards).map(([address, amount]) => [address, amount.toString()])) });
  }
  entries.sort((a, b) => a.input.id.localeCompare(b.input.id));
  const run = { schema: 1, period, entries };
  if (existsSync(evidenceFile(period)) && !isDeepStrictEqual(readJson(evidenceFile(period)), run)) throw new Error("Recovery allocations changed after generation");
  if (entries.length && !existsSync(evidenceFile(period))) {
    const distribution = `bounties-reports/${period}/sdtokens-distribution.json`;
    if (existsSync(distribution) && readJson(distribution).verified === true) throw new Error("Cannot add recovery to an already verified distribution");
  }
  return run;
}

export function recoveryRewards(run: RecoveryRun, space: string): Record<string, bigint> {
  const rewards: Record<string, bigint> = {};
  for (const entry of run.entries) if (LABELS_TO_SPACE[entry.input.protocol] === space) {
    for (const [address, amount] of Object.entries(entry.rewards)) rewards[address] = (rewards[address] ?? 0n) + uint(amount);
  }
  return rewards;
}

export function writeRecoveryEvidence(run: RecoveryRun): void {
  writeFileSync(evidenceFile(run.period), JSON.stringify(run, null, 2) + "\n");
  for (const summary of recoverySummary(run)) console.log(JSON.stringify({ event: "merkle_recovery_applied", period: run.period, ...summary }));
  for (const recovery of loadRecoveries().filter((entry) => !entry.funding)) console.log(JSON.stringify({ event: "merkle_recovery_pending", id: recovery.id }));
}

async function main(): Promise<void> {
  const [command, id, amount, output] = process.argv.slice(2);
  const recovery = loadRecoveries().find((entry) => entry.id === id);
  if (command !== "--preview" || !recovery || !output || uint(amount) <= 0n) throw new Error("Usage: recoveries.ts --preview <id> <amount-wei> <output.json>");
  await verifyRecoveryFunding(recovery);
  const rewards = await allocateRecovery(recovery, uint(amount));
  writeFileSync(output, JSON.stringify({ status: "preview only; not a distribution", id, amount, rewards }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  console.log(JSON.stringify({ event: "merkle_recovery_preview", id, amount, recipients: Object.keys(rewards).length, output }));
}

if (require.main === module) main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
