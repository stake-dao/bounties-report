import assert from "node:assert/strict";
import { getAddress, keccak256, toHex } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { assertExpiryLedger, Credit, expiryEffectiveAt, expiryKey, ExpiryPolicy, Ledger, Publication, sixCalendarMonths, syncExpiryClaims, verifyExpiryParent } from "../shared/merkle/expiry";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";
import { appendPublication } from "./monthly";
import { EXTRA, RECIPIENT, TREASURY_RECIPIENT, VOTERS } from "./prepare";

const protectedAccounts = new Set([RECIPIENT, TREASURY_RECIPIENT, getAddress("0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063")]);
const quantity = (value: string) => {
  assert(/^\d+$/.test(value) && BigInt(value) < 1n << 256n, "invalid reward quantity");
  return BigInt(value);
};
const remaining = (credit: Credit) => quantity(credit.granted) - quantity(credit.paid) - quantity(credit.recovered);
const eligible = (credit: Credit, at: number) => credit.protection === null && credit.ageBoundAt === undefined && credit.activatedAt !== null && sixCalendarMonths(credit.activatedAt) <= at;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const min = (a: bigint, b: bigint) => a < b ? a : b;
const digest = (value: unknown) => keccak256(toHex(JSON.stringify(value)));

export interface ExpiryNotice {
  version: 1;
  chainId: 1;
  distributor: string;
  treasury: string;
  period: string;
  announcedAt: number;
  notBefore: number;
  policy: ExpiryPolicy;
  ledger: Ledger;
  credits: Record<string, Record<string, string>>;
}

export interface ExpiryCut {
  notice: ExpiryNotice;
  noticeHash: string;
  preparedAt: number;
  ledger: Ledger;
  parent: MerkleData;
  merkle: MerkleData;
  credits: Record<string, Record<string, string>>;
}

export interface AdoptedCut {
  id: string;
  cut: ExpiryCut;
  ledger: Ledger;
  reserve: Record<string, string>;
}

/** This artifact must be published immutably before its notice clock starts. */
export function announceExpiry(ledger: Ledger, policy: ExpiryPolicy, period: string, announcedAt: number): ExpiryNotice {
  assertExpiryLedger(ledger);
  sixCalendarMonths(announcedAt);
  assert(ledger.chainId === 1 && [VOTERS, EXTRA].includes(getAddress(ledger.distributor)), "monthly expiry is Ethereum only");
  assert(getAddress(policy.treasury) === TREASURY_RECIPIENT, "unexpected expiry Treasury");
  assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), "invalid monthly period");
  const effectiveAt = expiryEffectiveAt(policy);
  assert(effectiveAt !== null && announcedAt >= effectiveAt, "initial policy notice incomplete");
  const credits: ExpiryNotice["credits"] = {};
  for (const [key, pair] of Object.entries(ledger.pairs)) {
    if (protectedAccounts.has(getAddress(pair.account))) continue;
    const rows = pair.credits.filter(credit => eligible(credit, announcedAt) && remaining(credit) > 0n);
    if (rows.length) credits[key] = Object.fromEntries(rows.map(credit => [credit.id, remaining(credit).toString()]));
  }
  return structuredClone({ version: 1, chainId: 1, distributor: getAddress(ledger.distributor), treasury: TREASURY_RECIPIENT, period, announcedAt, notBefore: announcedAt + 86400, policy, ledger, credits });
}

