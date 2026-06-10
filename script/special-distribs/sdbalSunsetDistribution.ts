/**
 * sdBAL Sunset USDC Distribution (BIP-920 pass-through).
 *
 * Pipeline (CLI flag --phase selects):
 *   1  snapshot   : sdBAL holder balances at Balancer's BIP-920 snapshot block
 *   2  classify   : split EOA vs contract
 *   3  expand     : recurse contract holders (LP, gauge, vest, Safe)
 *   4  payouts    : compute pro-rata USDC amounts
 *   5  merge      : add USDC entries to data/extra_merkle/merkle.json, regen tree
 *   6  bundle     : Gnosis Safe tx bundles (submitRoot + acceptRoot)
 *   7  verify     : verification gate (alias: --phase verify)
 *   all           : run 1->7 sequentially with pre/post-merge gates
 *                   (halts if Phase 3 finds unknown contracts)
 *
 * Snapshot block 25035662 is fixed (BIP-920 vote start, May 8 2026 18:00 UTC).
 * USDC_RECEIVED is a placeholder until Balancer's airdrop tx lands at the locker.
 *
 *   pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 1
 *   pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 5 --usdc 12345670000
 */

import fs from "node:fs";
import path from "node:path";
import {
  Address,
  Hex,
  PublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";

import { SD_BAL, ETH_CHAIN_ID } from "../utils/constants";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { getClient } from "../utils/getClients";

// ---------------------------------------------------------------------------
// Constants (BIP-920 anchors)
// ---------------------------------------------------------------------------

const SNAPSHOT_BLOCK = 25035662; // Balancer BIP-920 snapshot block (May 8 2026 18:00 UTC)
const ETH_CHAIN_ID_NUM = Number(ETH_CHAIN_ID);
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

const ROOT_DIR = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "sdbal-sunset");
const EXTRA_MERKLE = path.join(ROOT_DIR, "data", "extra_merkle", "merkle.json");
const EXTRA_SUMMARY = path.join(ROOT_DIR, "data", "extra_merkle", "summary.json");
const EXTRA_REPART = path.join(ROOT_DIR, "data", "extra_merkle", "repartition.json");

// Recursion depth limit for contract expansion (LP -> gauge -> compounder typically <= 3).
const MAX_DEPTH = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BalanceMap {
  [address: string]: string; // bigint as decimal string
}

interface ClassifiedHolders {
  block: number;
  totalSupply: string;
  eoa: BalanceMap;
  contracts: BalanceMap;
}

interface ExpansionEntry {
  source: string; // contract addr that was expanded
  reason: string; // route taken ("curve-lp" / "stakedao-gauge" / "hedgey" / "safe" / ...)
  beneficiaries: BalanceMap;
}

interface ExpansionReport {
  block: number;
  totalSupply: string;
  expanded: ExpansionEntry[];
  finalBalances: BalanceMap;
  unknownContracts: string[]; // halt list
}

interface Payouts {
  block: number;
  usdcReceived: string;
  perAddress: { [address: string]: string };
  dustReassignedTo: string;
}

interface MerkleClaim {
  tokens: { [token: string]: { amount: string; proof: string[] } };
}
interface MerkleData {
  merkleRoot: string;
  claims: { [address: string]: MerkleClaim };
}
interface UniversalMerkle {
  [address: string]: { [token: string]: string };
}

// ---------------------------------------------------------------------------
// Phase 1 — Snapshot sdBAL holders @ block
// ---------------------------------------------------------------------------

async function phase1Snapshot(): Promise<BalanceMap> {
  ensureOut();
  const explorer = createBlockchainExplorerUtils();
  const client = await getClient(ETH_CHAIN_ID_NUM);

  console.log(`Phase 1 — snapshot sdBAL holders @ block ${SNAPSHOT_BLOCK}`);

  // sdBAL creation block: unknown, scan from 0 with 10k chunk pagination
  // (getLogsByAddressesAndTopics handles chunking).
  const logs = await explorer.getLogsByAddressesAndTopics(
    [SD_BAL],
    0,
    SNAPSHOT_BLOCK,
    { "0": TRANSFER_TOPIC },
    ETH_CHAIN_ID_NUM,
  );
  console.log(`  fetched ${logs.result.length} Transfer events`);

  const bal = new Map<string, bigint>();
  for (const log of logs.result) {
    const from = getAddress(`0x${log.topics[1].slice(26)}`);
    const to = getAddress(`0x${log.topics[2].slice(26)}`);
    const amount = BigInt(log.data);
    if (from !== ZERO_ADDR) bal.set(from, (bal.get(from) ?? 0n) - amount);
    bal.set(to, (bal.get(to) ?? 0n) + amount);
  }

  for (const [addr, b] of bal) {
    if (b < 0n) {
      throw new Error(`Negative balance ${addr}: ${b.toString()} — log decoding bug`);
    }
  }

  const totalSupply = await client.readContract({
    address: SD_BAL,
    abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "totalSupply",
    blockNumber: BigInt(SNAPSHOT_BLOCK),
  }) as bigint;

  const balances: BalanceMap = {};
  let sum = 0n;
  for (const [addr, b] of bal) {
    if (b === 0n) continue;
    if (addr === ZERO_ADDR) continue;
    if (addr === getAddress(SD_BAL)) continue; // contract self-balance never expected
    balances[addr] = b.toString();
    sum += b;
  }

  console.log(`  holders with positive balance: ${Object.keys(balances).length}`);
  console.log(`  Σ balances : ${sum.toString()}`);
  console.log(`  totalSupply: ${totalSupply.toString()}`);
  if (sum !== totalSupply) {
    throw new Error(`Σ holder balances (${sum}) != totalSupply (${totalSupply}) — invariant break`);
  }

  writeJson(path.join(OUT_DIR, "holders_raw.json"), {
    block: SNAPSHOT_BLOCK,
    totalSupply: totalSupply.toString(),
    holders: balances,
  });
  console.log(`  wrote holders_raw.json`);
  return balances;
}

