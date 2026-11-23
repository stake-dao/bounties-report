import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PublicClient, zeroHash } from "viem";
import { journalPath, preparePublication, PublicationJournal, readJournal, writeJournal } from "../../recovery/publicationJournal";
import { reconcilePublication } from "../../recovery/reconcilePublication";
import { announceExpiry, adoptExpiryCut, assertExpiryCoverage, prepareExpiryCut, settleExpiryCut } from "../../recovery/twoPhase";
import { appendPublication } from "../../recovery/monthly";
import { EXTRA, RECIPIENT, TREASURY_RECIPIENT, VOTERS } from "../../recovery/prepare";
import { expiryKey, Ledger, sixCalendarMonths, syncExpiryClaims } from "../../shared/merkle/expiry";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x3333333333333333333333333333333333333333";
const T = "0x2222222222222222222222222222222222222222";
const U = "0x4444444444444444444444444444444444444444";
const key = expiryKey(A, T), treasuryKey = expiryKey(TREASURY_RECIPIENT, T);
const old = Date.parse("2026-03-31T12:00:00Z") / 1000;
const at = sixCalendarMonths(old);
const checkpoint = { block: 4, blockHash: zeroHash, logIndex: 2 };
const policy = { treasury: TREASURY_RECIPIENT, approval: { reference: "test policy", passedAt: old }, notices: [{ url: "https://gov.stakedao.org/t/test", announcedAt: old }, { url: "https://stakedao.org/test", announcedAt: old }] };

function fixture(distributor = VOTERS) {
  const empty: Ledger = { version: 1, chainId: 1, distributor, root: zeroHash, checkpoint: { block: 1, blockHash: zeroHash }, pairs: {}, recoveries: [], runs: {} };
  const first = generateMerkleTree({ [A]: { [T]: "30" }, [B]: { [U]: "11" }, [RECIPIENT]: { [T]: "7" } });
  const ledger = appendPublication(empty, { root: first.merkleRoot, merkle: first, block: 2, blockHash: zeroHash, logIndex: 0, timestamp: old }, { [key]: "30" });
  const parent = generateMerkleTree({ [A]: { [T]: "100" }, [B]: { [U]: "11" }, [RECIPIENT]: { [T]: "7" } });
  const next = appendPublication(ledger, { root: parent.merkleRoot, merkle: parent, block: 3, blockHash: zeroHash, logIndex: 0, timestamp: at - 1 }, { [key]: "70" });
  const claims = { [key]: "0", [expiryKey(B, U)]: "0", [expiryKey(RECIPIENT, T)]: "0", [treasuryKey]: "0", [expiryKey(TREASURY_RECIPIENT, U)]: "0" };
  const notice = announceExpiry(next, policy, "2026-09", at);
  return { parent, ledger: next, claims, notice, cut: prepareExpiryCut(notice, next, parent, at + 86400) };
}

