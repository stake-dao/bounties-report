import fs from "fs";
import { utils } from "ethers";
import { getAddress } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { UniversalMerkle } from "../../interfaces/UniversalMerkle";
import { generateMerkleTree } from "./generateMerkleTree";

export const EXPIRY_DISTRIBUTOR = "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db";

export const EXTRA_REWARDS_DISTRIBUTOR = "0xD4898A378eA555595c4E7dbDE722B134a3F346D1";

export interface Credit {
  id: string;
  root: string;
  granted: string;
  paid: string;
  recovered: string;
  activatedAt: number | null;
  // Earned-by proof does not change publication order or claim allocation.
  ageBoundAt?: number;
  protection: string | null;
}

export interface AccountLedger {
  account: string;
  token: string;
  activeAmount: string;
  paid: string;
  credits: Credit[];
}

export interface Ledger {
  version: 1;
  chainId: number;
  distributor: string;
  root: string;
  checkpoint: { block: number; blockHash: string; logIndex?: number };
  pairs: Record<string, AccountLedger>;
  lastDistributionAt?: number;
  recoveries: string[];
  runs: Record<string, { nextBatch: number; complete: boolean; processed: string[] }>;
}

export interface Publication {
  root: string;
  timestamp: number;
  block: number;
  blockHash: string;
  logIndex?: number;
  transactionHash?: string;
  merkle: MerkleData | null;
  vmRewards?: Record<string, string>;
}

export interface UnionAgeBound {
  account: string;
  witness: Pick<Publication, "root" | "block" | "blockHash" | "timestamp" | "logIndex" | "transactionHash">;
  roots: string[];
  amounts: Record<string, string>;
}

export interface ExpiryPolicy {
  treasury: string;
  approval: { reference: string; passedAt: number };
  notices: { url: string; announcedAt: number }[];
}

export interface ExpiryBatch {
  round: number;
  index: number;
  last: boolean;
  ledger: string;
  parent: string;
  token: string;
  treasuryAmount: string;
  rows: { account: string; amount: string; expiredThrough: string }[];
  program: string;
  nodes: string[];
}

export interface ExpiryPlan {
  round: number;
  index: number;
  parent: string;
  batches: string[];
}

export interface PreparedRound extends Omit<PreparedExpiry, "batch" | "credits" | "plan"> {
  plan: ExpiryPlan;
  prices?: Record<string, { usd: string; decimals: number }>;
  batches: (Pick<ExpiryBatch, "round" | "index" | "last" | "token" | "rows"> & { credits: PreparedExpiry["credits"] })[];
}

export interface PreparedExpiry {
  plan?: string;
  chainId: number;
  distributor: string;
  treasury: string;
  at: number;
  policy: ExpiryPolicy;
  state: Ledger;
  parent: MerkleData;
  credits: Record<string, string[]>;
  batch: ExpiryBatch;
  module: { address: string; safe: string; preparer: string; delay: number };
}

export interface ConfirmedExpiry {
  digest: string;
  parent: string;
  root: string;
  recovered: string;
  transactionHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  rows: { account: string; token: string; paid: string; amount: string }[];
}