// ---------------------------------------------------------------------------
// Phase 2 — Classify EOA vs Contract
// ---------------------------------------------------------------------------

async function phase2Classify(): Promise<ClassifiedHolders> {
  ensureOut();
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(
    path.join(OUT_DIR, "holders_raw.json"),
  );
  const addrs = Object.keys(raw.holders);
  console.log(`Phase 2 — classify ${addrs.length} addresses @ block ${raw.block}`);

  const eoa: BalanceMap = {};
  const contracts: BalanceMap = {};
  const batchSize = 25;
  for (let i = 0; i < addrs.length; i += batchSize) {
    const chunk = addrs.slice(i, i + batchSize);
    const codes = await Promise.all(
      chunk.map((a) =>
        client.getBytecode({ address: a as Address, blockNumber: BigInt(raw.block) }),
      ),
    );
    chunk.forEach((a, j) => {
      const code = codes[j];
      const isContract = code !== undefined && code !== "0x" && code !== null && code.length > 2;
      (isContract ? contracts : eoa)[a] = raw.holders[a];
    });
    if (i % (batchSize * 8) === 0) {
      console.log(`  ${i + chunk.length}/${addrs.length} classified`);
    }
  }

  const out: ClassifiedHolders = {
    block: raw.block,
    totalSupply: raw.totalSupply,
    eoa,
    contracts,
  };
  writeJson(path.join(OUT_DIR, "holders_classified.json"), out);
  console.log(`  EOA      : ${Object.keys(eoa).length}`);
  console.log(`  contract : ${Object.keys(contracts).length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase 3 — Expand contract holders (recursive)
//
// Route table is intentionally narrow: contracts not matched halt the script.
// User signoff required before adding routes.
// ---------------------------------------------------------------------------

// Interface probes — used by classifyContract() to auto-route without hardcoded lists.
const SAFE_ABI = [{ name: "getOwners", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }] as const;
const BPT_ABI = [{ name: "getPoolId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;
const CURVE_GAUGE_ABI = [{ name: "lp_token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ERC4626_ABI = [{ name: "asset", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ERC20_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Per-deployment overrides — populate only if interface probing produces wrong route or platform needs custom expansion.
const KNOWN_OVERRIDES: Record<string, Route> = {
  // "0xabc…".toLowerCase(): "hedgey",
};

async function phase3Expand(): Promise<ExpansionReport> {
  ensureOut();
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const classified = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));

  console.log(`Phase 3 — expand ${Object.keys(classified.contracts).length} contract holders`);
  const final: Map<string, bigint> = new Map();
  for (const [a, b] of Object.entries(classified.eoa)) final.set(a, BigInt(b));

  const expanded: ExpansionEntry[] = [];
  const unknown: string[] = [];

  for (const [addr, balStr] of Object.entries(classified.contracts)) {
    const bal = BigInt(balStr);
    const route = await classifyContract(client, addr as Address, classified.block);
    if (!route) {
      unknown.push(addr);
      continue;
    }
    const sub = await expandOne(client, addr as Address, bal, route, classified.block, 0);
    for (const [a, b] of Object.entries(sub.beneficiaries)) {
      final.set(a, (final.get(a) ?? 0n) + BigInt(b));
    }
    expanded.push(sub);
  }

  if (unknown.length > 0) {
    writeJson(path.join(OUT_DIR, "unknown_contracts.json"), { addresses: unknown });
    console.error(`  HALT: ${unknown.length} unknown contracts — see unknown_contracts.json`);
  }

  // Invariant check
  let sum = 0n;
  const finalObj: BalanceMap = {};
  for (const [a, b] of final) {
    if (b <= 0n) continue;
    finalObj[a] = b.toString();
    sum += b;
  }
  if (sum !== BigInt(classified.totalSupply)) {
    console.warn(`  WARN: Σ expanded (${sum}) != totalSupply (${classified.totalSupply})`);
    console.warn(`        diff = ${BigInt(classified.totalSupply) - sum} (likely unknown contracts not yet routed)`);
  }

  const report: ExpansionReport = {
    block: classified.block,
    totalSupply: classified.totalSupply,
    expanded,
    finalBalances: finalObj,
    unknownContracts: unknown,
  };
  writeJson(path.join(OUT_DIR, "holders_expanded.json"), report);
  console.log(`  expanded into ${Object.keys(finalObj).length} final beneficiaries`);
  return report;
}

// Routing taxonomy. Default-DENY: a contract that does not pass an explicit route
// (with provenance assertion that it really holds sdBAL via that mechanism) halts
// the run. There is no generic ERC20 fallback — a treasury contract holding sdBAL
// inventory must NOT be treated as a wrapper and redistributed to its token holders.
//   safe        : Gnosis Safe — keep as-is (leaf, no recursion)
//   balancer-bpt: Balancer BPT — pool contains sdBAL as a constituent (verified via Vault)
//   curve-gauge : Curve-style gauge — lp_token() holds sdBAL (verified)
//   erc4626     : ERC4626 vault — asset()==sdBAL (verified)
//   hedgey      : Hedgey TokenVestingPlans NFT — per-plan recipient lookup (KNOWN_OVERRIDES only)
//   sablier     : Sablier V2 Lockup stream NFT — per-stream recipient lookup (KNOWN_OVERRIDES only)
type Route = "safe" | "balancer-bpt" | "curve-gauge" | "erc4626" | "hedgey" | "sablier";

const BALANCER_VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const VAULT_GET_POOL_TOKENS_ABI = [
  { name: "getPoolTokens", type: "function", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "tokens", type: "address[]" }, { name: "balances", type: "uint256[]" }, { name: "lastChangeBlock", type: "uint256" }] },
] as const;

async function classifyContract(
  client: PublicClient,
  addr: Address,
  block: number,
): Promise<Route | null> {
  const lower = addr.toLowerCase();
  if (KNOWN_OVERRIDES[lower]) return KNOWN_OVERRIDES[lower];

  // Probe interfaces in priority order. Each probe must be backed by a provenance
  // assertion below before the route is accepted.
  // 1. Gnosis Safe (no provenance needed — leaf, distributes USDC to Safe addr).
  if (await probeView(client, addr, SAFE_ABI, "getOwners", block)) return "safe";

  // 2. Balancer BPT — must contain sdBAL as a pool token at the snapshot block.
  const poolId = await probeView<Hex>(client, addr, BPT_ABI, "getPoolId", block);
  if (poolId) {
    if (await assertBptHoldsSdBal(client, poolId, block)) return "balancer-bpt";
    throw new Error(`Contract ${addr} has getPoolId() but pool does not include sdBAL — refusing to recurse`);
  }

  // 3. Curve-style gauge — lp_token() must be a contract whose sdBAL balance is non-zero.
  const lp = await probeView<Address>(client, addr, CURVE_GAUGE_ABI, "lp_token", block);
  if (lp) {
    if (await assertContractHoldsSdBal(client, lp, block)) return "curve-gauge";
    throw new Error(`Contract ${addr} has lp_token()=${lp} but that LP does not hold sdBAL — refusing to recurse`);
  }

  // 4. ERC4626 vault — asset() must equal sdBAL.
  const asset = await probeView<Address>(client, addr, ERC4626_ABI, "asset", block);
  if (asset) {
    if (getAddress(asset) === SD_BAL) return "erc4626";
    throw new Error(`Contract ${addr} is ERC4626 with asset()=${asset} (expected sdBAL ${SD_BAL}) — refusing to recurse`);
  }

  // No generic ERC20 fallback. Default-deny.
  return null;
}

async function assertBptHoldsSdBal(client: PublicClient, poolId: Hex, block: number): Promise<boolean> {
  try {
    const [tokens] = await client.readContract({
      address: BALANCER_VAULT, abi: VAULT_GET_POOL_TOKENS_ABI as any,
      functionName: "getPoolTokens", args: [poolId],
      blockNumber: BigInt(block),
    }) as [Address[], bigint[], bigint];
    return tokens.some((t) => getAddress(t) === SD_BAL);
  } catch {
    return false;
  }
}

async function assertContractHoldsSdBal(client: PublicClient, addr: Address, block: number): Promise<boolean> {
  try {
    const b = await client.readContract({
      address: SD_BAL, abi: ERC20_ABI as any, functionName: "balanceOf", args: [addr],
      blockNumber: BigInt(block),
    }) as bigint;
    return b > 0n;
  } catch {
    return false;
  }
}

async function probeView<T = unknown>(
  client: PublicClient,
  address: Address,
  abi: readonly { name: string; type: string; stateMutability: string; inputs: readonly unknown[]; outputs: readonly unknown[] }[],
  functionName: string,
  block: number,
): Promise<T | null> {
  try {
    return await client.readContract({
      address, abi: abi as any, functionName,
      blockNumber: BigInt(block),
    }) as T;
  } catch {
    return null;
  }
}

async function expandOne(
  client: PublicClient,
  addr: Address,
  balance: bigint,
  route: Route,
  block: number,
  depth: number,
  visited: Set<string> = new Set(),
): Promise<ExpansionEntry> {
  if (depth >= MAX_DEPTH) {
    throw new Error(`Recursion limit hit at ${addr} (route=${route})`);
  }
  switch (route) {
    case "safe":
      return { source: addr, reason: "safe", beneficiaries: { [addr]: balance.toString() } };
    case "balancer-bpt":
    case "curve-gauge":
    case "erc4626":
      // Recursive holder split: snapshot the wrapper's own ERC20 holders via Transfer logs,
      // distribute the wrapper's sdBAL balance pro-rata, recurse if downstream is a contract.
      return await expandWrapper(client, addr, balance, route, block, depth, visited);
    case "hedgey":
    case "sablier":
      return await expandVestingPlatform(client, addr, balance, route, block);
  }
}

async function expandWrapper(
  client: PublicClient,
  wrapper: Address,
  totalSdBal: bigint,
  route: Route,
  block: number,
  depth: number,
  visited: Set<string> = new Set(),
): Promise<ExpansionEntry> {
  // Cycle detection — same wrapper appearing twice in a recursion chain = misclassification or attack.
  const key = wrapper.toLowerCase();
  if (visited.has(key)) {
    throw new Error(`Cycle detected expanding ${wrapper} (route=${route}, depth=${depth})`);
  }
  visited = new Set([...visited, key]);

  // Replay Transfer logs to derive per-holder wrapper balances at `block`.
  const explorer = createBlockchainExplorerUtils();
  const logs = await explorer.getLogsByAddressesAndTopics(
    [wrapper], 0, block, { "0": TRANSFER_TOPIC }, ETH_CHAIN_ID_NUM,
  );
  const bal = new Map<string, bigint>();
  for (const log of logs.result) {
    const from = getAddress(`0x${log.topics[1].slice(26)}`);
    const to = getAddress(`0x${log.topics[2].slice(26)}`);
    const amount = BigInt(log.data);
    if (from !== ZERO_ADDR) bal.set(from, (bal.get(from) ?? 0n) - amount);
    bal.set(to, (bal.get(to) ?? 0n) + amount);
  }

  // Denominator: onchain totalSupply() at `block`, NOT the replay sum.
  // Burns deposit into ZERO_ADDR in the replay model, which would inflate a naive
  // replay-sum denominator and dilute real holders. The contract's totalSupply()
  // is the authoritative supply that excludes burns by definition.
  const wrapperTotalSupply = await client.readContract({
    address: wrapper, abi: ERC20_ABI as any, functionName: "totalSupply",
    blockNumber: BigInt(block),
  }) as bigint;
  if (wrapperTotalSupply === 0n) {
    throw new Error(`Wrapper ${wrapper} totalSupply==0 at block ${block}`);
  }

  // Reconcile replay vs onchain (excluding zero addr and self).
  const replaySum = [...bal.entries()].reduce(
    (acc, [a, v]) => acc + (v > 0n && a !== ZERO_ADDR && a !== wrapper ? v : 0n),
    0n,
  );
  if (replaySum !== wrapperTotalSupply) {
    throw new Error(
      `Wrapper ${wrapper} replay (${replaySum}) != onchain totalSupply (${wrapperTotalSupply}) — log range or rebase token; manual review`,
    );
  }

  const beneficiaries: BalanceMap = {};
  let assigned = 0n;
  const positive = [...bal.entries()].filter(([a, b]) => b > 0n && a !== ZERO_ADDR && a !== wrapper);

  for (const [holder, wrapperBal] of positive) {
    const sub = (wrapperBal * totalSdBal) / wrapperTotalSupply;
    if (sub <= 0n) continue;

    const code = await client.getBytecode({ address: holder as Address, blockNumber: BigInt(block) });
    const isContract = code !== undefined && code !== null && code !== "0x" && code.length > 2;

    if (isContract) {
      const subRoute = await classifyContract(client, holder as Address, block);
      if (!subRoute) {
        // Halt immediately on nested unknown — do NOT silently mark and continue,
        // because doing so skips `assigned += sub` and inflates the dust calc below.
        throw new Error(
          `Nested unknown contract ${holder} inside wrapper ${wrapper} (route=${route}, depth=${depth + 1}) — add explicit route or halt`,
        );
      }
      const sub2 = await expandOne(client, holder as Address, sub, subRoute, block, depth + 1, visited);
      for (const [a, b] of Object.entries(sub2.beneficiaries)) {
        beneficiaries[a] = ((BigInt(beneficiaries[a] ?? "0") + BigInt(b)).toString());
      }
    } else {
      beneficiaries[holder] = ((BigInt(beneficiaries[holder] ?? "0") + sub).toString());
    }
    assigned += sub;
  }

  // Dust from integer division → assign to largest EOA beneficiary so the total
  // matches `totalSdBal` exactly (uint reconciliation).
  const dust = totalSdBal - assigned;
  if (dust > 0n) {
    let topAddr: string | undefined;
    let topVal = 0n;
    for (const [a, b] of Object.entries(beneficiaries)) {
      const v = BigInt(b);
      if (v > topVal) { topVal = v; topAddr = a; }
    }
    if (topAddr) beneficiaries[topAddr] = (topVal + dust).toString();
  }

  return { source: wrapper, reason: route, beneficiaries };
}

async function expandVestingPlatform(
  _client: PublicClient,
  addr: Address,
  balance: bigint,
  route: Route,
  _block: number,
): Promise<ExpansionEntry> {
  // TODO: per-platform expansion.
  // Hedgey TokenVestingPlans:
  //   - Enumerate ERC721 ownerOf for each planId where token==SD_BAL
  //   - read plans(planId).beneficiary OR planRecipient(planId)
  // Sablier:
  //   - Read all streams where asset == SD_BAL; recipient = sender or NFT owner depending on version
  //
  // Until specific vest contracts are confirmed live with sdBAL, halt.
  throw new Error(`Vesting route ${route} for ${addr} (${balance}) not yet implemented — populate KNOWN list + per-platform expansion`);
}

// ---------------------------------------------------------------------------
// Phase 4 — Pro-rata USDC payouts
// ---------------------------------------------------------------------------

function phase4Payouts(usdcReceivedStr: string): Payouts {
  ensureOut();
  const report = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  if (report.unknownContracts.length > 0) {
    throw new Error(`Cannot compute payouts — ${report.unknownContracts.length} unknown contracts unresolved`);
  }
  for (const a of Object.keys(report.finalBalances)) {
    if (a.startsWith("__UNKNOWN__")) {
      throw new Error(`Cannot compute payouts — unresolved downstream contract: ${a}`);
    }
  }

  const totalSupply = BigInt(report.totalSupply);
  const usdcReceived = BigInt(usdcReceivedStr);

  const perAddress: { [a: string]: string } = {};
  let assigned = 0n;
  let topAddr = "";
  let topShare = 0n;

  for (const [a, balStr] of Object.entries(report.finalBalances)) {
    const bal = BigInt(balStr);
    const amount = (bal * usdcReceived) / totalSupply;
    if (amount <= 0n) continue;
    perAddress[a] = amount.toString();
    assigned += amount;
    if (bal > topShare) { topShare = bal; topAddr = a; }
  }

  const dust = usdcReceived - assigned;
  if (dust > 0n && topAddr) {
    perAddress[topAddr] = (BigInt(perAddress[topAddr]) + dust).toString();
    assigned += dust;
  }
  if (assigned !== usdcReceived) {
    throw new Error(`Payout reconciliation failed: assigned=${assigned} usdcReceived=${usdcReceived}`);
  }

  const out: Payouts = {
    block: report.block,
    usdcReceived: usdcReceived.toString(),
    perAddress,
    dustReassignedTo: topAddr,
  };
  writeJson(path.join(OUT_DIR, "payouts.json"), out);
  console.log(`Phase 4 — payouts`);
  console.log(`  recipients : ${Object.keys(perAddress).length}`);
  console.log(`  USDC total : ${formatUnits(usdcReceived, 6)} USDC`);
  console.log(`  dust to    : ${topAddr}`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase 5 — Merge into extra_merkle/merkle.json (cumulative, URD double-hash)
// ---------------------------------------------------------------------------

const TRANCHE_MANIFEST = path.join(__dirname, "sdbal-sunset", "tranches.json");

interface Tranche {
  trancheId: number;
  appliedAt: number;
  payoutHash: Hex;
  priorRoot: string;
  newRoot: string;
  usdcAdded: string;
  recipients: number;
}

function loadTranches(): Tranche[] {
  if (!fs.existsSync(TRANCHE_MANIFEST)) return [];
  return readJson<Tranche[]>(TRANCHE_MANIFEST);
}

function hashPayouts(p: Payouts): Hex {
  // Order-independent content hash so reordering perAddress doesn't dodge the guard.
  const sorted = Object.keys(p.perAddress).sort();
  const canon = sorted.map((a) => `${a.toLowerCase()}:${p.perAddress[a]}`).join("|");
  return utils.keccak256(utils.toUtf8Bytes(`${p.block}|${p.usdcReceived}|${canon}`)) as Hex;
}

function phase5Merge() {
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));
  const payoutHash = hashPayouts(payouts);

  // Replay guard: refuse to re-merge the same payouts.json.
  const tranches = loadTranches();
  if (tranches.some((t) => t.payoutHash === payoutHash)) {
    throw new Error(
      `Phase 5 refusing to re-apply: payoutHash ${payoutHash} already in tranches.json. ` +
        `If this is a new tranche, regenerate payouts.json with the new USDC amount.`,
    );
  }

  // Load existing distribution (cumulative across all prior tokens/users).
  const existing = readJson<MerkleData>(EXTRA_MERKLE);
  const distribution: UniversalMerkle = {};
  for (const [addr, claim] of Object.entries(existing.claims)) {
    const c = getAddress(addr);
    distribution[c] = {};
    for (const [tok, td] of Object.entries(claim.tokens)) {
      distribution[c][getAddress(tok)] = td.amount;
    }
  }

  // Cumulative add of new USDC entitlements. Snapshot the per-addr expected delta
  // so verifyPriorLeavesUnchanged can enforce EXACT new-USDC value, not just a
  // monotonic increase.
  const expectedUsdcAfter: Record<string, bigint> = {};
  let usdcAddedTotal = 0n;
  for (const [addr, amount] of Object.entries(payouts.perAddress)) {
    const c = getAddress(addr);
    if (!distribution[c]) distribution[c] = {};
    const prev = BigInt(distribution[c][USDC] ?? "0");
    const next = prev + BigInt(amount);
    distribution[c][USDC] = next.toString();
    expectedUsdcAfter[c] = next;
    usdcAddedTotal += BigInt(amount);
  }
  console.log(`Phase 5 — merge: USDC added to ${Object.keys(payouts.perAddress).length} addresses (Σ=${formatUnits(usdcAddedTotal, 6)} USDC)`);

  const newMerkle = generateUrdMerkle(distribution);

  // Verify: prior non-USDC leaves byte-identical, USDC leaves match expected exact delta.
  verifyPriorLeavesUnchanged(existing, newMerkle, expectedUsdcAfter);

  writeJson(EXTRA_MERKLE, newMerkle);

  // Append tranche record AFTER write succeeds.
  const nextTranche: Tranche = {
    trancheId: tranches.length + 1,
    appliedAt: Math.floor(Date.now() / 1000),
    payoutHash,
    priorRoot: existing.merkleRoot,
    newRoot: newMerkle.merkleRoot,
    usdcAdded: usdcAddedTotal.toString(),
    recipients: Object.keys(payouts.perAddress).length,
  };
  ensureOut();
  writeJson(TRANCHE_MANIFEST, [...tranches, nextTranche]);
  console.log(`  tranche ${nextTranche.trancheId} recorded → ${TRANCHE_MANIFEST}`);

  // summary
  const tokenSummary: Record<string, { total: bigint; recipients: number }> = {};
  for (const [, tokens] of Object.entries(distribution)) {
    for (const [tok, amt] of Object.entries(tokens)) {
      if (!tokenSummary[tok]) tokenSummary[tok] = { total: 0n, recipients: 0 };
      tokenSummary[tok].total += BigInt(amt);
      tokenSummary[tok].recipients++;
    }
  }
  const ts = Math.floor(Date.now() / 1000);
  writeJson(EXTRA_SUMMARY, {
    timestamp: ts,
    merkleRoot: newMerkle.merkleRoot,
    totalRecipients: Object.keys(distribution).length,
    tokens: Object.entries(tokenSummary).map(([token, d]) => ({
      token, totalAmount: d.total.toString(), recipients: d.recipients,
    })),
  });
  writeJson(EXTRA_REPART, { timestamp: ts, distribution });

  console.log(`  new merkleRoot: ${newMerkle.merkleRoot}`);
  console.log(`  recipients    : ${Object.keys(distribution).length}`);
}

// ---------------------------------------------------------------------------
// URD merkle (double-hash leaf, sortPairs) — matches lineaDistribution.ts
// ---------------------------------------------------------------------------

function urdLeaf(user: string, token: string, amount: string): Hex {
  return utils.keccak256(
    utils.solidityPack(
      ["bytes"],
      [
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["address", "address", "uint256"],
            [user, token, amount],
          ),
        ),
      ],
    ),
  ) as Hex;
}

function generateUrdMerkle(distribution: UniversalMerkle): MerkleData {
  const leaves: Hex[] = [];
  const claims: MerkleData["claims"] = {};
  for (const [user, tokens] of Object.entries(distribution)) {
    const c = getAddress(user);
    if (!claims[c]) claims[c] = { tokens: {} };
    for (const [tok, amount] of Object.entries(tokens)) {
      const t = getAddress(tok);
      leaves.push(urdLeaf(c, t, amount));
      claims[c].tokens[t] = { amount, proof: [] };
    }
  }
  const tree = new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
  const root = tree.getHexRoot();
  for (const [user, tokens] of Object.entries(distribution)) {
    const c = getAddress(user);
    for (const [tok, amount] of Object.entries(tokens)) {
      const t = getAddress(tok);
      claims[c].tokens[t].proof = tree.getHexProof(urdLeaf(c, t, amount));
    }
  }
  return { merkleRoot: root, claims };
}

function verifyPriorLeavesUnchanged(
  prior: MerkleData,
  next: MerkleData,
  expectedUsdcAfter: Record<string, bigint>,
) {
  // (a) No prior leaf disappears or shrinks; non-USDC leaves byte-identical.
  let checked = 0;
  for (const [addr, c] of Object.entries(prior.claims)) {
    const cChk = getAddress(addr);
    for (const [tok, td] of Object.entries(c.tokens)) {
      const t = getAddress(tok);
      const nextClaim = next.claims[cChk]?.tokens?.[t];
      if (!nextClaim) throw new Error(`Prior leaf dropped: ${cChk} / ${t}`);
      if (t === USDC) {
        // USDC may grow; exact value asserted in pass (b).
        if (BigInt(nextClaim.amount) < BigInt(td.amount)) {
          throw new Error(`Prior USDC shrunk for ${cChk}: ${td.amount} -> ${nextClaim.amount}`);
        }
      } else if (nextClaim.amount !== td.amount) {
        throw new Error(`Non-USDC token amount changed for ${cChk} / ${t}: ${td.amount} -> ${nextClaim.amount}`);
      }
      checked++;
    }
  }

  // (b) For every addr in this tranche, next USDC value EXACTLY equals expected.
  for (const [addr, expected] of Object.entries(expectedUsdcAfter)) {
    const cChk = getAddress(addr);
    const nextClaim = next.claims[cChk]?.tokens?.[USDC];
    if (!nextClaim) throw new Error(`Expected USDC leaf missing for ${cChk}`);
    if (BigInt(nextClaim.amount) !== expected) {
      throw new Error(
        `USDC delta mismatch for ${cChk}: got ${nextClaim.amount}, expected ${expected.toString()}`,
      );
    }
  }

  // (c) No USDC leaf added that wasn't in expectedUsdcAfter.
  for (const [addr, claim] of Object.entries(next.claims)) {
    const cChk = getAddress(addr);
    if (claim.tokens[USDC] && expectedUsdcAfter[cChk] === undefined) {
      // Must have existed in prior with the same value (no new USDC outside this tranche).
      const priorClaim = prior.claims[cChk]?.tokens?.[USDC];
      if (!priorClaim || priorClaim.amount !== claim.tokens[USDC].amount) {
        throw new Error(`Unexpected USDC leaf for ${cChk} not in payouts`);
      }
    }
  }

  console.log(`  invariant ok: ${checked} prior leaves preserved, ${Object.keys(expectedUsdcAfter).length} USDC deltas exact`);
}

// ---------------------------------------------------------------------------
// Phase 6 — Gnosis Safe tx bundle (submitRoot + optional USDC top-up)
// ---------------------------------------------------------------------------

const URD_ADDRESS = getAddress("0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e");
const URD_INTERFACE_ABI = [
  { name: "submitRoot", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newRoot", type: "bytes32" }, { name: "ipfsHash", type: "bytes32" }], outputs: [] },
  { name: "acceptRoot", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "claimed", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "reward", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ERC20_TRANSFER_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

function phase6SafeBundle(opts: { topupAmount?: string }) {
  // IMPORTANT: the importing Safe is the msg.sender for ALL transactions in this bundle.
  // - The USDC top-up moves funds FROM the importing Safe TO the URD. If the USDC
  //   actually lives at the Balancer veBAL locker (0xea79...36A5) or elsewhere, the
  //   importing Safe must already hold the USDC, or the top-up must be a separate tx.
  // - submitRoot() requires the importing Safe to be the URD owner/updater.
  // Verify both pre-conditions onchain before uploading this bundle.
  const merkle = readJson<MerkleData>(EXTRA_MERKLE);
  const root = merkle.merkleRoot as Hex;
  const ipfs = ("0x" + "00".repeat(32)) as Hex;

  const txs: { to: string; value: string; data: string }[] = [];

  if (opts.topupAmount) {
    txs.push({
      to: USDC,
      value: "0",
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [URD_ADDRESS, BigInt(opts.topupAmount)] }),
    });
  }

  txs.push({
    to: URD_ADDRESS,
    value: "0",
    data: encodeFunctionData({ abi: URD_INTERFACE_ABI, functionName: "submitRoot", args: [root, ipfs] }),
  });

  const bundle = {
    version: "1.0",
    chainId: ETH_CHAIN_ID,
    createdAt: Math.floor(Date.now() / 1000),
    meta: {
      name: "sdBAL Sunset USDC Distribution — submitRoot",
      description:
        `Root=${root}. Importing Safe MUST be URD owner/updater. ` +
        (opts.topupAmount
          ? `Top-up tx assumes importing Safe holds ${opts.topupAmount} (raw uint, USDC 6 decimals = ${formatUnits(BigInt(opts.topupAmount), 6)} USDC).`
          : `No top-up included — ensure URD already holds the USDC.`),
    },
    transactions: txs,
  };

  // Separate acceptRoot bundle (post-timelock).
  const acceptBundle = {
    version: "1.0",
    chainId: ETH_CHAIN_ID,
    createdAt: Math.floor(Date.now() / 1000),
    meta: { name: "sdBAL Sunset USDC Distribution — acceptRoot", description: "Run after URD timelock expires (see pendingRoot().validAt)" },
    transactions: [{
      to: URD_ADDRESS, value: "0",
      data: encodeFunctionData({ abi: URD_INTERFACE_ABI, functionName: "acceptRoot", args: [] }),
    }],
  };

  ensureOut();
  writeJson(path.join(OUT_DIR, "safe_submitRoot.json"), bundle);
  writeJson(path.join(OUT_DIR, "safe_acceptRoot.json"), acceptBundle);
  console.log(`Phase 6 — Safe bundles written`);
  console.log(`  safe_submitRoot.json  (root=${root})`);
  console.log(`  safe_acceptRoot.json  (post-timelock)`);
}

// ---------------------------------------------------------------------------
// Phase 7 — verification gate (re-runs ALL invariants from on-disk artifacts)
// ---------------------------------------------------------------------------

// Phase 7 is the release gate. Each check is independently passable; only when ALL
// pass is the new root safe to submit on-chain.
async function phase7Verify() {
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(path.join(OUT_DIR, "holders_raw.json"));
  const cls = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));
  const exp = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));
  const merkle = readJson<MerkleData>(EXTRA_MERKLE);
  const tranches = loadTranches();
  const thisTranche = tranches.find((t) => t.newRoot === merkle.merkleRoot);

  console.log("Phase 7 — verification gate");
  const checks: { name: string; pass: boolean; detail?: string }[] = [];

  // 1. holders_raw sum
  const sumRaw = Object.values(raw.holders).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ raw holders == totalSupply",
    pass: sumRaw.toString() === raw.totalSupply,
    detail: `${sumRaw} vs ${raw.totalSupply}`,
  });

  // 1b. Re-query sdBAL totalSupply onchain at snapshot block.
  const onchainTotalSupply = await client.readContract({
    address: SD_BAL, abi: ERC20_ABI as any, functionName: "totalSupply",
    blockNumber: BigInt(raw.block),
  }) as bigint;
  checks.push({
    name: `sdBAL totalSupply@block${raw.block} matches snapshot`,
    pass: onchainTotalSupply.toString() === raw.totalSupply,
    detail: `onchain=${onchainTotalSupply} file=${raw.totalSupply}`,
  });

  // 2. classified sum == raw sum
  const sumCls = [...Object.values(cls.eoa), ...Object.values(cls.contracts)].reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ classified == Σ raw", pass: sumCls === sumRaw, detail: `${sumCls} vs ${sumRaw}` });

  // 2b. Spot-check EOA classification (5 random addrs) — bytecode at snapshot block still 0x.
  const eoaAddrs = Object.keys(cls.eoa);
  let eoaOk = 0;
  for (let i = 0; i < Math.min(5, eoaAddrs.length); i++) {
    const a = eoaAddrs[Math.floor(Math.random() * eoaAddrs.length)] as Address;
    const code = await client.getBytecode({ address: a, blockNumber: BigInt(raw.block) });
    if (!code || code === "0x") eoaOk++;
  }
  checks.push({ name: "Random EOA bytecode re-check (5)", pass: eoaOk === Math.min(5, eoaAddrs.length), detail: `${eoaOk}/${Math.min(5, eoaAddrs.length)}` });

  // 3. expanded sum == raw sum
  const sumExp = Object.values(exp.finalBalances).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ expanded == totalSupply",
    pass: sumExp.toString() === raw.totalSupply,
    detail: `${sumExp} vs ${raw.totalSupply}`,
  });

  // 4. no unknown contracts or sentinels
  checks.push({
    name: "No unknown contracts",
    pass: exp.unknownContracts.length === 0,
    detail: `${exp.unknownContracts.length} unresolved`,
  });
  checks.push({
    name: "No __UNKNOWN__ sentinel addresses in finalBalances",
    pass: !Object.keys(exp.finalBalances).some((a) => a.startsWith("__UNKNOWN__")),
  });

  // 4b. Final beneficiaries: every contract addr in finalBalances must be a known Safe (default-deny check).
  const finalContractAddrs: string[] = [];
  for (const addr of Object.keys(exp.finalBalances)) {
    const code = await client.getBytecode({ address: addr as Address, blockNumber: BigInt(raw.block) });
    if (code && code !== "0x" && code.length > 2) finalContractAddrs.push(addr);
  }
  let allContractsAreSafes = true;
  for (const addr of finalContractAddrs) {
    const route = await classifyContract(client, addr as Address, raw.block);
    if (route !== "safe") { allContractsAreSafes = false; break; }
  }
  checks.push({
    name: "All contract beneficiaries are Gnosis Safes",
    pass: allContractsAreSafes,
    detail: `${finalContractAddrs.length} contracts in final set`,
  });

  // 5. payouts sum == usdcReceived
  const sumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ payouts == usdcReceived",
    pass: sumPay.toString() === payouts.usdcReceived,
    detail: `${sumPay} vs ${payouts.usdcReceived}`,
  });

  // 6. URD USDC balance ≥ OUTSTANDING USDC liability = Σ max(claimable - claimed, 0).
  // Use cumulative−claimed because URD only pays out `claimable - claimed[user][token]`
  // per call. Summing raw `claimable` would over-state liability and false-fail for
  // any tranche after users start claiming.
  const urdUsdc = await client.readContract({ address: USDC, abi: ERC20_ABI as any, functionName: "balanceOf", args: [URD_ADDRESS] }) as bigint;
  const usdcLeaves: { addr: Address; amount: bigint }[] = [];
  for (const [addr, c] of Object.entries(merkle.claims)) {
    const u = c.tokens[USDC];
    if (u) usdcLeaves.push({ addr: getAddress(addr), amount: BigInt(u.amount) });
  }
  // Batch claimed() reads (parallel, 20 at a time).
  let outstandingUsdc = 0n;
  for (let i = 0; i < usdcLeaves.length; i += 20) {
    const chunk = usdcLeaves.slice(i, i + 20);
    const claimedAmts = await Promise.all(chunk.map((l) =>
      client.readContract({ address: URD_ADDRESS, abi: URD_INTERFACE_ABI as any, functionName: "claimed", args: [l.addr, USDC] }) as Promise<bigint>,
    ));
    chunk.forEach((l, j) => {
      const outstanding = l.amount > claimedAmts[j] ? l.amount - claimedAmts[j] : 0n;
      outstandingUsdc += outstanding;
    });
  }
  checks.push({
    name: "URD USDC balance ≥ outstanding USDC liability (cumulative − claimed)",
    pass: urdUsdc >= outstandingUsdc,
    detail: `URD has ${formatUnits(urdUsdc, 6)} USDC, outstanding ${formatUnits(outstandingUsdc, 6)} USDC across ${usdcLeaves.length} leaves`,
  });

  // 7. ALL leaves verify against root (not just 10).
  const tree = rebuildMerkleFromData(merkle);
  let leafOk = 0, leafTotal = 0;
  for (const [addr, c] of Object.entries(merkle.claims)) {
    for (const [tok, td] of Object.entries(c.tokens)) {
      leafTotal++;
      const leaf = urdLeaf(getAddress(addr), getAddress(tok), td.amount);
      if (tree.verify(td.proof as Hex[], leaf, merkle.merkleRoot as Hex)) leafOk++;
    }
  }
  checks.push({ name: "All leaves verify against root", pass: leafOk === leafTotal, detail: `${leafOk}/${leafTotal}` });

  // 8. Tranche manifest binding — current root + payouts artifact + USDC totals all match the recorded tranche.
  const currentPayoutHash = hashPayouts(payouts);
  const currentSumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  const manifestBindingOk =
    thisTranche !== undefined
    && thisTranche.payoutHash === currentPayoutHash
    && thisTranche.usdcAdded === currentSumPay.toString()
    && thisTranche.recipients === Object.keys(payouts.perAddress).length;
  checks.push({
    name: "Tranche manifest binds current root + payouts.json + totals",
    pass: manifestBindingOk,
    detail: thisTranche
      ? `tranche #${thisTranche.trancheId} payoutHash=${thisTranche.payoutHash.slice(0, 10)}… currentHash=${currentPayoutHash.slice(0, 10)}…`
      : `root ${merkle.merkleRoot.slice(0, 10)}… not found in tranches.json`,
  });

  // Print
  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    if (!c.pass) allPass = false;
  }
  console.log(allPass ? "\nALL GATES PASSED — safe to submit root." : "\nGATE FAILED — do not submit root.");
  if (!allPass) process.exit(1);
}

