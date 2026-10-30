import assert from "node:assert/strict";
import { concat, encodeFunctionData, encodePacked, getAddress, parseAbi } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { verifyExpiryParent } from "../shared/merkle/expiry";
import { generateMerkleTree } from "../shared/merkle/generateMerkleTree";

export const RECIPIENT = getAddress("0x5DA07af8913A4EAf09E5F569c20138b658906c17");
export const OWNER = getAddress("0xB0552b6860CE5C0202976Db056b5e3Cc4f9CC765");
export const VOTERS = getAddress("0x000000006feeE0b7a0564Cd5CeB283e10347C4Db");
export const EXTRA = getAddress("0xD4898A378eA555595c4E7dbDE722B134a3F346D1");
export const ABI = parseAbi([
  "function root() view returns(bytes32)",
  "function pendingRoot() view returns(bytes32,bytes32,uint256)",
  "function owner() view returns(address)",
  "function recipients(address) view returns(address)",
  "function setRoot(bytes32,bytes32)",
  "function claim(address,address,uint256,bytes32[]) returns(uint256)",
]);
// contracts-monorepo/packages/shared/src/distributors/ClaimSnapshotCheck.sol
const CHECK_ABI = parseAbi([
  "function check(uint256,address,bytes32,address,address[],bytes) view",
  "function check(uint256,address,bytes32,address,(address account,address token,uint256 claimed)[]) view",
]);

export interface Review {
  chainId: number;
  distributor: string;
  recipient: string;
  sourceRoot: string;
  sourceFile: string;
  cutoff: number;
  period?: string;
  checkpoint: { block: string; hash: string };
  provenance: string;
  rows: { account: string; token: string; claimed: string; maximum: string }[];
}

export const pairKey = (account: string, token: string) => `${getAddress(account)}:${getAddress(token)}`;
const quantity = (value: string) => {
  assert(/^\d+$/.test(value), "invalid integer amount");
  const amount = BigInt(value);
  assert(amount < (1n << 256n), "amount exceeds uint256");
  return amount;
};

/** Refresh a reviewed age/provenance allowance, never create a new allowance. */
export function refreshRecovery(review: Review, source: MerkleData, claims: Map<string, bigint>, fundingOffsets: Record<string, bigint> = {}) {
  assert.equal(getAddress(review.recipient), RECIPIENT, "recipient differs from approved DAO Safe");
  assert([1, 8453, 42161].includes(review.chainId), "unsupported recovery chain");
  assert(getAddress(review.distributor) === VOTERS || (review.chainId === 1 && getAddress(review.distributor) === EXTRA), "unsupported distributor");
  assert.equal(source.merkleRoot, review.sourceRoot, "reviewed source root mismatch");
  const distribution = verifyExpiryParent(source);
  const seen = new Set<string>();
  const rows: { account: string; token: string; claimed: string; recovered: string }[] = [];
  const totals: Record<string, bigint> = {};
  for (const row of review.rows) {
    const account = getAddress(row.account), token = getAddress(row.token), key = pairKey(account, token);
    assert(!seen.has(key), "duplicate reviewed pair");
    seen.add(key);
    assert.notEqual(account, RECIPIENT, "recipient cannot be reduced");
    const before = quantity(distribution[account]?.[token] ?? "0");
    const paid = quantity(row.claimed), maximum = quantity(row.maximum);
    assert(paid + maximum <= before, "review exceeds source entitlement");
    const current = claims.get(key);
    assert(current !== undefined && current >= paid, "missing or decreasing claimed amount");
    // Conservatively charge all intervening claims against the reviewed old
    // rewards first. Protected/new rewards can never enlarge this allowance.
    const available = maximum - (current - paid);
    if (available <= 0n) continue;
    assert(before - available >= current, "recovery crosses claimed floor");
    distribution[account][token] = (before - available).toString();
    rows.push({ account, token, claimed: current.toString(), recovered: available.toString() });
    totals[token] = (totals[token] ?? 0n) + available;
  }
  const grossTotals = { ...totals };
  for (const [token, offset] of Object.entries(fundingOffsets)) {
    assert(offset >= 0n && offset <= (totals[token] ?? 0n), "funding deficit exceeds newly recovered rewards");
    // Only the new DAO credit absorbs the missing backing. Existing DAO
    // entitlements and every non-expired entitlement remain untouched.
    totals[token] = (totals[token] ?? 0n) - offset;
  }
  distribution[RECIPIENT] ??= {};
  for (const [token, amount] of Object.entries(totals)) {
    const before = quantity(distribution[RECIPIENT][token] ?? "0");
    assert(before >= (claims.get(pairKey(RECIPIENT, token)) ?? 0n), "recipient claimed offset needs review");
    distribution[RECIPIENT][token] = (before + amount).toString();
  }
  return { merkle: generateMerkleTree(distribution), rows, grossTotals, totals, fundingOffsets };
}

/** Safe Transaction Builder batches execute both CALLs in one MultiSend. */
export function safeBatch(review: Review, recovery: ReturnType<typeof refreshRecovery>, checker: string, createdAt: number) {
  assert(recovery.rows.length, "empty recovery");
  const tokens = Object.keys(recovery.totals);
  const state = [BigInt(review.chainId), getAddress(review.distributor), review.sourceRoot as `0x${string}`, RECIPIENT] as const;
  let check: `0x${string}`;
  if (tokens.length <= 256 && recovery.rows.every(row => BigInt(row.claimed) < (1n << 96n))) {
    const snapshots = concat(recovery.rows.map(row =>
      encodePacked(["address", "uint8", "uint96"], [getAddress(row.account), tokens.indexOf(row.token), BigInt(row.claimed)])));
    check = encodeFunctionData({ abi: CHECK_ABI, functionName: "check", args: [...state, tokens.map(token => getAddress(token)), snapshots] });
  } else {
    const snapshots = recovery.rows.map(row => ({ account: getAddress(row.account), token: getAddress(row.token), claimed: BigInt(row.claimed) }));
    check = encodeFunctionData({ abi: CHECK_ABI, functionName: "check", args: [...state, snapshots] });
  }
  assert((check.length - 2) / 2 < 120000, "split and re-review: Safe batch would approach txpool size limit");
  return {
    version: "1.0", chainId: String(review.chainId), createdAt,
    meta: { name: "Reviewed six-month recovery", createdFromSafeAddress: OWNER, description: "Execute as ONE atomic batch. Owner setRoot bypasses the recovery-root timelock; the normal distribution timelock is unchanged. Recompute/re-sign if the snapshot check fails. Publish the matching reduced baseline after confirmation. DAO credits are net of funding deficits; review gross, offset and net amounts in report.json." },
    transactions: [
      { to: getAddress(checker), value: "0", data: check },
      { to: getAddress(review.distributor), value: "0", data: encodeFunctionData({ abi: ABI, functionName: "setRoot", args: [recovery.merkle.merkleRoot as `0x${string}`, `0x${"0".repeat(64)}`] }) },
    ],
  };
}