export function expiryEffectiveAt(policy: ExpiryPolicy): number | null {
  const channels = new Set<string>();
  for (const notice of policy.notices) {
    const url = new URL(notice.url);
    if (url.protocol !== "https:") throw new Error("notice channel");
    if (url.hostname === "gov.stakedao.org") channels.add("forum");
    else if (["stakedao.org", "www.stakedao.org"].includes(url.hostname)) channels.add("website");
    else if (["x.com", "twitter.com"].includes(url.hostname) && /^\/StakeDAOHQ\//i.test(url.pathname)) channels.add("social");
    else throw new Error("notice channel");
    sixCalendarMonths(notice.announcedAt);
  }
  sixCalendarMonths(policy.approval.passedAt);
  if (!policy.approval.reference || channels.size < 2) return null;
  return Math.max(policy.approval.passedAt, ...policy.notices.map(notice => notice.announcedAt)) + 30 * 86400;
}

export const expiryKey = (account: string, token: string) => `${getAddress(account).toLowerCase()}:${getAddress(token).toLowerCase()}`;

export function expiryRound(ledger: Ledger, canonical: number): number {
  return Math.min(canonical, ...Object.entries(ledger.runs).filter(([round, run]) => !run.complete && Number(round) <= canonical).map(([round]) => Number(round)));
}

const quantity = (value: string) => {
  if (!/^\d+$/.test(value) || BigInt(value) >= 1n << 256n) throw new Error("invalid reward quantity");
  return BigInt(value);
};

const remaining = (credit: Credit) => quantity(credit.granted) - quantity(credit.paid) - quantity(credit.recovered);

export function sixCalendarMonths(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("invalid activation timestamp");
  const date = new Date(timestamp * 1000);
  const month = date.getUTCMonth() + 6;
  const day = Math.min(date.getUTCDate(), new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate());
  const result = Date.UTC(date.getUTCFullYear(), month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()) / 1000;
  if (!Number.isSafeInteger(result)) throw new Error("invalid expiry timestamp");
  return result;
}

export function verifyExpiryParent(merkle: MerkleData): UniversalMerkle {
  const distribution: UniversalMerkle = {};
  for (const [account, claim] of Object.entries(merkle.claims)) {
    const user = getAddress(account);
    if (distribution[user]) throw new Error("duplicate account");
    distribution[user] = {};
    for (const [token, value] of Object.entries(claim.tokens)) {
      const reward = getAddress(token);
      if (distribution[user][reward] !== undefined) throw new Error("duplicate reward leaf");
      distribution[user][reward] = quantity(value.amount).toString();
    }
  }
  if (generateMerkleTree(distribution).merkleRoot.toLowerCase() !== merkle.merkleRoot.toLowerCase()) throw new Error("parent root mismatch");
  return distribution;
}

export function assertExpiryLedger(ledger: Ledger): void {
  const voters = ledger.distributor === EXPIRY_DISTRIBUTOR && [1, 8453, 42161].includes(ledger.chainId);
  const extra = ledger.distributor === EXTRA_REWARDS_DISTRIBUTOR && ledger.chainId === 1;
  if (ledger.version !== 1 || (!voters && !extra)) throw new Error("ledger target");
  for (const [key, pair] of Object.entries(ledger.pairs)) {
    if (key !== expiryKey(pair.account, pair.token)) throw new Error("ledger pair key");
    const ids = new Set<string>();
    let paid = 0n;
    let outstanding = 0n;
    for (const credit of pair.credits) {
      if (ids.has(credit.id) || remaining(credit) < 0n) throw new Error("credit accounting");
      ids.add(credit.id);
      if (credit.activatedAt !== null) sixCalendarMonths(credit.activatedAt);
      if (credit.ageBoundAt !== undefined) {
        sixCalendarMonths(credit.ageBoundAt);
        if (credit.activatedAt === null || credit.ageBoundAt > credit.activatedAt || credit.protection !== null) throw new Error("credit age bound");
      }
      paid += quantity(credit.paid);
      outstanding += remaining(credit);
    }
    if (paid !== quantity(pair.paid) || outstanding !== (quantity(pair.activeAmount) > paid ? quantity(pair.activeAmount) - paid : 0n)) throw new Error("ledger conservation");
  }
}

export function syncExpiryClaims(ledger: Ledger, claims: Record<string, string>): Ledger {
  const result = structuredClone(ledger);
  for (const [key, pair] of Object.entries(result.pairs)) {
    if (claims[key] === undefined) throw new Error(`missing claimed input ${key}`);
    const paid = quantity(claims[key]);
    let delta = paid - quantity(pair.paid);
    if (delta < 0n) throw new Error("claim state went backwards; replay canonical journal");
    const credits = [...pair.credits];
    if (ledger.distributor === EXTRA_REWARDS_DISTRIBUTOR) {
      credits.sort((a, b) => Number(a.protection !== null) - Number(b.protection !== null));
    }
    for (const credit of credits) {
      const consumed = remaining(credit) < delta ? remaining(credit) : delta;
      credit.paid = (quantity(credit.paid) + consumed).toString();
      delta -= consumed;
    }
    if (delta !== 0n) throw new Error("claims exceed recorded entitlement");
    pair.paid = paid.toString();
  }
  assertExpiryLedger(result);
  return result;
}

export function bootstrapExpiryLedger(
  chainId: number,
  publications: Publication[],
  claims: Record<string, string>,
  checkpoint: Ledger["checkpoint"],
  unresolvedUnion: { root: string | null; amounts: Record<string, string>; ageBound?: UnionAgeBound } | null = null,
  distributor = EXPIRY_DISTRIBUTOR
): Ledger {
  if (!publications.length || !/^0x0{64}$/i.test(publications[0].root)) throw new Error("missing deployment publication");
  const ledger: Ledger = { version: 1, chainId, distributor, root: "", checkpoint, pairs: {}, recoveries: [], runs: {} };
  let complete = true;
  let previousBlock = -1;
  for (const publication of publications) {
    if (publication.block < previousBlock || publication.block > checkpoint.block) throw new Error("publication order");
    previousBlock = publication.block;
    if (/^0x0{64}$/i.test(publication.root)) continue;
    if (!publication.merkle) { complete = false; ledger.root = publication.root; continue; }
    if (publication.merkle.merkleRoot.toLowerCase() !== publication.root.toLowerCase()) throw new Error("publication artifact mismatch");
    const distribution = verifyExpiryParent(publication.merkle);
    const active = new Map<string, { account: string; token: string; amount: string }>();
    for (const [account, tokens] of Object.entries(distribution)) {
      for (const [token, amount] of Object.entries(tokens)) active.set(expiryKey(account, token), { account, token, amount });
    }
    for (const key of new Set([...Object.keys(ledger.pairs), ...active.keys()])) {
      const leaf = active.get(key);
      const pair = ledger.pairs[key] ??= { account: leaf!.account, token: leaf!.token, activeAmount: "0", paid: "0", credits: [] };
      const amount = quantity(leaf?.amount ?? "0");
      const previous = quantity(pair.activeAmount);
      if (!complete || amount < previous) {
        pair.credits = amount === 0n ? [] : [{ id: utils.id(`${publication.root}:${key}:opening`), root: publication.root, granted: amount.toString(), paid: "0", recovered: "0", activatedAt: null, protection: "unresolved history" }];
      } else if (amount > previous) {
        const delta = amount - previous;
        const eligible = distributor === EXTRA_REWARDS_DISTRIBUTOR ? quantity(publication.vmRewards?.[key] ?? "0") : delta;
        if (eligible > delta) throw new Error("VM rewards exceed publication");
        for (const [granted, protection] of [[eligible, null], [delta - eligible, "non-VM or unknown source"]] as const) {
          if (granted === 0n) continue;
          pair.credits.push({ id: utils.id(`${publication.root}:${key}:${pair.credits.length}`), root: publication.root, granted: granted.toString(), paid: "0", recovered: "0", activatedAt: publication.timestamp, protection });
        }
      }
      pair.activeAmount = amount.toString();
    }
    ledger.root = publication.root;
    complete = true;
  }
  if (!complete || !ledger.root) throw new Error("active root artifact unresolved");
  const bound = unresolvedUnion?.ageBound;
  const boundedTokens = new Set<string>();
  if (bound) {
    const account = getAddress(bound.account);
    const witness = publications.findIndex(publication => Object.entries(bound.witness).every(([key, value]) => publication[key as keyof Publication] === value));
    const assigned = publications.findIndex(publication => publication.root === unresolvedUnion.root);
    if (chainId !== 1 || witness < 0 || assigned <= witness) throw new Error("Union age witness");
    if (bound.roots.length < assigned - witness + 1 || JSON.stringify(publications.slice(witness, witness + bound.roots.length).map(publication => publication.root)) !== JSON.stringify(bound.roots)) throw new Error("Union age history sequence");
    for (const [token, amount] of Object.entries(bound.amounts)) {
      const reward = getAddress(token);
      const total = Object.entries(unresolvedUnion.amounts).filter(([key]) => key.endsWith(`:${reward.toLowerCase()}`)).reduce((sum, [, value]) => sum + quantity(value), 0n);
      if (quantity(amount) === 0n || total !== quantity(amount) || claims[expiryKey(account, reward)] !== "0") throw new Error("Union age allocation or claimed source");
      for (let i = witness; i < publications.length; ++i) {
        const publication = publications[i];
        if (!publication.merkle) throw new Error("Union age history gap");
        const original = quantity(publication.merkle.claims[account]?.tokens[reward]?.amount ?? "0");
        if (original !== (i < assigned ? quantity(amount) : 0n)) throw new Error("Union age original pot changed");
      }
      boundedTokens.add(reward);
    }
  }
  for (const key of Object.keys(claims)) {
    if (ledger.pairs[key]) continue;
    const [account, token] = key.split(":");
    if (expiryKey(account, token) !== key) throw new Error("claimed pair key");
    ledger.pairs[key] = { account: getAddress(account), token: getAddress(token), activeAmount: "0", paid: "0", credits: [] };
  }
  for (const [key, pair] of Object.entries(ledger.pairs)) {
    if (claims[key] === undefined) throw new Error(`missing claimed input ${key}`);
    const paid = quantity(claims[key]);
    const granted = pair.credits.reduce((total, credit) => total + quantity(credit.granted), 0n);
    if (paid > granted) {
      pair.credits.unshift({ id: utils.id(`${ledger.root}:${key}:paid-offset`), root: ledger.root, granted: (paid - granted).toString(), paid: "0", recovered: "0", activatedAt: null, protection: "lifetime paid offset" });
    }
    let union = quantity(unresolvedUnion?.amounts[key] ?? "0");
    const sourceCredits = pair.credits.filter(credit => credit.root.toLowerCase() === unresolvedUnion?.root?.toLowerCase());
    if (union > 0n && sourceCredits.reduce((total, credit) => total + quantity(credit.granted), 0n) < union) {
      for (const credit of pair.credits) credit.protection = "unresolved Union provenance";
      continue;
    }
    for (let i = pair.credits.length - 1; i >= 0 && union > 0n; --i) {
      const credit = pair.credits[i];
      if (credit.root.toLowerCase() !== unresolvedUnion?.root?.toLowerCase() || credit.protection !== null) continue;
      const protectedAmount = quantity(credit.granted) < union ? quantity(credit.granted) : union;
      union -= protectedAmount;
      if (protectedAmount === quantity(credit.granted)) {
        credit.protection = boundedTokens.has(pair.token) ? null : "unresolved Union ageing";
        if (boundedTokens.has(pair.token)) credit.ageBoundAt = bound!.witness.timestamp;
      }
      else {
        credit.granted = (quantity(credit.granted) - protectedAmount).toString();
        pair.credits.splice(i + 1, 0, { ...credit, id: utils.id(`${credit.id}:union`), granted: protectedAmount.toString(), protection: boundedTokens.has(pair.token) ? null : "unresolved Union ageing", ...(boundedTokens.has(pair.token) ? { ageBoundAt: bound!.witness.timestamp } : {}) });
      }
    }
  }
  return syncExpiryClaims(ledger, claims);
}

export function expiryFrontier(distribution: UniversalMerkle, token: string, treasury: string, rows: { account: string }[]) {
  const affected = new Set(rows.map(row => getAddress(row.account)));
  type Node = { hash: string; affected: boolean; op: number; left?: Node; right?: Node };
  let layer: Node[] = Object.entries(distribution).flatMap(([account, tokens]) => Object.entries(tokens).map(([reward, amount]) => ({
    hash: utils.keccak256(utils.arrayify(utils.keccak256(utils.defaultAbiCoder.encode(["address", "address", "uint256"], [account, reward, amount])))),
    affected: reward === token && (affected.has(getAddress(account)) || account === treasury), op: account === treasury ? 2 : 1,
  })));
  while (layer.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i], right = layer[i + 1];
      next.push(right ? { hash: utils.keccak256(utils.concat(left.hash < right.hash ? [left.hash, right.hash] : [right.hash, left.hash])), affected: left.affected || right.affected, op: 3, left, right } : left);
    }
    layer = next;
  }
  const program: number[] = [];
  const nodes: string[] = [];
  const visit = (node: Node) => {
    if (!node.affected) { program.push(0); nodes.push(node.hash); }
    else if (node.left && node.right) { visit(node.left); visit(node.right); program.push(3); }
    else program.push(node.op);
  };
  visit(layer[0]);
  if (program.length > 4096) throw new Error("frontier exceeds module bound");
  return { program: utils.hexlify(program), nodes };
}

