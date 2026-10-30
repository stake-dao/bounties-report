import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, parseAbi, PublicClient } from "viem";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { ABI, EXTRA, OWNER, RECIPIENT, Review, VOTERS, pairKey, refreshRecovery, safeBatch } from "../../recovery/prepare";
import { main, notification, prepareOnchain } from "../../recovery/run";
import { adoptionFiles, verifyAdoption } from "../../recovery/adopt";
import { findMerkleMatchingRoot, findPreviousMerkle } from "../../utils/merkle/findPreviousMerkle";
import * as clients from "../../utils/getClients";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const T = "0x3333333333333333333333333333333333333333";
const U = "0x4444444444444444444444444444444444444444";
const CHECK = "0x5555555555555555555555555555555555555555";
const ZERO = `0x${"0".repeat(64)}`;
const HASH = `0x${"1".repeat(64)}`;
const source = generateMerkleTree({ [A]: { [T]: "100", [U]: "300" }, [B]: { [T]: "55" }, [RECIPIENT]: { [T]: "7" } });
const review: Review = {
  chainId: 1, distributor: VOTERS, recipient: RECIPIENT,
  sourceRoot: source.merkleRoot, sourceFile: "unused", cutoff: 100,
  checkpoint: { block: "10", hash: HASH }, provenance: "review",
  rows: [{ account: A, token: T, claimed: "20", maximum: "60" }],
};
const claims = (paid = 35n) => new Map([[pairKey(A, T), paid], [pairKey(A, U), 0n], [pairKey(B, T), 0n], [pairKey(RECIPIENT, T), 2n], [pairKey(RECIPIENT, U), 0n]]);

function client(options: { root?: string; publications?: string[]; pending?: bigint; replaced?: boolean; balance?: bigint; balanceT?: bigint; checkpoint?: string; historical?: bigint; code?: `0x${string}`; rejectCheck?: boolean; recipient?: string } = {}) {
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber = 20n } = {}) => ({ number: blockNumber, timestamp: 200n, hash: blockNumber === 10n ? options.checkpoint ?? HASH : HASH }),
    getLogs: async () => (options.publications ?? (options.replaced ? [ZERO] : [])).map(newRoot => ({ removed: false, args: { newRoot } })),
    multicall: async ({ contracts, blockNumber }: any) => contracts.map((c: any) => blockNumber === 10n ? options.historical ?? 20n : claims().get(pairKey(c.args[0], c.args[1]))!),
    readContract: async ({ functionName, address, blockNumber }: any) => {
      switch (functionName) {
        case "root": return blockNumber === 10n ? source.merkleRoot : options.root ?? source.merkleRoot;
        case "pendingRoot": return [ZERO, ZERO, options.pending ?? 0n];
        case "owner": return OWNER;
        case "recipients": return options.recipient ?? RECIPIENT;
        case "balanceOf": return address === U ? options.balance ?? 300n : options.balanceT ?? 125n;
        case "decimals": return 2;
        case "symbol": return "TOK";
        default: throw new Error("unexpected read");
      }
    },
    getBytecode: async () => options.code ?? "0x00",
    call: async () => { if (options.rejectCheck) throw new Error("claim changed"); return { data: "0x" }; },
  } as unknown as PublicClient;
}