function rebuildMerkleFromData(merkle: MerkleData): MerkleTree {
  const leaves: Hex[] = [];
  for (const [addr, claim] of Object.entries(merkle.claims)) {
    for (const [tok, td] of Object.entries(claim.tokens)) {
      leaves.push(urdLeaf(getAddress(addr), getAddress(tok), td.amount));
    }
  }
  return new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}
function writeJson(p: string, data: unknown) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

async function main() {
  const phase = arg("phase") ?? "all";
  const usdc = arg("usdc"); // raw uint USDC amount received by locker (decimals=6)

  switch (phase) {
    case "1":   await phase1Snapshot(); break;
    case "2":   await phase2Classify(); break;
    case "3":   await phase3Expand(); break;
    case "4":
      if (!usdc) throw new Error("--usdc required for phase 4 (uint, USDC 6 decimals)");
      phase4Payouts(usdc); break;
    case "5":   phase5Merge(); break;
    case "6": {
      const topupAmount = arg("topup-amount");
      phase6SafeBundle({ topupAmount }); break;
    }
    case "7":
    case "verify": await phase7Verify(); break;
    case "all": {
      // Read-only phases first.
      await phase1Snapshot();
      await phase2Classify();
      await phase3Expand();
      if (!usdc) {
        console.log("Skipping phase 4-7 — pass --usdc <amount> once Balancer airdrop tx lands.");
        return;
      }
      phase4Payouts(usdc);
      // Pre-merge gate: verify all read-only artifacts before mutating extra_merkle.
      await preMergeVerify();
      // Mutate.
      phase5Merge();
      phase6SafeBundle({});
      // Post-merge gate (includes onchain checks + full leaf verification).
      await phase7Verify();
      break;
    }
    default: throw new Error(`Unknown --phase ${phase}`);
  }
}