export function isEligibleForExpiry(credit: Credit, at: number): boolean {
  if (remaining(credit) <= 0n) return false;
  if (credit.protection !== null) return false;
  if (credit.activatedAt === null) return false;

  const ageStartsAt = credit.ageBoundAt ?? credit.activatedAt;
  return sixCalendarMonths(ageStartsAt) <= at;
}

function expiryParent(distribution: UniversalMerkle, root: string): MerkleData {
  const claims = Object.fromEntries(Object.entries(distribution).map(([account, tokens]) => [account, { tokens: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, { amount, proof: [] }])) }]));
  return { merkleRoot: root, claims };
}

export function prepareExpiry(
  state: Ledger,
  parent: MerkleData,
  policy: ExpiryPolicy | null,
  token: string,
  round: number,
  index: number,
  at: number,
  module: PreparedExpiry["module"],
  limit = 64
): PreparedExpiry | null {
  assertExpiryLedger(state);
  const distribution = verifyExpiryParent(parent);
  if (state.root.toLowerCase() !== parent.merkleRoot.toLowerCase()) throw new Error("ledger parent mismatch");
  if (!policy) return null;
  const effectiveAt = expiryEffectiveAt(policy);
  if (effectiveAt === null || at < effectiveAt) return null;
  if (!Number.isSafeInteger(round) || round <= 0 || !Number.isSafeInteger(index) || index < 0 || limit < 1 || limit > 64) throw new Error("batch identity");
  const run = state.runs[String(round)];
  if (run?.complete) return null;
  if (index !== (run?.nextBatch ?? 0)) throw new Error("ledger batch sequence");
  const processed = new Set(run?.processed ?? []);
  const treasury = getAddress(policy.treasury);
  const reward = getAddress(token);
  if (treasury === getAddress("0x0000000000000000000000000000000000000000") || treasury === state.distributor) throw new Error("treasury target");
  const treasuryAmount = distribution[treasury]?.[reward];
  if (treasuryAmount === undefined) return null;
  const rows: ExpiryBatch["rows"] = [];
  const credits: Record<string, string[]> = {};
  let more = false;
  for (const [account, tokens] of Object.entries(distribution)) {
    if (account === treasury || tokens[reward] === undefined) continue;
    const key = expiryKey(account, reward);
    if (processed.has(key)) continue;
    const pair = state.pairs[key];
    if (!pair || pair.activeAmount !== tokens[reward]) throw new Error("ledger entitlement mismatch");
    const eligible = pair.credits.filter(credit => isEligibleForExpiry(credit, at));
    const amount = eligible.reduce((total, credit) => total + remaining(credit), 0n);
    if (amount === 0n) continue;
    if (rows.length === limit) { more = true; continue; }
    rows.push({ account, amount: tokens[reward], expiredThrough: (quantity(pair.paid) + amount).toString() });
    credits[key] = eligible.map(credit => credit.id);
  }
  for (const [key, pair] of Object.entries(state.pairs)) {
    if (pair.account === treasury || pair.token === reward || processed.has(key)) continue;
    if (pair.credits.some(credit => isEligibleForExpiry(credit, at) && remaining(credit) > 0n)) more = true;
  }
  if (!rows.length) return null;
  if (getAddress(module.address) === getAddress("0x0000000000000000000000000000000000000000") || !Number.isSafeInteger(module.delay) || module.delay <= 0) throw new Error("module deployment");
  getAddress(module.safe);
  getAddress(module.preparer);
  const batch: ExpiryBatch = { round, index, last: !more, ledger: "", parent: parent.merkleRoot, token: reward, treasuryAmount, rows, ...expiryFrontier(distribution, reward, treasury, rows) };
  const prepared: PreparedExpiry = { chainId: state.chainId, distributor: state.distributor, treasury, at, policy, state: structuredClone(state), parent: expiryParent(distribution, parent.merkleRoot), credits, batch, module };
  batch.ledger = utils.sha256(utils.toUtf8Bytes(JSON.stringify({ ...prepared, batch: { ...batch, ledger: "" } })));
  return prepared;
}

