import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicClient, zeroHash } from "viem";
import { bootstrapExpiryLedger, expiryKey, sixCalendarMonths, syncExpiryClaims } from "../../shared/merkle/expiry";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { appendPublication, monthlyPeriod, monthlyReview, prepareMonthly, recoverLedger, vmRewards } from "../../recovery/monthly";
import { EXTRA, pairKey, RECIPIENT, refreshRecovery } from "../../recovery/prepare";

const A = "0x1111111111111111111111111111111111111111";
const T = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const key = expiryKey(A, T);
const time = (value: string) => Date.parse(value) / 1000;
const hash = `0x${"1".repeat(64)}`;
const publication = (amount: string, date: string, block: number, vm: string) => {
  const merkle = generateMerkleTree({ [A]: { [T]: amount }, [RECIPIENT]: { [T]: "7" } });
  return { merkle, root: merkle.merkleRoot, timestamp: time(date), block, blockHash: hash, logIndex: 1, vmRewards: { [key]: vm } };
};

describe("monthly Safe recovery", () => {
  it("opens only at the last Thursday window and carries an unfinished period across month end", () => {
    expect(monthlyPeriod(time("2026-10-29T11:59:59Z")).period).toBe("2026-09");
    expect(monthlyPeriod(time("2026-10-29T12:00:00Z"))).toEqual({ period: "2026-10", cutoff: time("2026-10-29T12:00:00Z") });
    expect(monthlyPeriod(time("2026-11-01T00:00:00Z")).period).toBe("2026-10");
    expect(monthlyPeriod(time("2026-11-26T12:00:00Z")).period).toBe("2026-11");
    expect(monthlyPeriod(time("2027-01-01T00:00:00Z")).period).toBe("2026-12");
    expect(sixCalendarMonths(time("2026-05-31T14:01:00Z"))).toBe(time("2026-11-30T14:01:00Z"));
  });

  it("recovers newly aged credits next month without recovering twice or consuming protected rewards", () => {
    const direct = publication("40", "2026-03-01T00:00:00Z", 2, "0");
    const old = publication("130", "2026-03-02T00:00:00Z", 3, "90");
    const young = publication("190", "2026-05-01T00:00:00Z", 4, "60");
    let ledger = bootstrapExpiryLedger(1, [{ ...direct, root: zeroHash, merkle: null, block: 1 }, direct, old, young], { [key]: "20", [expiryKey(RECIPIENT, T)]: "0" }, { block: 4, blockHash: hash }, null, EXTRA);
    const october = monthlyReview(ledger, time("2026-10-29T12:00:00Z"), "2026-10");
    expect(october.rows).toEqual([{ account: A, token: T, claimed: "20", maximum: "70" }]);
    const result = refreshRecovery(october, young.merkle, new Map([[pairKey(A, T), 20n], [pairKey(RECIPIENT, T), 0n]]), { [T]: 13n });
    expect(result.merkle.claims[RECIPIENT].tokens[T].amount).toBe("64");
    ledger = recoverLedger(ledger, october, result.rows, result.merkle, { block: 5, blockHash: hash, logIndex: 2 });
    expect(monthlyReview(ledger, october.cutoff, october.period!).rows).toEqual([]);
    // Claims after recovery consume the next VM credit before the older direct credit.
    ledger = syncExpiryClaims(ledger, { [key]: "35", [expiryKey(RECIPIENT, T)]: "57" });
    const november = monthlyReview(ledger, time("2026-11-26T12:00:00Z"), "2026-11");
    expect(november.rows).toEqual([{ account: A, token: T, claimed: "35", maximum: "45" }]);
    expect(ledger.pairs[key].credits.filter(c => c.protection !== null).map(c => c.paid)).toEqual(["0"]);
    expect(monthlyReview(ledger, time("2026-11-01T00:00:00Z") - 1, "boundary").rows).toEqual([]);
    expect(monthlyReview(ledger, time("2026-11-01T00:00:00Z"), "boundary").rows[0].maximum).toBe("45");
    expect(() => recoverLedger(ledger, october, result.rows, result.merkle, { block: 6, blockHash: hash })).toThrow();
  });

  it("ages only the positive publication delta and blocks unadopted reductions", () => {
    const old = publication("100", "2026-03-02T00:00:00Z", 2, "100");
    const ledger = bootstrapExpiryLedger(1, [{ ...old, root: zeroHash, merkle: null, block: 1 }, old], { [key]: "0", [expiryKey(RECIPIENT, T)]: "0" }, { block: 2, blockHash: hash }, null, EXTRA);
    const next = publication("170", "2026-10-29T10:00:00Z", 3, "30");
    const updated = appendPublication(ledger, next, next.vmRewards);
    expect(monthlyReview(updated, time("2026-10-29T12:00:00Z"), "2026-10").rows[0].maximum).toBe("100");
    expect(monthlyReview(updated, time("2027-04-29T10:00:00Z"), "2027-04").rows[0].maximum).toBe("130");
    expect(() => appendPublication(updated, publication("169", "2026-10-30T00:00:00Z", 4, "0"))).toThrow("Unadopted reduction");
    const repaired = appendPublication(ledger, publication("80", "2026-03-03T00:00:00Z", 3, "0"), {}, true);
    expect(monthlyReview(repaired, time("2027-04-29T00:00:00Z"), "2027-04").rows).toEqual([]);
  });

  it("absorbs lifetime-paid gaps before granting new VM credits", () => {
    const old = publication("100", "2026-03-02T00:00:00Z", 2, "100");
    const ledger = bootstrapExpiryLedger(1, [{ ...old, root: zeroHash, merkle: null, block: 1 }, old], { [key]: "100", [expiryKey(RECIPIENT, T)]: "0" }, { block: 2, blockHash: hash }, null, EXTRA);
    ledger.pairs[key].activeAmount = "80";
    for (const amount of ["95", "100"]) {
      const next = publication(amount, "2026-05-01T00:00:00Z", 3, (BigInt(amount) - 80n).toString());
      expect(monthlyReview(appendPublication(ledger, next, next.vmRewards), time("2026-11-26T12:00:00Z"), "2026-11").rows).toEqual([]);
    }
    const next = publication("110", "2026-05-01T00:00:00Z", 3, "25");
    const updated = appendPublication(ledger, next, next.vmRewards);
    expect(monthlyReview(updated, time("2026-11-26T12:00:00Z"), "2026-11").rows).toEqual([{ account: A, token: T, claimed: "100", maximum: "5" }]);
    expect(updated.pairs[key].credits.at(-1)?.granted).toBe("5");
    expect(updated.pairs[key].credits.at(-1)?.protection).toBe("non-VM or unknown source");
  });

  it("requires historical VM provenance and charges reductions against VM first", async () => {
    const client = { multicall: async ({ contracts }: any) => contracts.map((c: any) => [A, c.args[0] === 2n ? OTHER : T, 0n, 0n, 0n, 42161n, c.args[0] === 3n ? A : "0x06ab7052b00d038f8eef33b267c23b5154ce8cdc"]) } as unknown as PublicClient;
    const allocations = [
      { token: { address: T }, distribution: { incentiveId: 1 }, users: [{ user: A, amount: "90" }] },
      { token: { address: T }, distribution: { incentiveId: 3 }, users: [{ user: A, amount: "40" }] },
    ];
    expect(await vmRewards(client, allocations, { [key]: "110" }, 123n)).toEqual({ [key]: "70" });
    expect(await vmRewards(client, allocations, { [key]: "131" }, 123n)).toEqual({});
    expect(await vmRewards(client, [{ ...allocations[0], distribution: { incentiveId: 2 } }], { [key]: "90" }, 123n)).toEqual({});
  });

  it("protects missing historical evidence and can replay an already-published adoption", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-replay-"));
    const cwd = process.cwd();
    const put = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
    try {
      process.chdir(directory);
      const trees = [100, 120, 150, 200].map(amount => generateMerkleTree({ [A]: { [T]: String(amount) } }));
      for (const index of [0, 2, 3]) {
        put(`merkl-toolkit/data/distributions/${index + 2}/merkle.json`, trees[index]);
        put(`merkl-toolkit/data/distributions/${index + 2}/distribution.json`, { incentives: [{ token: { address: T }, distribution: { incentiveId: 1 }, users: [{ user: A, amount: index === 0 ? "100" : "50" }] }] });
      }
      put("merkl-toolkit/data/last_merkle.json", trees[3]);
      const block = (number: bigint) => ({ number, hash, timestamp: BigInt(number < 8n ? time("2026-03-01T00:00:00Z") : time("2026-10-30T12:00:00Z")) });
      const client = {
        getChainId: async () => 1,
        getBlock: async ({ blockNumber = 10n }: any = {}) => block(blockNumber),
        getBytecode: async ({ blockNumber }: any) => blockNumber >= 1n ? "0x00" : undefined,
        getLogs: async ({ fromBlock, toBlock }: any) => trees.map((tree, index) => ({ removed: false, args: { newRoot: tree.merkleRoot }, blockNumber: BigInt(index + 2), blockHash: hash, logIndex: 1 })).filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
        readContract: async () => trees[3].merkleRoot,
        multicall: async ({ contracts }: any) => contracts.map((c: any) => c.functionName === "claimed" ? 10n : [A, T, 0n, 0n, 0n, 42161n, "0x06ab7052b00d038f8eef33b267c23b5154ce8cdc"]),
      } as unknown as PublicClient;
      const seed = { chainId: 1, distributor: EXTRA, recipient: RECIPIENT, sourceRoot: trees[3].merkleRoot, sourceFile: "unused", cutoff: time("2026-10-29T12:00:00Z"), checkpoint: { block: "8", hash }, provenance: "fixture", rows: [] };
      const prepared = await prepareMonthly(seed, client, seed.cutoff, "archive", 8n);
      expect("review" in prepared && prepared.review.rows).toEqual([{ account: A, token: T, claimed: "10", maximum: "40" }]);
      put("archive/adopted.json", { receipt: { block: "9" }, review: { period: "2026-10" } });
      put("merkl-toolkit/data/last_merkle.json", generateMerkleTree({ [A]: { [T]: "160" }, [RECIPIENT]: { [T]: "40" } }));
      expect(await prepareMonthly(seed, client, seed.cutoff, "archive", 8n)).toEqual(prepared);
      expect(await prepareMonthly(seed, client, seed.cutoff, "archive")).toMatchObject({ status: "noop" });
      if (!("review" in prepared)) throw new Error("expected prepared ledger");
      const recovery = refreshRecovery(prepared.review, prepared.source, new Map([[pairKey(A, T), 10n]]));
      const ledger = recoverLedger(prepared.ledger, prepared.review, recovery.rows, recovery.merkle, { block: 9, blockHash: hash });
      put("archive/adopted.json", { receipt: { block: "9" }, review: prepared.review, ledger, recoveryRoot: ledger.root });
      const after = { ...client, readContract: async () => ledger.root } as unknown as PublicClient;
      expect(await prepareMonthly(seed, after, time("2026-11-26T12:00:00Z"), "archive")).toMatchObject({ status: "waiting", reason: "Wait for an ordinary extra distribution after the previous recovery" });
    } finally { process.chdir(cwd); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
