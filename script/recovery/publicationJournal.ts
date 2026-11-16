import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getAddress, parseAbi, PublicClient, zeroHash } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { assertExpiryLedger, expiryKey, Ledger, verifyExpiryParent } from "../shared/merkle/expiry";
import { ABI as RECOVERY_ABI, EXTRA, TREASURY_RECIPIENT, VOTERS } from "./prepare";
import { AdoptedCut, buildCumulativePublication, ExpiryCut, ExpiryNotice } from "./twoPhase";

export const ABI = [...RECOVERY_ABI, ...parseAbi(["function claimed(address,address) view returns(uint256)"])] as const;
export type Pool = "voters-1" | "extra-1";
export const journalPath = (pool: Pool) => `bounties-reports/monthly-expiry/${pool}.json`;
export const poolAddress = (pool: Pool) => pool === "voters-1" ? VOTERS : EXTRA;

export interface PublicationIntent {
  version: 1;
  pool: Pool;
  revision: number;
  kind: "ordinary" | "cut" | "settlement";
  parent: string;
  merkle: MerkleData;
  gains: UniversalMerkle;
  sources: string[];
  // Extra's raw allocations are replayed against the on-chain campaign sender.
  allocations?: { token: { address: string }; distribution: { incentiveId: number }; users: { user: string; amount: string }[] }[];
  reserves: Record<string, string>;
  campaignCount?: string;
  checkpoint: Ledger["checkpoint"];
  ipfsHash: string;
}

export interface PublicationJournal {
  version: 1;
  pool: Pool;
  revision: number;
  ledger: Ledger;
  merkle: MerkleData;
  reserves?: Record<string, string>;
  campaignCount?: string;
  notice?: ExpiryNotice;
  announcement?: { cid: string; alert: string; availableAt: number };
  cut?: ExpiryCut;
  adopted?: AdoptedCut;
  publication?: PublicationIntent;
  lastPublication?: PublicationIntent;
  submission?: { calldata: string };
  execution?: { action: "submit" | "accept" | "revoke"; calldata: string; transaction?: string };
  submitted?: { transaction: string; block: number; blockHash: string; validAt: string; ipfsHash: string };
  cancelRequested?: boolean;
  cancelled?: boolean;
  creditedSources?: string[];
  history: { kind: string; root: string; transaction: string; block: number; blockHash: string; logIndex: number }[];
}

export function assertJournal(state: PublicationJournal) {
  assert(state.version === 1 && ["voters-1", "extra-1"].includes(state.pool), "journal target");
  assert(Number.isSafeInteger(state.revision) && state.revision >= 0, "journal revision");
  assertExpiryLedger(state.ledger);
  assert(state.ledger.chainId === 1 && state.ledger.distributor === poolAddress(state.pool), "journal ledger target");
  verifyExpiryParent(state.merkle);
  assert(state.merkle.merkleRoot === state.ledger.root, "journal active artifact mismatch");
}

export function readJournal(pool: Pool): PublicationJournal | undefined {
  const file = journalPath(pool);
  if (!fs.existsSync(file)) return;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assertJournal(state);
  assert(state.pool === pool, "journal pool mismatch");
  return state;
}

export function writeJournal(state: PublicationJournal) {
  assertJournal(state);
  const file = journalPath(state.pool);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/** Generation holds no remote lock. Its exact revision is compared-and-swapped
 * by the signer before any transaction, including an ordinary publication. */
export async function preparePublication(state: PublicationJournal, gains: UniversalMerkle, reserves: Record<string, string>, client: PublicClient, sources: string[], allocations?: PublicationIntent["allocations"]): Promise<PublicationIntent> {
  assertJournal(state);
  assert(!state.publication && !state.execution && !state.cancelRequested && !state.cancelled, "publication journal requires reconciliation");
  assert(sources.length && new Set(sources).size === sources.length && sources.every(id => !(state.creditedSources ?? []).includes(id)), "reward source already credited");
  assert.equal(await client.getChainId(), 1, "RPC chain mismatch");
  const block = await client.getBlock();
  const address = poolAddress(state.pool);
  assert.equal((await client.getBlock({ blockNumber: BigInt(state.ledger.checkpoint.block) })).hash, state.ledger.checkpoint.blockHash, "journal checkpoint reorged");
  assert.equal(await client.readContract({ address, abi: ABI, functionName: "root", blockNumber: block.number! }), state.ledger.root, "unadopted publication");
  assert.equal((await client.readContract({ address, abi: ABI, functionName: "pendingRoot", blockNumber: block.number! }))[0], zeroHash, "publication already pending");
  const pairs = new Map(Object.values(state.ledger.pairs).map(pair => [expiryKey(pair.account, pair.token), [pair.account, pair.token]]));
  for (const [account, tokens] of Object.entries(gains)) for (const token of Object.keys(tokens)) pairs.set(expiryKey(account, token), [account, token]);
  for (const token of Object.keys(state.adopted?.reserve ?? {})) pairs.set(expiryKey(TREASURY_RECIPIENT, token), [TREASURY_RECIPIENT, token]);
  const entries = [...pairs];
  const claims: Record<string, string> = {};
  for (let i = 0; i < entries.length; i += 150) {
    const chunk = entries.slice(i, i + 150);
    const results = await client.multicall({ contracts: chunk.map(([, [account, token]]) => ({ address, abi: ABI, functionName: "claimed" as const, args: [getAddress(account), getAddress(token)] })), blockNumber: block.number!, allowFailure: false });
    chunk.forEach(([key], j) => { claims[key] = String(results[j]); });
  }
  const merkle = buildCumulativePublication(state.ledger, claims, gains, state.adopted?.reserve);
  assert.equal((await client.getBlock({ blockNumber: block.number! })).hash, block.hash, "publication snapshot reorged");
  return { version: 1, pool: state.pool, revision: state.revision, kind: state.adopted ? "settlement" : "ordinary", parent: state.ledger.root, merkle, gains, sources, ...(allocations ? { allocations } : {}), reserves, checkpoint: { block: Number(block.number), blockHash: block.hash! }, ipfsHash: zeroHash };
}