export function expiryCommitment(batch: Pick<ExpiryBatch, "round" | "index" | "last" | "token" | "rows">): string {
  return utils.keccak256(utils.defaultAbiCoder.encode(
    ["uint256", "uint256", "bool", "address", "tuple(address account,uint256 amount,uint256 expiredThrough)[]"],
    [batch.round, batch.index, batch.last, batch.token, batch.rows]
  ));
}

export function expiryPlanDigest(input: Pick<PreparedRound, "chainId" | "module" | "distributor" | "treasury" | "plan">): string {
  return utils.keccak256(utils.defaultAbiCoder.encode(
    ["uint256", "address", "address", "address", "address", "uint256", "tuple(uint256 round,uint256 index,bytes32 parent,bytes32[] batches)"],
    [input.chainId, input.module.address, input.distributor, input.module.safe, input.treasury, input.module.delay, input.plan]
  ));
}

export function prepareExpiryRound(state: Ledger, parent: MerkleData, policy: ExpiryPolicy, round: number, at: number, module: PreparedExpiry["module"], limit = 64, prices?: PreparedRound["prices"]): PreparedRound | null {
  assertExpiryLedger(state);
  const distribution = verifyExpiryParent(parent);
  if (state.root !== parent.merkleRoot) throw new Error("ledger parent mismatch");
  const effectiveAt = expiryEffectiveAt(policy);
  if (effectiveAt === null || at < effectiveAt) return null;
  const run = state.runs[String(round)];
  if (run?.complete) return null;
  if (!Number.isSafeInteger(round) || round <= 0 || limit < 1 || limit > 64) throw new Error("batch identity");
  const treasury = getAddress(policy.treasury);
  if (treasury === getAddress("0x0000000000000000000000000000000000000000") || treasury === state.distributor) throw new Error("treasury target");
  if (getAddress(module.address) === getAddress("0x0000000000000000000000000000000000000000") || !Number.isSafeInteger(module.delay) || module.delay <= 0) throw new Error("module deployment");
  getAddress(module.safe);
  getAddress(module.preparer);
  const first = run?.nextBatch ?? 0;
  const processed = new Set(run?.processed ?? []);
  const batches: PreparedRound["batches"] = [];
  const tokens = [...new Set(Object.values(distribution).flatMap(rewards => Object.keys(rewards)))];
  for (const token of tokens) {
    const price = prices?.[token];
    if (prices && !price) continue;
    const start = batches.length;
    let total = 0n;
    let selected: PreparedRound["batches"][number] | undefined;
    for (const [account, rewards] of Object.entries(distribution)) {
      const key = expiryKey(account, token);
      if (account === treasury || rewards[token] === undefined || processed.has(key)) continue;
      const pair = state.pairs[key];
      if (!pair || pair.activeAmount !== rewards[token]) throw new Error("ledger entitlement mismatch");
      const eligible = pair.credits.filter(credit => isEligibleForExpiry(credit, at));
      const amount = eligible.reduce((sum, credit) => sum + remaining(credit), 0n);
      if (amount === 0n) continue;
      total += amount;
      if (!selected || selected.rows.length === limit) {
        selected = { round, index: first + batches.length, last: false, token, rows: [], credits: {} };
        batches.push(selected);
      }
      selected.rows.push({ account, amount: rewards[token], expiredThrough: (quantity(pair.paid) + amount).toString() });
      selected.credits[key] = eligible.map(credit => credit.id);
    }
    if (price) {
      if (!Number.isInteger(price.decimals) || price.decimals < 0 || price.decimals > 255) throw new Error("expiry token decimals");
      const usd = BigInt(utils.parseUnits(price.usd, 18).toString());
      if (usd <= 0n || total * usd < 100n * 10n ** BigInt(price.decimals) * 10n ** 18n) {
        batches.splice(start);
        continue;
      }
    }
    if (batches.length > start && distribution[treasury]?.[token] === undefined) return null;
  }
  if (!batches.length) return null;
  batches[batches.length - 1].last = true;
  return { chainId: state.chainId, distributor: state.distributor, treasury, at, policy, state: structuredClone(state), parent: expiryParent(distribution, parent.merkleRoot),
    module, ...(prices ? { prices } : {}), batches, plan: { round, index: first, parent: parent.merkleRoot, batches: batches.map(expiryCommitment) } };
}

