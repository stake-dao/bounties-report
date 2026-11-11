import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, getAddress, keccak256, parseAbi, PublicClient } from "viem";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { ABI, EXTRA, OWNER, RECIPIENT, TREASURY_RECIPIENT, Review, VOTERS, pairKey, refreshRecovery, safeBatch } from "../../recovery/prepare";
import { main, notification, prepareOnchain, recoverySummary } from "../../recovery/run";
import { adoptionFiles, verifyAdoption } from "../../recovery/adopt";
import { BATCH, transition } from "../../recovery/transition";
import configuration from "../../recovery/config.json";
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

function client(options: { root?: string; publications?: string[]; publicationHash?: string; pending?: bigint; replaced?: boolean; balance?: bigint; balanceT?: bigint; checkpoint?: string; historical?: bigint; code?: `0x${string}`; rejectCheck?: boolean; recipient?: string } = {}) {
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockNumber = 20n } = {}) => ({ number: blockNumber, timestamp: 200n, hash: blockNumber === 10n ? options.checkpoint ?? HASH : HASH }),
    getLogs: async () => (options.publications ?? (options.replaced ? [ZERO] : [])).map((newRoot, index) => ({ removed: false, args: { newRoot }, blockNumber: BigInt(15 + index), blockHash: options.publicationHash ?? HASH })),
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

  it("routes new Ethereum recovery credit to Treasury without rewriting 5DAO, and publishes an audit pointer only at adoption", () => {
    const input = { ...review, recipient: TREASURY_RECIPIENT };
    const recovery = refreshRecovery(input, source, claims(), { [T]: 17n });
    expect(recovery.merkle.claims[RECIPIENT].tokens[T].amount).toBe("7");
    expect(recovery.merkle.claims[TREASURY_RECIPIENT].tokens[T].amount).toBe("28");
    expect(recovery.merkle.claims[A].tokens[T].amount).toBe("55");
    const batch = safeBatch(input, recovery, CHECK, 123);
    const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,address[],bytes) view"]), data: batch.transactions[0].data });
    expect(check.args?.[3]).toBe(TREASURY_RECIPIENT);
    expect(batch.transactions).toHaveLength(3);
    expect(decodeFunctionData({ abi: ABI, data: batch.transactions[2].data })).toMatchObject({ functionName: "claim", args: [TREASURY_RECIPIENT, T, 28n, expect.any(Array)] });
    for (const chainId of [8453, 42161]) expect(() => refreshRecovery({ ...input, chainId }, source, claims())).toThrow("approved DAO");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "treasury-adoption-"));
    const put = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
    try {
      put(path.join(directory, "100/vlCVX/vlcvx_merkle.json"), source);
      put(path.join(directory, "latest/vlCVX/vlcvx_merkle.json"), source);
      const verified = { prepared: { recovery }, parent: source, receipt: { transactionHash: HASH, block: "21", blockHash: HASH, logIndex: 5 } } as unknown as Awaited<ReturnType<typeof verifyAdoption>>;
      const pointer = path.join(directory, "recovery/treasury-claims/voters-1.json");
      const files = adoptionFiles(input, verified, directory);
      const index = JSON.parse(files.get(pointer)!);
      expect(index).toMatchObject({ version: 1, chainId: 1, recipient: TREASURY_RECIPIENT, pools: { "voters-1": { root: recovery.merkle.merkleRoot, amounts: { [T]: "28" }, receipt: { block: "21" } } } });
      const toolkit = path.join(directory, "toolkit");
      put(path.join(toolkit, "data/last_merkle.json"), source);
      put(path.join(toolkit, "data/distribution.json"), [{ timestamp: 100 }]);
      put(path.join(toolkit, "data/distributions/100/merkle.json"), source);
      const extraReview = { ...input, distributor: EXTRA };
      const extraFiles = adoptionFiles(extraReview, verified, directory, toolkit);
      // Both PRs start from the same baseline; no shared added/modified file.
      expect([...files.keys()].filter(file => extraFiles.has(file))).toEqual([]);
      for (const [file, contents] of files) put(file, JSON.parse(contents));
      for (const [file, contents] of extraFiles) put(file, JSON.parse(contents));
      expect(adoptionFiles(input, verified, directory).get(pointer)).toBe(files.get(pointer));
      const extraPointer = path.join(directory, "recovery/treasury-claims/extra-1.json");
      expect(adoptionFiles(extraReview, verified, directory, toolkit).get(extraPointer)).toBe(extraFiles.get(extraPointer));
      const chunkReview: Review = { ...extraReview, execution: "module-v1", sourceRoot: recovery.merkle.merkleRoot, rows: [{ account: A, token: T, claimed: "35", maximum: "7" }] };
      const chunkClaims = claims();
      chunkClaims.set(pairKey(TREASURY_RECIPIENT, T), 28n);
      const chunk = refreshRecovery(chunkReview, recovery.merkle, chunkClaims);
      const next = { ...verified, parent: recovery.merkle, prepared: { recovery: chunk } } as typeof verified;
      const plan = adoptionFiles(chunkReview, next, directory, toolkit);
      // Simulate toolkit push succeeding, then the audit-repo push failing.
      for (const [file, contents] of plan) if (file.startsWith(toolkit)) put(file, JSON.parse(contents));
      expect(adoptionFiles(chunkReview, next, directory, toolkit)).toEqual(plan);
      for (const [file, contents] of plan) put(file, JSON.parse(contents));
      expect(adoptionFiles(chunkReview, next, directory, toolkit)).toEqual(plan);
      expect(JSON.parse(fs.readFileSync(extraPointer, "utf8")).pools["extra-1"].amounts[T]).toBe("35");
      expect(JSON.parse(fs.readFileSync(path.join(toolkit, "data/distributions/100/merkle.json"), "utf8"))).toEqual(source);
      const unknown = generateMerkleTree({ [A]: { [T]: "100" }, [TREASURY_RECIPIENT]: { [T]: "1" } });
      expect(() => adoptionFiles(input, { ...verified, parent: unknown, prepared: { recovery: refreshRecovery({ ...input, sourceRoot: unknown.merkleRoot }, unknown, new Map([[pairKey(A, T), 35n]])) } } as typeof verified, directory)).toThrow("unaccounted Treasury");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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

  it("claims cumulative Treasury entitlements, excludes settled zero-net tokens, and leaves legacy batches root-only", () => {
    const tree = generateMerkleTree({ [A]: { [T]: "100" }, [TREASURY_RECIPIENT]: { [T]: "70" }, [RECIPIENT]: { [T]: "7" } });
    const input = { ...review, recipient: TREASURY_RECIPIENT, sourceRoot: tree.merkleRoot };
    const counters = new Map([[pairKey(A, T), 35n], [pairKey(TREASURY_RECIPIENT, T), 30n]]);
    const recovered = refreshRecovery(input, tree, counters, { [T]: 17n });
    const batch = safeBatch(input, recovered, CHECK, 0);
    expect(recovered.payouts).toEqual([{ token: T, amount: "98" }]); // 70 opening + 45 gross - 17 deficit.
    expect(decodeFunctionData({ abi: ABI, data: batch.transactions[2].data }).args?.slice(0, 3)).toEqual([TREASURY_RECIPIENT, T, 98n]);
    expect(recovered.merkle.claims[RECIPIENT].tokens[T].amount).toBe("7");
    counters.set(pairKey(TREASURY_RECIPIENT, T), 70n);
    const zero = refreshRecovery(input, tree, counters, { [T]: 45n });
    expect(zero.payouts).toEqual([]);
    expect(safeBatch(input, zero, CHECK, 0).transactions).toHaveLength(2);
    expect(safeBatch(review, refreshRecovery(review, source, claims()), CHECK, 0).transactions).toHaveLength(2);
  });

  it("requires the new preparation's Treasury claims in the same finalized root transaction", async () => {
    const input = { ...review, recipient: TREASURY_RECIPIENT };
    const base = client({ recipient: TREASURY_RECIPIENT });
    const originalMulticall = base.multicall;
    base.multicall = (async (args: any) => {
      const values = await originalMulticall(args);
      return args.contracts.map((c: any, i: number) => c.args[0] === TREASURY_RECIPIENT ? 0n : values[i]);
    }) as typeof base.multicall;
    const prepared = await prepareOnchain(input, source, base, null);
    expect("payouts" in prepared && prepared.payouts).toEqual([{ token: T, amount: "45" }]);
    const result = prepared as any;
    let claimHash = HASH, claimRecipient = TREASURY_RECIPIENT;
    const adopted = {
      ...base,
      getBlock: async (args: any = {}) => ({ number: args.blockNumber ?? 30n, timestamp: 200n, hash: HASH }),
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 21n, blockHash: HASH, to: OWNER }),
      readContract: async (args: any) => args.functionName === "root" && args.blockNumber >= 21n ? result.recoveryRoot : base.readContract(args),
      getLogs: async ({ event, fromBlock }: any) => fromBlock <= 20n ? [] : event.name === "RootSet"
        ? [{ args: { newRoot: result.recoveryRoot }, blockNumber: 21n, blockHash: HASH, logIndex: 5, transactionHash: HASH }]
        : [{ args: { account: TREASURY_RECIPIENT, recipient: claimRecipient, reward: T, amount: 45n }, blockNumber: 21n, blockHash: HASH, logIndex: 6, transactionHash: claimHash }],
    } as unknown as PublicClient;
    const verify = () => verifyAdoption(input, result, result.recovery.merkle, HASH as `0x${string}`, adopted, () => source);
    await expect(verify()).resolves.toBeDefined();
    claimHash = ZERO;
    await expect(verify()).rejects.toThrow("atomic Treasury claims missing");
    claimHash = HASH; claimRecipient = OWNER;
    await expect(verify()).rejects.toThrow("not paid directly");
  });

  it.each([(1n << 96n) - 1n, 1n << 96n, (1n << 256n) - 101n])("encodes full claim counters without truncation: %s", paid => {
    const tree = generateMerkleTree({ [A]: { [T]: (paid + 100n).toString() } });
    const input = { ...review, sourceRoot: tree.merkleRoot, rows: [{ account: A, token: T, claimed: paid.toString(), maximum: "60" }] };
    const recovery = refreshRecovery(input, tree, new Map([[pairKey(A, T), paid]]));
    const data = safeBatch(input, recovery, CHECK, 0).transactions[0].data;
    if (paid < (1n << 96n)) {
      const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,address[],bytes) view"]), data });
      expect(check.args?.[5]).toBe(`0x${A.slice(2)}00${paid.toString(16).padStart(24, "0")}`);
    } else {
      const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,(address account,address token,uint256 claimed)[]) view"]), data });
      expect(check.args?.[4]).toEqual([{ account: A, token: T, claimed: paid }]);
    }
  });

  it("uses the typed checker for more than 256 tokens", () => {
    const tokens = Array.from({ length: 257 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    const tree = generateMerkleTree({ [A]: Object.fromEntries(tokens.map(token => [token, "100"])) });
    const input = { ...review, sourceRoot: tree.merkleRoot, rows: tokens.map(token => ({ account: A, token, claimed: "0", maximum: "60" })) };
    const recovery = refreshRecovery(input, tree, new Map(tokens.map(token => [pairKey(A, token), 0n])));
    const data = safeBatch(input, recovery, CHECK, 0).transactions[0].data;
    const check = decodeFunctionData({ abi: parseAbi(["function check(uint256,address,bytes32,address,(address account,address token,uint256 claimed)[]) view"]), data });
    expect(check.args?.[4]).toEqual(tokens.map(token => ({ account: A, token, claimed: 0n })));
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
    await expect(prepareOnchain(review, source, client({ publications: [source.merkleRoot], publicationHash: ZERO }), null, resolve)).rejects.toThrow("publication block is not canonical");
  });

  it("adopts only a finalized, reproducible Safe publication with no affected claims before execution", async () => {
    const recovery = refreshRecovery(review, source, claims());
    const report = { block: "20", blockHash: HASH, sourceRoot: source.merkleRoot, recoveryRoot: recovery.merkle.merkleRoot };
    const txHash = `0x${"2".repeat(64)}` as `0x${string}`;
    const base = client();
    const adopted = (options: { claimIndex?: number; claimAccount?: string; rootHash?: string; claimHash?: string; finalized?: bigint; pending?: bigint; to?: string; root?: string } = {}) => ({
      ...base,
      getBlock: async ({ blockNumber, blockTag }: any = {}) => ({ number: blockNumber ?? (blockTag === "finalized" ? options.finalized ?? 30n : 30n), timestamp: 200n, hash: HASH }),
      getTransactionReceipt: async () => ({ status: "success", to: options.to ?? OWNER, blockNumber: 21n, blockHash: HASH }),
      readContract: async (args: any) => args.blockNumber > 20n && args.functionName === "root" ? options.root ?? recovery.merkle.merkleRoot
        : args.blockNumber > 20n && args.functionName === "pendingRoot" ? [ZERO, ZERO, options.pending ?? 0n] : base.readContract(args),
      getLogs: async ({ fromBlock, event }: any) => fromBlock <= 20n ? [] : event.name === "RootSet"
        ? [{ removed: false, transactionHash: txHash, blockNumber: 21n, blockHash: options.rootHash ?? HASH, logIndex: 5, args: { newRoot: recovery.merkle.merkleRoot } }]
        : options.claimIndex === undefined ? [] : [{ removed: false, blockNumber: 21n, blockHash: options.claimHash ?? HASH, logIndex: options.claimIndex, args: { account: options.claimAccount ?? A, reward: T } }],
    } as unknown as PublicClient);
    const verify = (options = {}) => verifyAdoption(review, report, recovery.merkle, txHash, adopted(options), () => source);
    const verified = await verify();
    expect(verified.prepared.recovery.totals[T]).toBe(45n);
    await expect(verify({ claimIndex: 4 })).rejects.toThrow("claimed before recovery");
    await expect(verify({ claimIndex: 6 })).resolves.toBeDefined(); // After RootSet in the same block is safe.
    await expect(verify({ claimIndex: 4, claimAccount: B })).resolves.toBeDefined();
    await expect(verify({ rootHash: ZERO })).rejects.toThrow("publication block is not canonical");
    await expect(verify({ claimIndex: 6, claimHash: ZERO })).rejects.toThrow("claim block is not canonical");
    await expect(verify({ finalized: 20n })).rejects.toThrow("finalized");
    await expect(verify({ to: B })).rejects.toThrow("owner Safe");
    await expect(verify({ root: source.merkleRoot })).rejects.toThrow("no longer active");
    await expect(verify({ pending: 500n })).rejects.toThrow("another root is pending");
    await expect(verifyAdoption(review, report, source, txHash, adopted(), () => source)).rejects.toThrow("differs from recomputed");

    let scanned = false;
    const stable = adopted();
    const reorgDuringScan = {
      ...stable,
      getLogs: async (args: any) => {
        const logs = await stable.getLogs(args);
        if (args.fromBlock > 20n && args.event.name === "Claimed") scanned = true;
        return logs;
      },
      getBlock: async (args: any) => {
        const block = await stable.getBlock(args);
        return scanned && args?.blockNumber === 21n ? { ...block, hash: ZERO } : block;
      },
    } as unknown as PublicClient;
    await expect(verifyAdoption(review, report, recovery.merkle, txHash, reorgDuringScan, () => source)).rejects.toThrow("execution reorged during adoption");

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

  it("binds preparation and adoption to the predecessor at the archived snapshot, not current state or metadata", async () => {
    const tree = generateMerkleTree({ [A]: { [T]: "100" }, [TREASURY_RECIPIENT]: { [T]: "0" } });
    const input: Review = { ...review, execution: "module-v1", recipient: TREASURY_RECIPIENT, sourceRoot: tree.merkleRoot };
    const module = { address: CHECK, codeHash: keccak256("0x00") };
    const base = client({ root: tree.merkleRoot, recipient: TREASURY_RECIPIENT });
    let predecessor = HASH;
    let result: any;
    const rpc = {
      ...base,
      getBlock: async ({ blockNumber = 20n, blockTag }: any = {}) => ({ number: blockTag === "finalized" ? 30n : blockNumber, timestamp: 200n, hash: HASH }),
      multicall: async ({ contracts, blockNumber }: any) => contracts.map((c: any) => c.args[0] === TREASURY_RECIPIENT ? 0n : blockNumber === 10n ? 20n : 35n),
      readContract: async (args: any) => {
        if (args.address === CHECK) {
          switch (args.functionName) {
            case "DISTRIBUTOR": return VOTERS;
            case "SAFE": return OWNER;
            case "TREASURY": return TREASURY_RECIPIENT;
            case "nonce": return args.blockNumber === 20n ? 9n : 10n;
            case "proposal": return args.blockNumber === 20n ? predecessor : ZERO;
            case "check": return undefined;
          }
        }
        if (args.functionName === "root") return args.blockNumber > 20n ? result.recoveryRoot : tree.merkleRoot;
        if (args.functionName === "claimed") return 0n;
        return base.readContract(args);
      },
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 21n, blockHash: HASH }),
      getLogs: async ({ event, fromBlock }: any) => fromBlock <= 20n ? [] : [{
        blockNumber: 21n, blockHash: HASH, transactionHash: HASH, logIndex: event.name === "Claimed" ? 6 : 5,
        args: event.name === "Activated" ? { proposal: result.automatic.proposal, parent: tree.merkleRoot, root: result.recoveryRoot }
          : event.name === "RootSet" ? { newRoot: result.recoveryRoot, newIpfsHash: result.automatic.proposal }
          : { account: TREASURY_RECIPIENT, recipient: TREASURY_RECIPIENT, reward: T, amount: 45n },
      }],
    } as unknown as PublicClient;
    result = await prepareOnchain(input, tree, rpc, null, () => tree, module);
    expect(result).toMatchObject({ status: "awaiting-delay", automatic: { nonce: "9", expectedProposal: HASH } });
    expect(decodeAbiParameters(BATCH, result.automatic.payload)[0].expectedProposal).toBe(HASH);
    const previous = configuration.modules["voters-1"];
    configuration.modules["voters-1"] = module;
    const adopted = { ...rpc, getBlock: (args: any = {}) => rpc.getBlock({ ...args, blockNumber: args.blockNumber ?? 30n }) } as PublicClient;
    const verify = () => verifyAdoption(input, result, result.recovery.merkle, HASH as `0x${string}`, adopted, () => tree);
    try {
      await expect(verify()).resolves.toBeDefined();
      // Even internally consistent replacement metadata must match the historical chain read.
      result.automatic = transition(input, tree, result.recovery, CHECK, 9n, ZERO as `0x${string}`);
      await expect(verify()).rejects.toThrow("module transition differs from replay");
      predecessor = ZERO;
      await expect(verify()).resolves.toBeDefined();
    } finally { configuration.modules["voters-1"] = previous; }
  });

  it("removes stale signable files and emits a redacted failure report if a rerun fails", async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-test-"));
    const directory = path.join(output, "voters-1");
    fs.mkdirSync(directory);
    for (const file of ["safe-batch.json", "recovery-merkle.json", "reductions.json"]) fs.writeFileSync(path.join(directory, file), "stale");
    const previousExitCode = process.exitCode;
    const rpc = vi.spyOn(clients, "getClient").mockRejectedValue(new Error("RPC https://example.test/private-key"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const summary = path.join(output, "summary.md");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summary);
    try {
      await main("voters", output, false);
      expect(process.exitCode).toBe(2);
      expect(fs.readdirSync(directory)).toEqual(["report.json"]);
      const report = fs.readFileSync(path.join(directory, "report.json"), "utf8");
      expect(JSON.parse(report).status).toBe("blocked");
      const published = fs.readFileSync(summary, "utf8");
      expect(published).toContain("Ethereum · Voters");
      expect(published).toContain("Base · Voters");
      expect(published).toContain("Arbitrum · Voters");
      expect(report + published + JSON.stringify(log.mock.calls)).not.toContain("private-key");
    } finally {
      process.exitCode = previousExitCode;
      rpc.mockRestore(); log.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("keeps Telegram short even for many tokens, with explicit safety status and a report link", () => {
    const result = { status: "blocked", recipient: TREASURY_RECIPIENT, reason: "Funding <deficits>", cutoff: 100, block: "20", sourceRoot: HASH, recoveryRoot: ZERO, accounts: 1,
      amounts: Array.from({ length: 60 }, () => ({ token: T, symbol: "<TOK&>", amount: "45", grossAmount: "60", fundingOffset: "15", decimals: 2 })), deficits: [{ token: U, missing: "1" }] };
    const messages = notification("voters-1", result, "https://github.com/run");
    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBeLessThan(600);
    expect(messages[0]).toContain("Blocked — do not sign");
    expect(messages[0]).toContain("Uncovered deficit");
    expect(messages[0]).toContain("Funding &lt;deficits&gt;");
    expect(messages[0]).toContain("60 tokens");
    expect(messages[0]).toContain("https://github.com/run");
    expect(messages[0]).not.toContain(HASH);
    expect(messages[0]).not.toContain(T);
    const ready = notification("voters-1", { ...result, status: "awaiting-safe", deficits: [], fundingOffsets: { [T]: "15" } }, "https://github.com/run")[0];
    expect(ready).toContain("Ready for Safe review");
    expect(ready).toContain("Nothing executed");
    expect(ready).toContain("Treasury fee recipient only");
    expect(ready).toContain(TREASURY_RECIPIENT);
    expect(notification("extra-1", { status: "waiting", reason: "Pending root" }, "https://github.com/run")[0]).toContain("Waiting for distribution");
  });

  it("puts readable amounts and funding warnings in the summary without losing tiny deductions", () => {
    const result = { status: "blocked", recipient: RECIPIENT, reason: "Funding deficits", cutoff: 100, block: "20", sourceRoot: HASH, recoveryRoot: ZERO, accounts: 1,
      amounts: [
        { symbol: "<TOK&>|\n", grossAmount: "1234567890123456789012", fundingOffset: "1", amount: "1234567890123456789011", decimals: 18 },
        { symbol: "USDC", grossAmount: "1234567", fundingOffset: "234567", amount: "1000000", decimals: 6 },
      ], deficits: [{ token: U, missing: "1" }] };
    const summary = recoverySummary("voters-1", result);
    expect(summary).toContain("Gross recovery | Deficit deduction | Net 5DAO credit");
    expect(summary).toContain("<code>&lt;TOK&amp;&gt;&#124; </code> | ≈1,234.56789 | &lt;0.000001 | ≈1,234.56789");
    expect(summary).toContain("<code>USDC</code> | 1.234567 | 0.234567 | 1");
    expect(summary).toContain("STOP: uncovered funding deficits");
    expect(summary).toContain(`<code>${U}</code> | 1`);
    expect(summary).toContain("<details><summary>Technical details</summary>");
    expect(summary).toContain(HASH);
    expect(summary).toContain("Exact amounts");
  });
});