/** Rebase the announced credit IDs, never the announcement's old root. */
export function prepareExpiryCut(notice: ExpiryNotice, ledger: Ledger, parent: MerkleData, now: number): ExpiryCut {
  assert.deepEqual(notice, announceExpiry(notice.ledger, notice.policy, notice.period, notice.announcedAt), "notice differs from its proven ledger");
  assert(Number.isSafeInteger(now) && now >= notice.notBefore, "monthly notice not elapsed");
  assertExpiryLedger(ledger);
  assert(ledger.chainId === notice.chainId && ledger.distributor === notice.distributor, "cut target mismatch");
  assert(ledger.checkpoint.block >= notice.ledger.checkpoint.block, "cut predates notice checkpoint");
  assert(ledger.root === parent.merkleRoot, "cut parent mismatch");
  assert(!ledger.recoveries.includes(`monthly:${notice.period}`), "monthly cut already adopted");
  const distribution = verifyExpiryParent(parent);
  for (const [key, pair] of Object.entries(ledger.pairs)) {
    assert.equal(distribution[pair.account]?.[pair.token] ?? "0", pair.activeAmount, `ledger differs from parent: ${key}`);
  }
  for (const [account, tokens] of Object.entries(distribution)) for (const token of Object.keys(tokens)) {
    assert(ledger.pairs[expiryKey(account, token)], "parent leaf absent from ledger");
  }
  const credits: ExpiryCut["credits"] = {};
  for (const [key, allowances] of Object.entries(notice.credits)) {
    const pair = ledger.pairs[key];
    assert(pair, "announced pair lost its history");
    assert(quantity(pair.paid) >= quantity(notice.ledger.pairs[key].paid), "claims went backwards");
    const rows: Record<string, string> = {};
    let reduction = 0n;
    for (const [id, cap] of Object.entries(allowances)) {
      const credit = pair.credits.find(credit => credit.id === id);
      const original = notice.ledger.pairs[key].credits.find(credit => credit.id === id)!;
      assert(credit && credit.root === original.root && credit.granted === original.granted && credit.activatedAt === original.activatedAt && eligible(credit, notice.announcedAt), "announced credit changed provenance");
      const amount = min(quantity(cap), remaining(credit));
      if (amount) { rows[id] = amount.toString(); reduction += amount; }
    }
    if (!reduction) continue;
    assert(reduction <= max(quantity(pair.activeAmount) - quantity(pair.paid), 0n), "cut exceeds open entitlement");
    distribution[pair.account][pair.token] = (quantity(pair.activeAmount) - reduction).toString();
    credits[key] = rows;
  }
  return { notice: structuredClone(notice), noticeHash: digest(notice), preparedAt: now, ledger: structuredClone(ledger), parent, merkle: generateMerkleTree(distribution), credits };
}

/** Call at RootSet in canonical log order: claims AFTER RootSet are not inputs. */
export function adoptExpiryCut(cut: ExpiryCut, claimsBeforeRootSet: Record<string, string>, checkpoint: Ledger["checkpoint"]): AdoptedCut {
  assert.deepEqual(cut, prepareExpiryCut(cut.notice, cut.ledger, cut.parent, cut.preparedAt), "cut artifact changed");
  assert(cut.merkle.merkleRoot !== cut.parent.merkleRoot, "empty cut has no activation");
  assert(checkpoint.block > cut.ledger.checkpoint.block && checkpoint.logIndex !== undefined, "cut activation checkpoint");
  const ledger = syncExpiryClaims(cut.ledger, claimsBeforeRootSet);
  const reserve: Record<string, string> = {};
  for (const [key, allowances] of Object.entries(cut.credits)) {
    const pair = ledger.pairs[key];
    const before = quantity(pair.activeAmount), paid = quantity(pair.paid);
    const reduced = quantity(cut.merkle.claims[pair.account].tokens[pair.token].amount);
    const released = max(before - max(reduced, paid), 0n);
    let left = released;
    for (const credit of pair.credits) {
      const amount = min(left, min(quantity(allowances[credit.id] ?? "0"), remaining(credit)));
      credit.recovered = (quantity(credit.recovered) + amount).toString();
      left -= amount;
    }
    assert(left === 0n, "release exceeds remaining announced credits; check claim ordering");
    pair.activeAmount = reduced.toString();
    reserve[pair.token] = (quantity(reserve[pair.token] ?? "0") + released).toString();
  }
  ledger.root = cut.merkle.merkleRoot;
  ledger.checkpoint = checkpoint;
  ledger.recoveries.push(`monthly:${cut.notice.period}`);
  assertExpiryLedger(ledger);
  return { id: digest({ notice: cut.noticeHash, root: ledger.root, checkpoint }), cut, ledger, reserve };
}

/** The caller supplies ONLY not-yet-published, separately funded ordinary gains. */
export function settleExpiryCut(adopted: AdoptedCut, current: Ledger, claims: Record<string, string>, gains: UniversalMerkle): MerkleData {
  assert(current.root === adopted.ledger.root && current.recoveries.includes(`monthly:${adopted.cut.notice.period}`), "settlement parent not adopted");
  return buildCumulativePublication(current, claims, gains, adopted.reserve);
}

