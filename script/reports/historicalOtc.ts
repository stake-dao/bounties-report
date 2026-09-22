import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { decodeEventLog, erc20Abi, formatUnits, parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { createMultiMerkle } from "../utils/merkle/createMultiMerkle";
import { getClient } from "../utils/getClients";
import { ALL_MIGHT_V2, BOTMARKET, OTC_REGISTRY, PROTOCOLS_TOKENS } from "../utils/reportUtils";
import { STAKE_DAO_LOCKER, WETH_CHAIN_IDS, WEEK } from "../utils/constants";

interface Recovery {
  id: string;
  sourceCommit: string;
  gauge: Address;
  sourceChainId: number;
  sourceToken: Address;
  sourcePlatform: Address;
  sourceRecipient: Address;
  depositor: Address;
  withdrawalTransaction: `0x${string}`;
  bridgeOriginTransaction: `0x${string}`;
  bridgeDestinationTransaction: `0x${string}`;
  bridgedSourceAmount: string;
  remainingSourceAmount: string;
  wethAmount: string;
  sources: Array<{
    epoch: number;
    campaignId: string;
    amount: string;
    transaction: `0x${string}`;
    claimLogIndex: number;
    transferLogIndex: number;
    proposalId: string;
    proposalLogCommit: string;
  }>;
  settlement: null | {
    period: number;
    otcId: string;
    depositTransaction: `0x${string}`;
    fillTransaction: `0x${string}`;
    sdAmount: string;
  };
}

const FILE = "data/eng-2178-recovery.json";
const lc = (value: string) => value.toLowerCase();
const uint = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid recovery amount");
  return BigInt(value);
};
const claimEvent = parseAbiItem("event Claim(uint256 indexed campaignId, address indexed account, uint256 amount, uint256 fee, uint256 epoch)");
const withdrawnEvent = parseAbiItem("event OTCWithdrawn(uint256 id, address withdrawer, uint256 amount)");
const depositedEvent = parseAbiItem("event OTCDeposited(uint256 id, (address depositor, string protocolName, address rewardToken, address gauge, uint256 chainId, uint256 amount, uint256 startTimestamp, uint256 totalPeriods, uint256 withdrawPerPeriod) otc)");
const otcAbi = parseAbi(["function otcs(uint256) view returns (address,string,address,address,uint256,uint256,uint256,uint256,uint256)"]);
const campaignAbi = parseAbi(["function getCampaign(uint256) view returns (uint256,address,address,address,uint8,uint256,uint256,uint256,uint256,uint256,address)"]);

export function loadHistoricalRecovery(period?: number): Recovery | undefined {
  if (!existsSync(FILE)) return undefined;
  const recovery = JSON.parse(readFileSync(FILE, "utf8")) as Recovery;
  if (recovery.id !== "ENG-2178" || recovery.sourceChainId !== 42161 || recovery.sources.length !== 3 ||
      !/^[0-9a-f]{40}$/.test(recovery.sourceCommit) ||
      [recovery.gauge, recovery.sourceToken, recovery.sourcePlatform, recovery.sourceRecipient, recovery.depositor].some((a) => !/^0x[0-9a-f]{40}$/.test(a)) ||
      [recovery.withdrawalTransaction, recovery.bridgeOriginTransaction, recovery.bridgeDestinationTransaction].some((h) => !/^0x[0-9a-f]{64}$/.test(h))) throw new Error("Invalid ENG-2178 recovery");
  const keys = new Set<string>();
  const epochs = new Set<number>();
  let total = 0n;
  for (const source of recovery.sources) {
    const key = `${source.transaction}/${source.claimLogIndex}`;
    if (keys.has(key) || epochs.has(source.epoch) || !Number.isSafeInteger(source.epoch) || source.epoch <= 0 || source.epoch % WEEK ||
        !Number.isSafeInteger(source.claimLogIndex) || source.claimLogIndex < 0 || !Number.isSafeInteger(source.transferLogIndex) || source.transferLogIndex < 0 ||
        !/^0x[0-9a-f]{64}$/.test(source.transaction) || !/^0x[0-9a-f]{64}$/.test(source.proposalId) ||
        !/^[0-9a-f]{40}$/.test(source.proposalLogCommit) || uint(source.amount) <= 0n) throw new Error("Invalid or duplicate recovery source");
    keys.add(key);
    epochs.add(source.epoch);
    total += uint(source.amount);
  }
  if (uint(recovery.bridgedSourceAmount) <= 0n || uint(recovery.wethAmount) <= 0n ||
      total !== uint(recovery.bridgedSourceAmount) + uint(recovery.remainingSourceAmount)) throw new Error("Recovery source balance does not reconcile");
  const settlement = recovery.settlement;
  if (settlement !== null && (!settlement || !Number.isSafeInteger(settlement.period) || settlement.period % WEEK ||
      recovery.sources.some((s) => s.epoch >= settlement.period) || uint(settlement.sdAmount) <= 0n ||
      !/^0x[0-9a-f]{64}$/.test(settlement.depositTransaction) || !/^0x[0-9a-f]{64}$/.test(settlement.fillTransaction))) throw new Error("Invalid recovery settlement");
  if (settlement) uint(settlement.otcId);
  return period === undefined || settlement?.period === period ? recovery : undefined;
}