describe("module-free monthly expiry", () => {
  it("retains the exact cut across publisher restarts and rejects a changed frozen input", () => {
    const { ledger, parent: merkle, notice, cut } = fixture();
    const state: PublicationJournal = { version: 1, revision: 1, pool: "voters-1", ledger, merkle, notice, cut, history: [] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-journal-")), cwd = process.cwd();
    try {
      process.chdir(dir);
      writeJournal(state);
      const wire = JSON.parse(fs.readFileSync(journalPath(state.pool), "utf8"));
      expect(wire.cut.merkle).toEqual(cut.merkle); // The independent signer reads this without loading snapshots.
      expect(readJournal(state.pool)).toEqual(state);
      const file = path.join(path.dirname(journalPath(state.pool)), "cuts", state.pool, `${wire.cut.snapshot}.json`);
      fs.appendFileSync(file, " ");
      expect(() => readJournal(state.pool)).toThrow("cut snapshot changed");
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cuts only announced credits, keeps protections and requires both notices", () => {
    const { parent, ledger, notice, cut } = fixture(EXTRA);
    expect(cut.merkle.claims[A].tokens[T].amount).toBe("70");
    expect(cut.merkle.claims[RECIPIENT]).toEqual(expect.objectContaining({ tokens: expect.objectContaining({ [T]: expect.objectContaining({ amount: "7" }) }) }));
    expect(cut.merkle.claims[B].tokens[U].amount).toBe("11");
    expect(cut.merkle.claims[TREASURY_RECIPIENT]).toBeUndefined();
    expect(() => prepareExpiryCut(notice, ledger, parent, notice.notBefore - 1)).toThrow("notice not elapsed");
    expect(() => announceExpiry(ledger, policy, "2026-09", old + 30 * 86400 - 1)).toThrow("initial policy notice");
    const changed = structuredClone(notice);
    changed.credits[key][Object.keys(changed.credits[key])[0]] = "31";
    expect(() => prepareExpiryCut(changed, ledger, parent, changed.notBefore)).toThrow("notice differs");
    const bounded = structuredClone(ledger);
    bounded.pairs[key].credits[0].ageBoundAt = old;
    expect(announceExpiry(bounded, policy, "2026-09", at).credits[key]).toBeUndefined();
  });

  it("rebases onto an ordinary publication during notice without adding newly eligible credits", () => {
    const { parent, ledger, notice, claims } = fixture();
    const next = generateMerkleTree({ [A]: { [T]: "109" }, [B]: { [U]: "11" }, [RECIPIENT]: { [T]: "7" } });
    const advanced = appendPublication(ledger, { root: next.merkleRoot, merkle: next, block: 4, blockHash: zeroHash, logIndex: 1, timestamp: at + 100 });
    const cut = prepareExpiryCut(notice, advanced, next, sixCalendarMonths(at));
    expect(cut.merkle.claims[A].tokens[T].amount).toBe("79");
    expect(() => prepareExpiryCut(notice, advanced, parent, notice.notBefore)).toThrow("parent mismatch");
    const paid = syncExpiryClaims(advanced, { ...claims, [key]: "109" });
    expect(prepareExpiryCut(notice, paid, next, notice.notBefore).credits[key]).toBeUndefined();
  });

  it.each([false, true])("preserves fresh rewards with claimBeforeCut=%s and never pays Treasury twice", claimedBefore => {
    const { cut, claims } = fixture(EXTRA);
    claims[key] = claimedBefore ? "100" : "0";
    const adopted = adoptExpiryCut(cut, claims, checkpoint);
    expect(adopted.reserve[T]).toBe(claimedBefore ? "0" : "30");
    // A post-cut claim pays the retained 70, not the expired credit. This order
    // matters to credit ages even though the total release is time-independent.
    if (!claimedBefore) claims[key] = "70";
    const current = syncExpiryClaims(adopted.ledger, claims);
    expect(current.pairs[key].credits.map(c => c.recovered)).toEqual(claimedBefore ? ["0", "0"] : ["30", "0"]);
    const gains = { [A]: { [T]: "5" } };
    const settled = settleExpiryCut(adopted, current, claims, gains);
    expect(settled.claims[A].tokens[T].amount).toBe(claimedBefore ? "105" : "75");
    expect(settled.claims[TREASURY_RECIPIENT]?.tokens[T]?.amount ?? "0").toBe(claimedBefore ? "0" : "30");
    const balance = claimedBefore ? "12" : "42"; // 7 protected + 5 new + realized release.
    expect(() => assertExpiryCoverage(settled, claims, { [T]: balance, [U]: "11" }, { [T]: "0", [U]: "0" })).not.toThrow();
    expect(settleExpiryCut(adopted, current, claims, gains)).toEqual(settled);
    const published = appendPublication(current, { root: settled.merkleRoot, merkle: settled, block: 5, blockHash: zeroHash, timestamp: at + 90000 }, { [key]: "5" });
    expect(() => settleExpiryCut(adopted, published, claims, gains)).toThrow("parent not adopted");
    expect(() => prepareExpiryCut(cut.notice, adopted.ledger, cut.merkle, at + 90000)).toThrow("already adopted");
  });

  it("cannot mask liabilities with overclaimed leaves, future debts, other tokens or reserved campaign funds", () => {
    const tree = generateMerkleTree({ [A]: { [T]: "70" }, [B]: { [T]: "40", [U]: "9" } });
    const claims = { [key]: "100", [expiryKey(B, T)]: "0", [expiryKey(B, U)]: "0" };
    expect(() => assertExpiryCoverage(tree, claims, { [T]: "39", [U]: "900" }, { [T]: "0", [U]: "0" })).toThrow("unfunded");
    expect(() => assertExpiryCoverage(tree, claims, { [T]: "40", [U]: "9" }, { [T]: "1", [U]: "0" })).toThrow("unfunded");
    expect(() => assertExpiryCoverage(tree, claims, { [T]: "41", [U]: "9" }, { [T]: "1", [U]: "0" })).not.toThrow();
    expect(() => assertExpiryCoverage(tree, claims, { [T]: "41", [U]: "9" }, {})).toThrow("reserve or balance missing");
  });

  it.each([false, true])("replays canonical activation and claims, retaining a late cancel (lateClaim=%s)", async lateClaim => {
    const { ledger, parent, notice, claims } = fixture();
    ledger.checkpoint = { block: 3, blockHash: zeroHash };
    const cut = prepareExpiryCut(notice, ledger, parent, at + 86400);
    const state: PublicationJournal = { version: 1, pool: "voters-1", revision: 1, ledger, merkle: parent, cut, notice, history: [], cancelRequested: true,
      publication: { version: 1, pool: "voters-1", revision: 0, parent: parent.merkleRoot, kind: "cut", merkle: cut.merkle, gains: {}, sources: [], reserves: { [T]: "0", [U]: "0" }, checkpoint: ledger.checkpoint, ipfsHash: zeroHash },
      submission: { calldata: "1234" }, execution: { action: "submit", calldata: "1234" } };
    const log = (eventName: string, logIndex: number, args: object) => ({ eventName, blockNumber: 4n, blockHash: zeroHash, logIndex, transactionHash: zeroHash, removed: false, args });
    const logs = [
      log("PendingRootSet", 0, { newRoot: cut.merkle.merkleRoot, newIpfsHash: zeroHash }),
      log("RootSet", 2, { newRoot: cut.merkle.merkleRoot, newIpfsHash: zeroHash }),
      log("Claimed", lateClaim ? 1 : 3, { account: A, recipient: B, reward: T, amount: lateClaim ? 100n : 70n }),
    ];
    const finalClaims = { ...claims, [key]: lateClaim ? "100" : "70" };
    const client = {
      getChainId: async () => 1,
      getBlock: async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 5n, hash: zeroHash, timestamp: BigInt(at + 86401) }),
      readContract: async ({ functionName, blockNumber }: any) => functionName === "root" ? (blockNumber === 3n ? parent.merkleRoot : cut.merkle.merkleRoot) : [zeroHash, zeroHash, 0n],
      multicall: async ({ contracts, blockNumber }: any) => contracts.map((c: any) => BigInt((blockNumber === 3n ? claims : finalClaims)[expiryKey(...c.args as [string, string])] ?? "0")),
      getLogs: async ({ fromBlock }: any) => fromBlock <= 4n ? logs : [],
      getTransaction: async () => ({ to: "0x067e4F59F6Bd026897D771Fa430CA261d7C35205", from: "0x2468Fd5868dA9219b50c8d57bB4edba4097Bd20A", input: "0x1234" }),
      getTransactionReceipt: async () => ({ status: "success" }),
    } as unknown as PublicClient;
    await expect(reconcilePublication({ ...state, submission: { calldata: "0x1235" } }, client)).rejects.toThrow("differs from durable intent");
    const adopted = await reconcilePublication(state, client);
    expect(adopted.cancelRequested).toBe(true);
    expect(adopted.submitted).toBeUndefined();
    expect(adopted.adopted!.reserve[T]).toBe(lateClaim ? "0" : "30");
    expect(adopted.ledger.pairs[key].paid).toBe(lateClaim ? "100" : "70");
    expect((await reconcilePublication(adopted, client)).adopted).toEqual(adopted.adopted);
    await expect(preparePublication(adopted, { [A]: { [T]: "5" } }, { [T]: "0", [U]: "0" }, client, ["voters:123"])).rejects.toThrow("requires reconciliation");
    delete adopted.cancelRequested; // Explicit operator resume, after adoption.
    const candidate = await preparePublication(adopted, { [A]: { [T]: "5" } }, { [T]: "0", [U]: "0" }, client, ["voters:123"]);
    expect(candidate.merkle.claims[A].tokens[T].amount).toBe(lateClaim ? "105" : "75");
    expect(candidate.kind).toBe("settlement");
    adopted.creditedSources = ["voters:123"];
    await expect(preparePublication(adopted, {}, {}, client, ["voters:123"])).rejects.toThrow("already credited");
    const foreign = { ...client, getTransaction: async () => ({ to: A, from: A, input: "0x1234" }) } as unknown as PublicClient;
    await expect(reconcilePublication(state, foreign)).rejects.toThrow("recorded guard route");
    const revoked = { ...client, getLogs: async () => [logs[0], log("PendingRootRevoked", 1, {})], readContract: async ({ functionName }: any) => functionName === "root" ? parent.merkleRoot : [zeroHash, zeroHash, 0n], multicall: async ({ contracts }: any) => contracts.map(() => 0n) } as unknown as PublicClient;
    const cancelled = await reconcilePublication(state, revoked);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.submitted?.transaction).toBe(zeroHash);
    expect(cancelled.publication).toEqual(state.publication);
    expect(cancelled.adopted).toBeUndefined();
  });
});