export function buildCumulativePublication(current: Ledger, claims: Record<string, string>, gains: UniversalMerkle, reserve: Record<string, string> = {}): MerkleData {
  const ledger = syncExpiryClaims(current, claims);
  const distribution: UniversalMerkle = {};
  for (const pair of Object.values(ledger.pairs)) {
    distribution[pair.account] ??= {};
    distribution[pair.account][pair.token] = max(quantity(pair.activeAmount), quantity(pair.paid)).toString();
  }
  for (const [account, tokens] of Object.entries(gains)) {
    assert(getAddress(account) === account, "gains account not canonical");
    distribution[account] ??= {};
    for (const [token, amount] of Object.entries(tokens)) {
      assert(getAddress(token) === token, "gains token not canonical");
      const key = expiryKey(account, token);
      assert(claims[key] !== undefined, "new pair claimed offset missing");
      const base = max(quantity(distribution[account][token] ?? "0"), quantity(claims[key]));
      distribution[account][token] = (base + quantity(amount)).toString();
    }
  }
  for (const [token, amount] of Object.entries(reserve)) {
    if (quantity(amount) === 0n) continue;
    const key = expiryKey(TREASURY_RECIPIENT, token);
    assert(claims[key] !== undefined, "Treasury claimed offset missing");
    distribution[TREASURY_RECIPIENT] ??= {};
    const base = max(quantity(distribution[TREASURY_RECIPIENT][token] ?? "0"), quantity(claims[key]));
    distribution[TREASURY_RECIPIENT][token] = (base + quantity(amount)).toString();
  }
  return generateMerkleTree(distribution);
}

/** Normalize paid offsets BEFORE appending gains so normalization never consumes
 * newly earned VM credits or assigns a new age to the already-paid principal. */
export function adoptCumulativePublication(current: Ledger, publication: Publication, claims: Record<string, string>, gains: UniversalMerkle, vmRewards: Record<string, string>, reserve: Record<string, string> = {}): Ledger {
  assert(publication.merkle, "publication artifact missing");
  const expected = buildCumulativePublication(current, claims, gains, reserve);
  assert.equal(expected.merkleRoot, publication.root, "publication differs from normalized gains and realized reserve");
  const ledger = syncExpiryClaims(current, claims);
  for (const [account, tokens] of Object.entries(verifyExpiryParent(expected))) for (const token of Object.keys(tokens)) {
    const key = expiryKey(account, token);
    const paid = quantity(claims[key]);
    const pair = ledger.pairs[key] ??= {
      account, token, activeAmount: paid.toString(), paid: paid.toString(),
      credits: paid ? [{ id: `${publication.root}:${key}:paid-offset`, root: publication.root, granted: paid.toString(), paid: paid.toString(), recovered: "0", activatedAt: null, protection: "lifetime paid offset" }] : [],
    };
    pair.activeAmount = max(quantity(pair.activeAmount), paid).toString();
  }
  for (const [key, value] of Object.entries(vmRewards)) {
    const pair = ledger.pairs[key];
    assert(pair && quantity(value) <= quantity(gains[pair.account]?.[pair.token] ?? "0"), "VM provenance exceeds fresh gains");
  }
  return appendPublication(ledger, publication, vmRewards);
}

/** Balances, claimed counters and unallocated reserves must share one block. */
export function assertExpiryCoverage(tree: MerkleData, claims: Record<string, string>, balances: Record<string, string>, reserves: Record<string, string>) {
  const liabilities: Record<string, bigint> = {};
  for (const [account, tokens] of Object.entries(verifyExpiryParent(tree))) for (const [token, amount] of Object.entries(tokens)) {
    const key = expiryKey(account, token);
    assert(claims[key] !== undefined, "coverage claimed input missing");
    liabilities[token] = (liabilities[token] ?? 0n) + max(quantity(amount) - quantity(claims[key]), 0n);
  }
  for (const token of new Set([...Object.keys(liabilities), ...Object.keys(reserves)])) {
    assert(getAddress(token) === token && balances[token] !== undefined && reserves[token] !== undefined, "coverage reserve or balance missing");
    assert(quantity(balances[token]) >= (liabilities[token] ?? 0n) + quantity(reserves[token]), `unfunded rewards or reserves: ${token}`);
  }
}