export function verifyHistoricalSources(recovery: Recovery): void {
  const at = (commit: string, file: string) => JSON.parse(execFileSync("git", ["show", `${commit}:${file}`], { encoding: "utf8" }));
  for (const source of recovery.sources) {
    const file = `weekly-bounties/${source.epoch}/votemarket-v2/claimed_bounties.json`;
    for (const data of [at(recovery.sourceCommit, file), JSON.parse(readFileSync(file, "utf8"))]) {
      const matches = Object.values(data.curve).filter((c: any) => c.chainId === recovery.sourceChainId &&
        String(c.bountyId) === source.campaignId && lc(c.gauge) === recovery.gauge &&
        lc(c.rewardToken) === recovery.sourceToken && c.isWrapped === false) as Array<{ amount: string }>;
      if (matches.length !== 1 || matches[0].amount !== source.amount) throw new Error(`Recovery claim changed: ${file}`);
    }
    const log = at(source.proposalLogCommit, "log.json");
    const snapshots = log.SnapshotIds.filter((s: any) => s.space === "sdcrv.eth");
    if (log.period !== source.epoch || log.postFreeze !== true || snapshots.length !== 1 ||
        snapshots[0].ids.length !== 1 || snapshots[0].ids[0] !== source.proposalId) throw new Error("Historical Snapshot proposal mismatch");
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

export function recoveryFillTransactions(protocol: string, period: number): string[] {
  const recovery = protocol === "curve" ? loadHistoricalRecovery(period) : undefined;
  return recovery?.settlement ? [recovery.settlement.fillTransaction] : [];
}

export function excludeHistoricalOtc(id: bigint, otc: readonly unknown[], transaction: string): boolean {
  const recovery = loadHistoricalRecovery();
  if (!recovery) return false;
  const matches = lc(String(otc[0])) === recovery.depositor && lc(String(otc[3])) === recovery.gauge;
  if (!matches && id.toString() !== recovery.settlement?.otcId) return false;
  if (!matches || otc[1] !== "Curve" || lc(String(otc[2])) !== lc(WETH_CHAIN_IDS[1]) ||
      BigInt(String(otc[4])) !== 1n || BigInt(String(otc[5])) !== uint(recovery.wethAmount) || BigInt(String(otc[7])) !== 1n ||
      !recovery.settlement || recovery.settlement.otcId !== id.toString() || recovery.settlement.fillTransaction !== lc(transaction)) {
    throw new Error("ENG-2178 OTC recovery is not settled; ordinary weekly reporting is forbidden");
  }
  return true;
}

export async function historicalRecoveryRewards(period: number): Promise<Record<string, bigint>> {
  const recovery = loadHistoricalRecovery(period);
  if (!recovery?.settlement) return {};
  verifyHistoricalSources(recovery);
  return allocateHistoricalRecovery(recovery, uint(recovery.settlement.sdAmount));
}

async function allocateHistoricalRecovery(recovery: Recovery, total: bigint): Promise<Record<string, bigint>> {
  const epochs = splitRecoveryAmount(total, Object.fromEntries(recovery.sources.map((s) => [String(s.epoch), uint(s.amount)])));
  const proposalAmounts: Record<string, bigint> = {};
  for (const source of recovery.sources) proposalAmounts[source.proposalId] = (proposalAmounts[source.proposalId] ?? 0n) + epochs[source.epoch];
  const rewards: Record<string, bigint> = {};
  for (const [proposal, amount] of Object.entries(proposalAmounts)) {
    const result = await createMultiMerkle([proposal], "sdcrv.eth", [], { [recovery.gauge]: 1_000_000 },
      { total_vp: 1 }, { total_vp: 1 }, {}, undefined, { readOnlyClaimCache: true });
    const weights = Object.fromEntries(Object.entries(result.merkle.merkle).map(([address, leaf]: [string, any]) =>
      [lc(address), BigInt(leaf.amount.toString())]));
    const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0n);
    if (weightTotal < 10n ** 24n - 10n ** 12n || weightTotal > 10n ** 24n + 10n ** 12n) throw new Error("Historical beneficiary reconstruction did not conserve rewards");
    for (const [address, value] of Object.entries(splitRecoveryAmount(amount, weights))) {
      if (value > 0n) rewards[address] = (rewards[address] ?? 0n) + value;
    }
  }
  return rewards;
}

export async function verifyHistoricalSettlement(period: number | undefined, client: PublicClient): Promise<void> {
  const recovery = loadHistoricalRecovery(period);
  if (!recovery) return;
  verifyHistoricalSources(recovery);
  const sourceClient = await getClient(recovery.sourceChainId);
  const receipt = async (reader: PublicClient, hash: `0x${string}`) => {
    const result = await reader.getTransactionReceipt({ hash });
    if (result.status !== "success") throw new Error(`Recovery transaction failed: ${hash}`);
    return result;
  };
  const transfers = (logs: Awaited<ReturnType<typeof receipt>>["logs"], token: string, from: string, to: string) => logs.reduce((sum, log) => {
    if (lc(log.address) !== lc(token) || log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") return sum;
    return lc(`0x${log.topics[1]?.slice(-40)}`) === lc(from) && lc(`0x${log.topics[2]?.slice(-40)}`) === lc(to) ? sum + BigInt(log.data) : sum;
  }, 0n);
  for (const source of recovery.sources) {
    const result = await receipt(sourceClient, source.transaction);
    const event = result.logs.find((l) => l.logIndex === source.claimLogIndex && lc(l.address) === recovery.sourcePlatform);
    if (!event) throw new Error("Recovery claim event missing");
    const claim = decodeEventLog({ abi: [claimEvent], ...event }).args;
    const campaign = await sourceClient.readContract({ address: recovery.sourcePlatform, abi: campaignAbi, functionName: "getCampaign", args: [uint(source.campaignId)] });
    if (claim.campaignId !== uint(source.campaignId) || claim.epoch !== BigInt(source.epoch) || claim.amount !== uint(source.amount) ||
        lc(claim.account) !== lc(STAKE_DAO_LOCKER) || lc(campaign[1]) !== recovery.gauge || lc(campaign[3]) !== recovery.sourceToken ||
        transfers(result.logs.filter((l) => l.logIndex === source.transferLogIndex), recovery.sourceToken, recovery.sourcePlatform, recovery.sourceRecipient) !== uint(source.amount)) throw new Error("Recovery source receipt mismatch");
  }
  const withdrawal = await receipt(sourceClient, recovery.withdrawalTransaction);
  const origin = await receipt(sourceClient, recovery.bridgeOriginTransaction);
  const delivery = await receipt(client, recovery.bridgeDestinationTransaction);
  if (origin.blockNumber <= withdrawal.blockNumber || transfers(withdrawal.logs, recovery.sourceToken, recovery.sourceRecipient, recovery.depositor) !== uint(recovery.bridgedSourceAmount) + uint(recovery.remainingSourceAmount) ||
      transfers(origin.logs, recovery.sourceToken, recovery.depositor, "0x4cd00e387622c35bddb9b4c962c136462338bc31") !== uint(recovery.bridgedSourceAmount) ||
      transfers(delivery.logs, WETH_CHAIN_IDS[1], "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", recovery.depositor) !== uint(recovery.wethAmount)) throw new Error("Recovery withdrawal/bridge mismatch");
  const settlement = recovery.settlement;
  if (!settlement) return;
  period = settlement.period;
  const deposit = await receipt(client, settlement.depositTransaction);
  const fill = await receipt(client, settlement.fillTransaction);
  const deposits = deposit.logs.filter((l) => lc(l.address) === lc(OTC_REGISTRY)).flatMap((log) => {
    try { return [decodeEventLog({ abi: [depositedEvent], ...log }).args]; } catch { return []; }
  });
  if (deposits.length !== 1 || deposits[0].id !== uint(settlement.otcId) || lc(deposit.from) !== recovery.depositor ||
      lc(deposit.to ?? "") !== lc(OTC_REGISTRY)) throw new Error("Recovery deposit event/sender mismatch");
  const block = await client.getBlock({ blockNumber: fill.blockNumber });
  if (Number(block.timestamp) < period || Number(block.timestamp) >= period + WEEK || deposit.blockNumber >= fill.blockNumber || deposit.blockNumber <= delivery.blockNumber ||
      await client.getBlockNumber() < fill.blockNumber + 12n) throw new Error("Recovery settlement period/order/confirmation mismatch");
  const otc = await client.readContract({ address: OTC_REGISTRY as Address, abi: otcAbi, functionName: "otcs", args: [uint(settlement.otcId)], blockNumber: deposit.blockNumber });
  if (!excludeHistoricalOtc(uint(settlement.otcId), otc, settlement.fillTransaction) ||
      transfers(deposit.logs, WETH_CHAIN_IDS[1], recovery.depositor, OTC_REGISTRY) !== uint(recovery.wethAmount)) throw new Error("Recovery OTC deposit mismatch");
  const withdrawals = fill.logs.filter((l) => lc(l.address) === lc(OTC_REGISTRY)).flatMap((log) => {
    try { return [decodeEventLog({ abi: [withdrawnEvent], ...log }).args]; } catch { return []; }
  });
  if (withdrawals.length !== 1 || withdrawals[0].id !== uint(settlement.otcId) || lc(withdrawals[0].withdrawer) !== lc(ALL_MIGHT_V2) ||
      withdrawals[0].amount !== uint(recovery.wethAmount) || transfers(fill.logs, WETH_CHAIN_IDS[1], OTC_REGISTRY, ALL_MIGHT_V2) !== uint(recovery.wethAmount) ||
      transfers(fill.logs, PROTOCOLS_TOKENS.curve.sdToken, ALL_MIGHT_V2, BOTMARKET) !== uint(settlement.sdAmount)) throw new Error("Recovery requires an isolated OTC fill with exact proceeds");
  const incoming: Record<string, bigint> = {};
  const outgoing: Record<string, bigint> = {};
  const tokens = [WETH_CHAIN_IDS[1], PROTOCOLS_TOKENS.curve.native, PROTOCOLS_TOKENS.curve.sdToken].map(lc);
  for (const log of fill.logs) {
    if (log.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
    const token = lc(log.address);
    if (lc(`0x${log.topics[1]?.slice(-40)}`) === lc(ALL_MIGHT_V2)) {
      if (!tokens.includes(token)) throw new Error("Recovery fill spends another token");
      outgoing[token] = (outgoing[token] ?? 0n) + BigInt(log.data);
    }
    if (lc(`0x${log.topics[2]?.slice(-40)}`) === lc(ALL_MIGHT_V2)) incoming[token] = (incoming[token] ?? 0n) + BigInt(log.data);
  }
  const nativeBalances = await Promise.all([fill.blockNumber - 1n, fill.blockNumber].map((blockNumber) =>
    client.getBalance({ address: ALL_MIGHT_V2 as Address, blockNumber })));
  if (incoming[tokens[0]] !== uint(recovery.wethAmount) || (outgoing[tokens[0]] ?? 0n) !== uint(recovery.wethAmount) ||
      (outgoing[tokens[1]] ?? 0n) > (incoming[tokens[1]] ?? 0n) || incoming[tokens[2]] !== uint(settlement.sdAmount) ||
      outgoing[tokens[2]] !== uint(settlement.sdAmount) || nativeBalances[0] !== nativeBalances[1]) throw new Error("Recovery fill mixes other assets or proceeds");
  for (const token of [PROTOCOLS_TOKENS.curve.sdToken, PROTOCOLS_TOKENS.curve.native]) {
    const before = await client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [ALL_MIGHT_V2 as Address], blockNumber: fill.blockNumber - 1n });
    if (before !== 0n) throw new Error("Recovery fill would mix pre-existing CRV/sdCRV balances");
  }
}

async function main(): Promise<void> {
  const recovery = loadHistoricalRecovery();
  if (!recovery || process.argv[2] !== "--preview" || !process.argv[3]) throw new Error("Usage: historicalOtc.ts --preview <output.json>");
  verifyHistoricalSources(recovery);
  await verifyHistoricalSettlement(undefined, await getClient(1));
  const weights = Object.fromEntries(recovery.sources.map((s) => [String(s.epoch), uint(s.amount)]));
  const preview = {
    id: recovery.id, status: "preview only; not a distribution", unit: "share of bridged WETH; final sdCRV requires a verified isolated fill",
    sourceUsdc: formatUnits(uint(recovery.bridgedSourceAmount), 6), remainingUsdc: formatUnits(uint(recovery.remainingSourceAmount), 6),
    epochs: splitRecoveryAmount(uint(recovery.wethAmount), weights),
    beneficiaries: await allocateHistoricalRecovery(recovery, uint(recovery.wethAmount)),
  };
  writeFileSync(process.argv[3], JSON.stringify(preview, (_, value) => typeof value === "bigint" ? value.toString() : value, 2) + "\n");
  console.log(`ENG-2178: ${Object.keys(preview.beneficiaries).length} historical beneficiaries; preview written to ${process.argv[3]}`);
}

if (require.main === module) main().catch((error) => { console.error(error.shortMessage || error.message); process.exitCode = 1; });