// Pre-merge gate. Runs every deterministic check that doesn't require the post-merge
// merkle.json before phase 5 mutates extra_merkle. A failure here leaves the working
// tree clean. Phase 7 re-runs these plus post-merge-only checks.
async function preMergeVerify() {
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(path.join(OUT_DIR, "holders_raw.json"));
  const cls = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));
  const exp = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));

  const checks: { name: string; pass: boolean; detail?: string }[] = [];

  const sumRaw = Object.values(raw.holders).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ raw == totalSupply", pass: sumRaw.toString() === raw.totalSupply });

  const onchainTs = await client.readContract({ address: SD_BAL, abi: ERC20_ABI as any, functionName: "totalSupply", blockNumber: BigInt(raw.block) }) as bigint;
  checks.push({ name: "onchain totalSupply matches snapshot", pass: onchainTs.toString() === raw.totalSupply });

  const sumCls = [...Object.values(cls.eoa), ...Object.values(cls.contracts)].reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ classified == Σ raw", pass: sumCls === sumRaw });

  // Random EOA bytecode re-check (5).
  const eoaAddrs = Object.keys(cls.eoa);
  let eoaOk = 0;
  const eoaSample = Math.min(5, eoaAddrs.length);
  for (let i = 0; i < eoaSample; i++) {
    const a = eoaAddrs[Math.floor(Math.random() * eoaAddrs.length)] as Address;
    const code = await client.getBytecode({ address: a, blockNumber: BigInt(raw.block) });
    if (!code || code === "0x") eoaOk++;
  }
  checks.push({ name: "Random EOA bytecode re-check", pass: eoaOk === eoaSample, detail: `${eoaOk}/${eoaSample}` });

  const sumExp = Object.values(exp.finalBalances).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ expanded == totalSupply", pass: sumExp.toString() === raw.totalSupply });
  checks.push({ name: "No unknown contracts", pass: exp.unknownContracts.length === 0 });
  checks.push({ name: "No __UNKNOWN__ sentinels", pass: !Object.keys(exp.finalBalances).some((a) => a.startsWith("__UNKNOWN__")) });

  // Every contract addr in final beneficiaries must classify as a Safe (default-deny).
  const finalContractAddrs: string[] = [];
  for (const addr of Object.keys(exp.finalBalances)) {
    const code = await client.getBytecode({ address: addr as Address, blockNumber: BigInt(raw.block) });
    if (code && code !== "0x" && code.length > 2) finalContractAddrs.push(addr);
  }
  let allContractsAreSafes = true;
  let firstBadContract: string | undefined;
  for (const addr of finalContractAddrs) {
    const route = await classifyContract(client, addr as Address, raw.block);
    if (route !== "safe") { allContractsAreSafes = false; firstBadContract = addr; break; }
  }
  checks.push({
    name: "All contract beneficiaries are Gnosis Safes",
    pass: allContractsAreSafes,
    detail: firstBadContract ? `non-Safe found: ${firstBadContract}` : `${finalContractAddrs.length} contracts pass`,
  });

  const sumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ payouts == usdcReceived", pass: sumPay.toString() === payouts.usdcReceived });

  console.log("Pre-merge gate:");
  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.pass ? "OK  " : "FAIL"}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    if (!c.pass) allPass = false;
  }
  if (!allPass) {
    console.error("\nPre-merge gate failed — aborting before any mutation.");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