describe("reviewed recovery", () => {
  it("charges new claims against old allowances, preserves other rewards, and conserves each token", () => {
    const result = refreshRecovery(review, source, claims());
    expect(result.totals).toEqual({ [T]: 45n });
    expect(result.merkle.claims[A].tokens[T].amount).toBe("55");
    expect(result.merkle.claims[A].tokens[U].amount).toBe("300");
    expect(result.merkle.claims[B].tokens[T].amount).toBe("55");
    expect(result.merkle.claims[RECIPIENT].tokens[T].amount).toBe("52");
    expect(source.claims[A].tokens[T].amount).toBe("100");
    expect(refreshRecovery(review, source, claims(79n)).totals[T]).toBe(1n);
    expect(refreshRecovery(review, source, claims(80n)).rows).toEqual([]);
    expect(refreshRecovery(review, source, claims(100n)).rows).toEqual([]);
  });

  it("absorbs only same-token deficits from new DAO credit, with zero net credit allowed", () => {
    const result = refreshRecovery(review, source, claims(), { [T]: 17n });
    expect(result.grossTotals[T]).toBe(45n);
    expect(result.totals[T]).toBe(28n);
    expect(result.merkle.claims[RECIPIENT].tokens[T].amount).toBe("35");
    expect(result.merkle.claims[A].tokens[T].amount).toBe("55");
    expect(result.merkle.claims[A].tokens[U].amount).toBe("300");
    expect(result.merkle.claims[B].tokens[T].amount).toBe("55");
    const allOffset = refreshRecovery(review, source, claims(), { [T]: 45n });
    expect(allOffset.merkle.claims[RECIPIENT].tokens[T].amount).toBe("7");
    expect(allOffset.totals[T]).toBe(0n);
    // A zero DAO payout still removes old entitlements, so its claim snapshot
    // must remain in the atomic check rather than disappear with the payout.
    const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,address[],bytes) view"]), data: safeBatch(review, allOffset, CHECK, 0).transactions[0].data });
    expect(check.args?.[4]).toEqual([T]);
    expect(check.args?.[5]).not.toBe("0x");
    for (const offsets of [{ [T]: 46n }, { [U]: 1n }, { [T]: -1n }]) {
      expect(() => refreshRecovery(review, source, claims(), offsets)).toThrow("funding deficit exceeds");
    }
    expect(() => refreshRecovery(review, source, claims(64n), { [T]: 17n })).toThrow("funding deficit exceeds");
  });

  it("rejects changed authority, inflated allowances, duplicate pairs and decreasing counters", () => {
    expect(() => refreshRecovery({ ...review, recipient: B }, source, claims())).toThrow("approved DAO");
    expect(() => refreshRecovery({ ...review, rows: [{ ...review.rows[0], maximum: "81" }] }, source, claims())).toThrow("exceeds source");
    expect(() => refreshRecovery({ ...review, rows: [...review.rows, ...review.rows] }, source, claims())).toThrow("duplicate");
    expect(() => refreshRecovery(review, source, claims(19n))).toThrow("decreasing claimed");
  });

  it("encodes an atomic assertion followed by owner root replacement, never module execution", () => {
    const recovery = refreshRecovery(review, source, claims());
    const batch = safeBatch(review, recovery, CHECK, 123);
    expect(batch.meta.createdFromSafeAddress).toBe(OWNER);
    expect(batch.transactions).toHaveLength(2);
    const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,address[],bytes) view"]), data: batch.transactions[0].data });
    expect(check.args).toEqual([1n, VOTERS, source.merkleRoot, RECIPIENT, [T], `0x${A.slice(2)}00${35n.toString(16).padStart(24, "0")}`]);
    expect(decodeFunctionData({ abi: ABI, data: batch.transactions[1].data })).toMatchObject({ functionName: "setRoot", args: [recovery.merkle.merkleRoot, ZERO] });
  });

  it("waits until the exact reviewed root is active and no other root is queued", async () => {
    for (const options of [{ root: ZERO }, { pending: 500n }]) {
      expect(await prepareOnchain(review, source, client(options), null)).toMatchObject({ status: "waiting" });
    }
  });

  it("rejects a restored root, reorged review, changed checkpoint claims and redirected recipient", async () => {
    for (const [options, message] of [
      [{ replaced: true }, "Intervening root"], [{ checkpoint: ZERO }, "checkpoint reorged"],
      [{ historical: 21n }, "claim snapshot mismatch"], [{ recipient: B }, "recipient is redirected"],
    ] as const) {
      await expect(prepareOnchain(review, source, client(options), null)).rejects.toThrow(message);
    }
  });

  it("follows additive publications without expiring their new rewards, but rejects intermediate reductions", async () => {
    const added = generateMerkleTree({ [A]: { [T]: "107", [U]: "300" }, [B]: { [T]: "55" }, [RECIPIENT]: { [T]: "7" } });
    const reduced = generateMerkleTree({ [A]: { [T]: "99", [U]: "300" }, [B]: { [T]: "55" }, [RECIPIENT]: { [T]: "7" } });
    const resolve = (root: string) => [source, added, reduced].find(tree => tree.merkleRoot === root)!;
    const result = await prepareOnchain(review, source, client({ root: added.merkleRoot, publications: [added.merkleRoot], balanceT: 132n }), null, resolve);
    expect(result).toMatchObject({ reviewedRoot: source.merkleRoot, sourceRoot: added.merkleRoot, amounts: [{ grossAmount: "45" }] });
    expect((result as any).recovery.merkle.claims[A].tokens[T].amount).toBe("62");
    await expect(prepareOnchain(review, source, client({ publications: [reduced.merkleRoot, source.merkleRoot] }), null, resolve)).rejects.toThrow("Intervening reduction");
    await expect(prepareOnchain(review, source, client({ root: added.merkleRoot }), null, resolve)).rejects.toThrow("history incomplete");
  });

  it("adopts only a finalized, reproducible Safe publication with no affected claims before execution", async () => {
    const recovery = refreshRecovery(review, source, claims());
    const report = { block: "20", blockHash: HASH, sourceRoot: source.merkleRoot, recoveryRoot: recovery.merkle.merkleRoot };
    const txHash = `0x${"2".repeat(64)}` as `0x${string}`;
    const base = client();
    const adopted = (options: { claimIndex?: number; claimAccount?: string; finalized?: bigint; pending?: bigint; to?: string; root?: string } = {}) => ({
      ...base,
      getBlock: async ({ blockNumber, blockTag }: any = {}) => ({ number: blockNumber ?? (blockTag === "finalized" ? options.finalized ?? 30n : 30n), timestamp: 200n, hash: HASH }),
      getTransactionReceipt: async () => ({ status: "success", to: options.to ?? OWNER, blockNumber: 21n, blockHash: HASH }),
      readContract: async (args: any) => args.blockNumber > 20n && args.functionName === "root" ? options.root ?? recovery.merkle.merkleRoot
        : args.blockNumber > 20n && args.functionName === "pendingRoot" ? [ZERO, ZERO, options.pending ?? 0n] : base.readContract(args),
      getLogs: async ({ fromBlock, event }: any) => fromBlock <= 20n ? [] : event.name === "RootSet"
        ? [{ removed: false, transactionHash: txHash, blockNumber: 21n, logIndex: 5, args: { newRoot: recovery.merkle.merkleRoot } }]
        : options.claimIndex === undefined ? [] : [{ removed: false, blockNumber: 21n, logIndex: options.claimIndex, args: { account: options.claimAccount ?? A, reward: T } }],
    } as unknown as PublicClient);
    const verify = (options = {}) => verifyAdoption(review, report, recovery.merkle, txHash, adopted(options), () => source);
    const verified = await verify();
    expect(verified.prepared.recovery.totals[T]).toBe(45n);
    await expect(verify({ claimIndex: 4 })).rejects.toThrow("claimed before recovery");
    await expect(verify({ claimIndex: 6 })).resolves.toBeDefined(); // After RootSet in the same block is safe.
    await expect(verify({ claimIndex: 4, claimAccount: B })).resolves.toBeDefined();
    await expect(verify({ finalized: 20n })).rejects.toThrow("finalized");
    await expect(verify({ to: B })).rejects.toThrow("owner Safe");
    await expect(verify({ root: source.merkleRoot })).rejects.toThrow("no longer active");
    await expect(verify({ pending: 500n })).rejects.toThrow("another root is pending");
    await expect(verifyAdoption(review, report, source, txHash, adopted(), () => source)).rejects.toThrow("differs from recomputed");

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-adoption-"));
    const put = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
    try {
      const reports = path.join(directory, "reports"), toolkit = path.join(directory, "toolkit");
      put(path.join(reports, "100/vlCVX/vlcvx_merkle.json"), source);
      put(path.join(reports, "latest/vlCVX/vlcvx_merkle.json"), source);
      for (const [file, data] of adoptionFiles(review, verified, reports)) put(file, JSON.parse(data));
      expect(findPreviousMerkle(200, "vlCVX/vlcvx_merkle.json", reports).data).toEqual(recovery.merkle);
      expect(findMerkleMatchingRoot(200, "vlCVX/vlcvx_merkle.json", source.merkleRoot, { reportsRoot: reports }).data).toEqual(source);
      put(path.join(reports, "200/vlCVX/vlcvx_merkle.json"), generateMerkleTree({ [A]: { [T]: "999" } }));
      expect(() => adoptionFiles(review, verified, reports)).toThrow("baseline has advanced");

      put(path.join(toolkit, "data/last_merkle.json"), source);
      put(path.join(toolkit, "data/distribution.json"), [{ timestamp: 100 }]);
      put(path.join(toolkit, "data/distributions/100/merkle.json"), source);
      const files = adoptionFiles({ ...review, distributor: EXTRA }, verified, reports, toolkit);
      expect(JSON.parse(files.get(path.join(toolkit, "data/last_merkle.json"))!)).toEqual(recovery.merkle);
      expect(JSON.parse(files.get(path.join(toolkit, "data/recoveries", `${recovery.merkle.merkleRoot}.json`))!).sourceRoot).toBe(source.merkleRoot);
      expect(files.has(path.join(toolkit, "data/distributions/100/merkle.json"))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("checks funding even for tokens outside the recovery, and never emits a batch without a reviewed checker", async () => {
    const short = await prepareOnchain(review, source, client({ balance: 299n }), null);
    expect(short).toMatchObject({ status: "blocked", deficits: [{ token: U, missing: "1" }] });
    expect(short).not.toHaveProperty("batch");
    expect(await prepareOnchain(review, source, client(), null)).toMatchObject({ status: "blocked", reason: expect.stringContaining("deployment needs review") });
  });

  it("reports gross/offset/net and blocks rather than haircut other rewards when backing is insufficient", async () => {
    const result = await prepareOnchain(review, source, client({ balanceT: 108n }), null);
    expect(result).toMatchObject({ deficits: [], fundingOffsets: { [T]: 17n }, amounts: [{ grossAmount: "45", fundingOffset: "17", amount: "28", formatted: "0.28" }] });
    expect(result).toHaveProperty("recovery.merkle.claims." + RECIPIENT + ".tokens." + T + ".amount", "35");
    expect(await prepareOnchain(review, source, client({ balanceT: 80n }), null)).toMatchObject({ deficits: [], amounts: [{ amount: "0", fundingOffset: "45" }] });
    const short = await prepareOnchain(review, source, client({ balanceT: 79n }), null);
    expect(short).toMatchObject({ status: "blocked", deficits: [{ token: T, missing: "46" }], fundingOffsets: {} });
    expect(short).not.toHaveProperty("batch");
    expect(await prepareOnchain({ ...review, rows: [] }, source, client({ balanceT: 124n }), null)).toMatchObject({ status: "blocked", deficits: [{ token: T, missing: "1" }] });
  });

  it("emits a batch only after reviewed runtime and snapshot checks pass", async () => {
    const checker = { address: CHECK, codeHash: keccak256("0x00") };
    expect(await prepareOnchain(review, source, client(), checker)).toMatchObject({ status: "awaiting-safe", amounts: [{ token: T, amount: "45", formatted: "0.45" }], batch: { chainId: "1" } });
    await expect(prepareOnchain(review, source, client({ code: "0x01" }), checker)).rejects.toThrow("runtime differs");
    await expect(prepareOnchain(review, source, client({ rejectCheck: true }), checker)).rejects.toThrow("claim changed");
  });

  it("removes stale signable files and emits a redacted failure report if a rerun fails", async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-test-"));
    const directory = path.join(output, "voters-1");
    fs.mkdirSync(directory);
    for (const file of ["safe-batch.json", "recovery-merkle.json", "reductions.json"]) fs.writeFileSync(path.join(directory, file), "stale");
    const previousExitCode = process.exitCode;
    const rpc = vi.spyOn(clients, "getClient").mockRejectedValue(new Error("RPC https://example.test/private-key"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main("voters", output, false);
      expect(process.exitCode).toBe(2);
      expect(fs.readdirSync(directory)).toEqual(["report.json"]);
      const report = fs.readFileSync(path.join(directory, "report.json"), "utf8");
      expect(JSON.parse(report).status).toBe("blocked");
      expect(report + JSON.stringify(log.mock.calls)).not.toContain("private-key");
    } finally {
      process.exitCode = previousExitCode;
      rpc.mockRestore(); log.mockRestore();
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("reports roots, amounts and deficits without rendering token names as Telegram HTML", () => {
    const result = { status: "blocked", reason: "Funding deficits", cutoff: 100, block: "20", sourceRoot: HASH, recoveryRoot: ZERO, accounts: 1,
      amounts: Array.from({ length: 60 }, () => ({ token: T, symbol: "<TOK&>", formatted: "0.45", grossAmount: "60", fundingOffset: "15", decimals: 2 })), deficits: [{ token: U, missing: "1" }] };
    const messages = notification("voters-1", result, "https://github.com/run");
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(m => m.length <= 3500)).toBe(true);
    expect(messages.join("\n")).toContain("0.45 &lt;TOK&amp;&gt;");
    expect(messages.join("\n")).toContain("NET; gross 0.6, deficit absorbed 0.15");
    expect(messages.join("\n")).toContain(`SHORT ${U}: 1 raw units`);
    expect(messages[0]).toContain(`Source root: ${HASH}`);
    expect(messages[0]).toContain(`Recovery root: ${ZERO}`);
  });
});