export function preparePlannedExpiry(state: Ledger, parent: MerkleData, plan: PreparedRound, index: number): PreparedExpiry {
  assertExpiryLedger(state);
  const distribution = verifyExpiryParent(parent);
  const selected = plan.batches[index - plan.plan.index];
  const run = state.runs[String(plan.plan.round)];
  if (!selected || selected.index !== index || run?.complete || index !== (run?.nextBatch ?? 0) || state.root !== parent.merkleRoot || state.chainId !== plan.chainId || state.distributor !== plan.distributor || expiryCommitment(selected) !== plan.plan.batches[index - plan.plan.index]) throw new Error("expiry round batch mismatch");
  for (const row of selected.rows) {
    if (distribution[row.account]?.[selected.token] !== row.amount || run?.processed.includes(expiryKey(row.account, selected.token))) throw new Error("expiry round entitlement changed");
  }
  const { credits, ...committed } = selected;
  const treasury = getAddress(plan.treasury);
  const treasuryAmount = distribution[treasury]?.[selected.token];
  if (treasuryAmount === undefined) throw new Error("expiry treasury missing");
  const batch = { ...committed, ledger: "", parent: parent.merkleRoot, treasuryAmount, ...expiryFrontier(distribution, selected.token, treasury, selected.rows) };
  const input: PreparedExpiry = { plan: expiryPlanDigest(plan), chainId: state.chainId, distributor: state.distributor, treasury, at: plan.at, policy: plan.policy, state: structuredClone(state), parent: expiryParent(distribution, parent.merkleRoot), credits, batch, module: plan.module };
  batch.ledger = utils.sha256(utils.toUtf8Bytes(JSON.stringify(input)));
  return input;
}

export function expiryDigest(prepared: PreparedExpiry): string {
  return utils.keccak256(utils.defaultAbiCoder.encode(
    ["uint256", "address", "address", "address", "address", "uint256", "tuple(uint256 round,uint256 index,bool last,bytes32 ledger,bytes32 parent,address token,uint256 treasuryAmount,tuple(address account,uint256 amount,uint256 expiredThrough)[] rows,bytes program,bytes32[] nodes)"],
    [prepared.chainId, prepared.module.address, prepared.distributor, prepared.module.safe, prepared.treasury, prepared.module.delay, prepared.batch]
  ));
}

export function recordExpiryDistribution(ledger: Ledger, publication: Publication, rewards: Record<string, string>, claims: Record<string, string>, vmRewards: Record<string, string> = {}): Ledger {
  assertExpiryLedger(ledger);
  if (!publication.merkle || publication.root.toLowerCase() !== publication.merkle.merkleRoot.toLowerCase() || publication.block < ledger.checkpoint.block || (publication.block === ledger.checkpoint.block && (publication.logIndex ?? 0) <= (ledger.checkpoint.logIndex ?? Number.MAX_SAFE_INTEGER))) throw new Error("distribution activation");
  const distribution = verifyExpiryParent(publication.merkle);
  const result = syncExpiryClaims(ledger, claims);
  const active = new Map<string, { account: string; token: string; amount: string }>();
  for (const [account, tokens] of Object.entries(distribution)) {
    for (const [token, amount] of Object.entries(tokens)) active.set(expiryKey(account, token), { account, token, amount });
  }
  for (const key of new Set([...Object.keys(result.pairs), ...active.keys(), ...Object.keys(rewards)])) {
    const leaf = active.get(key);
    if (!result.pairs[key] && !leaf) throw new Error("reward leaf missing");
    const pair = result.pairs[key] ??= { account: leaf!.account, token: leaf!.token, activeAmount: "0", paid: "0", credits: [] };
    const delta = quantity(rewards[key] ?? "0");
    const cumulative = pair.credits.reduce((total, credit) => total + quantity(credit.granted) - quantity(credit.recovered), 0n);
    if (leaf) {
      const unchangedPaid = delta === 0n && leaf.amount === pair.activeAmount && quantity(pair.activeAmount) <= quantity(pair.paid);
      if (quantity(leaf.amount) !== cumulative + delta && !unchangedPaid) throw new Error("fresh rewards do not explain cumulative change");
      const eligible = ledger.distributor === EXTRA_REWARDS_DISTRIBUTOR ? quantity(vmRewards[key] ?? "0") : delta;
      if (eligible > delta) throw new Error("VM rewards exceed distribution");
      for (const [amount, protection] of [[eligible, null], [delta - eligible, "non-VM or unknown source"]] as const) {
        if (amount === 0n) continue;
        pair.credits.push({ id: utils.id(`${publication.root}:${key}:${pair.credits.length}`), root: publication.root, granted: amount.toString(), paid: "0", recovered: "0", activatedAt: publication.timestamp, protection });
      }
      pair.activeAmount = leaf.amount;
    } else {
      if (delta !== 0n || claims[key] === undefined || quantity(claims[key]) < cumulative) throw new Error("distribution removes an open entitlement");
      pair.activeAmount = "0";
    }
  }
  const updated = syncExpiryClaims(result, claims);
  updated.root = publication.root;
  updated.lastDistributionAt = publication.timestamp;
  updated.checkpoint = { block: publication.block, blockHash: publication.blockHash, ...(publication.logIndex === undefined ? {} : { logIndex: publication.logIndex }) };
  return updated;
}

export function applyConfirmedExpiry(current: Ledger, prepared: PreparedExpiry, activation: ConfirmedExpiry): { ledger: Ledger; merkle: MerkleData } {
  const { batch } = prepared;
  const commitment = utils.sha256(utils.toUtf8Bytes(JSON.stringify({ ...prepared, batch: { ...batch, ledger: "" } })));
  if (commitment !== batch.ledger || activation.digest !== expiryDigest(prepared) || activation.parent.toLowerCase() !== batch.parent.toLowerCase() || activation.rows.length !== batch.rows.length) throw new Error("activation inputs");
  const identity = `${activation.transactionHash.toLowerCase()}:${activation.logIndex}`;
  assertExpiryLedger(current);
  if (current.recoveries.includes(identity) || activation.block < current.checkpoint.block || (activation.block === current.checkpoint.block && activation.logIndex <= (current.checkpoint.logIndex ?? Number.MAX_SAFE_INTEGER)) || current.root !== batch.parent || current.chainId !== prepared.chainId || current.distributor !== prepared.distributor) throw new Error("replayed or stale activation");
  const distribution = verifyExpiryParent(prepared.parent);
  const observed = Object.fromEntries(Object.entries(current.pairs).map(([key, pair]) => [key, pair.paid]));
  const reductions = new Map<string, ConfirmedExpiry["rows"][number]>();
  for (const row of activation.rows) {
    const key = expiryKey(row.account, row.token);
    if (getAddress(row.token) !== batch.token || reductions.has(key)) throw new Error("activation rows");
    reductions.set(key, row);
    observed[key] = row.paid;
  }
  const ledger = syncExpiryClaims(current, observed);
  let total = 0n;
  for (const row of batch.rows) {
    const key = expiryKey(row.account, batch.token);
    const actual = reductions.get(key);
    if (!actual) throw new Error("missing actual reduction");
    const paid = quantity(actual.paid);
    const expected = quantity(row.expiredThrough) > paid ? quantity(row.expiredThrough) - paid : 0n;
    if (quantity(actual.amount) !== expected || paid > quantity(row.amount)) throw new Error("live recovery mismatch");
    let left = expected;
    const ids = new Set(prepared.credits[key]);
    for (const credit of ledger.pairs[key].credits) {
      if (!ids.has(credit.id)) continue;
      const consumed = remaining(credit) < left ? remaining(credit) : left;
      credit.recovered = (quantity(credit.recovered) + consumed).toString();
      left -= consumed;
    }
    if (left !== 0n) throw new Error("recovery exceeds committed eligible credits");
    const amount = (quantity(row.amount) - expected).toString();
    distribution[getAddress(row.account)][batch.token] = amount;
    ledger.pairs[key].activeAmount = amount;
    total += expected;
  }
  if (total !== quantity(activation.recovered)) throw new Error("treasury conservation");
  const treasuryKey = expiryKey(prepared.treasury, batch.token);
  const treasury = ledger.pairs[treasuryKey];
  if (!treasury || treasury.activeAmount !== batch.treasuryAmount) throw new Error("treasury ledger missing");
  treasury.activeAmount = (quantity(batch.treasuryAmount) + total).toString();
  if (total > 0n) treasury.credits.push({ id: utils.id(identity), root: activation.root, granted: total.toString(), paid: "0", recovered: "0", activatedAt: activation.timestamp, protection: "treasury recovery" });
  distribution[prepared.treasury][batch.token] = treasury.activeAmount;
  const merkle = generateMerkleTree(distribution);
  if (merkle.merkleRoot.toLowerCase() !== activation.root.toLowerCase()) throw new Error("actual root reconstruction mismatch");
  ledger.root = merkle.merkleRoot;
  ledger.checkpoint = { block: activation.block, blockHash: activation.blockHash, logIndex: activation.logIndex };
  ledger.recoveries.push(identity);
  const run = ledger.runs[String(batch.round)];
  if (run?.complete || batch.index !== (run?.nextBatch ?? 0)) throw new Error("confirmed batch sequence");
  const processed = [...(run?.processed ?? [])];
  for (const row of batch.rows) {
    const key = expiryKey(row.account, batch.token);
    if (processed.includes(key)) throw new Error("overlapping confirmed rows");
    processed.push(key);
  }
  ledger.runs[String(batch.round)] = { nextBatch: batch.index + 1, complete: batch.last, processed };
  assertExpiryLedger(ledger);
  return { ledger, merkle };
}

export function writeExpiryInput(file: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    try { fs.linkSync(temporary, file); }
    catch (error: any) {
      if (error.code !== "EEXIST" || JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(value)) throw error;
    }
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(temporary);
  }
}
