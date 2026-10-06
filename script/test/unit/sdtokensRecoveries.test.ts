import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecoveries, splitRecoveryAmount, verifyRecoveryFunding, type Recovery } from "../../sdTkns/recoveries";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: (file: any) => files.has(String(file)) || original.existsSync(file),
    readFileSync: (file: any, ...args: any[]) => files.get(String(file)) ?? original.readFileSync(file, ...args),
  };
});
afterEach(() => files.clear());

const LEDGER = "data/sdtokens-recoveries.json";
const PERIOD = 1791417600;
const WEEK = 604800;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DISTRIBUTOR = "0x03e34b085c52985f6a5d27243f20c84bddc01db4";
const BOTMARKET = "0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff";
const DEPLOYER = "0x8898502ba35ab64b3562abc509befb7eb178d4df";
const SDCRV = "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const SOURCE_TX = `0x${"1".repeat(64)}` as const;
const FUNDING_TX = `0x${"2".repeat(64)}` as const;
const BLOCK_HASH = `0x${"3".repeat(64)}`;
const AMOUNT = 9000000000000000000n;

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const log = (logIndex: number, token: string, from: string, to: string, value: bigint) =>
  ({ logIndex, address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(value) });

const recovery = (funding: Partial<NonNullable<Recovery["funding"]>> = {}, amounts = { [`0x${"a".repeat(40)}`]: "3000000000000000000", [`0x${"b".repeat(40)}`]: "6000000000000000000" }): Recovery => ({
  id: "TEST-1",
  reason: "Direct-funded test recovery",
  protocol: "curve",
  sources: [{ chainId: 1, transaction: SOURCE_TX, logIndex: 0, token: WETH, from: BOTMARKET, to: DEPLOYER, amount: "1000", usedAmount: "1000" }],
  trail: [],
  allocation: { type: "wallets", amounts },
  funding: { period: PERIOD, transaction: FUNDING_TX, logIndex: 5, from: DEPLOYER, amount: AMOUNT.toString(), ...funding },
});
const ledger = (...recoveries: Recovery[]) => files.set(LEDGER, JSON.stringify({ schema: 1, recoveries }));

function client({ fundingLogs = [log(5, SDCRV, DEPLOYER, DISTRIBUTOR, AMOUNT)], head = 112n, timestamp = PERIOD + 3600 } = {}) {
  const receipts: Record<string, any> = {
    [SOURCE_TX]: { status: "success", blockNumber: 90n, blockHash: `0x${"4".repeat(64)}`, logs: [log(0, WETH, BOTMARKET, DEPLOYER, 1000n)] },
    [FUNDING_TX]: { status: "success", blockNumber: 100n, blockHash: BLOCK_HASH, logs: fundingLogs },
  };
  return {
    getTransactionReceipt: async ({ hash }: { hash: string }) => receipts[hash],
    getBlock: async () => ({ hash: BLOCK_HASH, timestamp: BigInt(timestamp) }),
    getBlockNumber: async () => head,
  } as any;
}

describe("splitRecoveryAmount", () => {
  it("conserves the total and hands the remainder to the largest fractions", () => {
    const amounts = splitRecoveryAmount(10n, { a: 1n, b: 1n, c: 1n });
    expect(Object.values(amounts).reduce((sum, amount) => sum + amount, 0n)).toBe(10n);
    expect(amounts).toEqual({ a: 4n, b: 3n, c: 3n });
  });
});

describe("loadRecoveries", () => {
  it("keeps the ENG-2178 entry inactive until its funding is recorded", () => {
    const [entry] = loadRecoveries();
    expect(entry.id).toBe("ENG-2178");
    expect(entry.funding).toBeNull();
    expect(loadRecoveries(PERIOD)).toEqual([]);
  });

  it("returns a funded entry for its target period only", () => {
    ledger(recovery());
    expect(loadRecoveries(PERIOD).map((entry) => entry.id)).toEqual(["TEST-1"]);
    expect(loadRecoveries(PERIOD - WEEK)).toEqual([]);
  });

  it("rejects funding sent from Botmarket", () => {
    ledger(recovery({ from: BOTMARKET }));
    expect(() => loadRecoveries(PERIOD)).toThrow("Invalid direct recovery funding");
  });

  it("rejects wallet amounts that do not equal the funding", () => {
    ledger(recovery({ amount: (AMOUNT + 1n).toString() }));
    expect(() => loadRecoveries(PERIOD)).toThrow("Recovery wallet amounts do not equal funding");
  });

  it("blocks the next distribution when a funded entry missed its period", () => {
    ledger(recovery());
    expect(() => loadRecoveries(PERIOD + WEEK)).toThrow("A funded recovery missed its target distribution");
  });
});

describe("verifyRecoveryFunding", () => {
  it("accepts an isolated, confirmed direct transfer to the distributor", async () => {
    await expect(verifyRecoveryFunding(recovery(), client())).resolves.toEqual({ blockNumber: "100", blockHash: BLOCK_HASH, timestamp: PERIOD + 3600 });
  });

  it("rejects funding with fewer than 12 confirmations", async () => {
    await expect(verifyRecoveryFunding(recovery(), client({ head: 111n }))).rejects.toThrow("unconfirmed or outside its target period");
  });

  it("rejects funding mined after its target period", async () => {
    await expect(verifyRecoveryFunding(recovery(), client({ timestamp: PERIOD + WEEK }))).rejects.toThrow("unconfirmed or outside its target period");
  });

  it("rejects a funding transaction that also moves sdCRV out of the distributor", async () => {
    const fundingLogs = [log(5, SDCRV, DEPLOYER, DISTRIBUTOR, AMOUNT), log(6, SDCRV, DISTRIBUTOR, DEPLOYER, 1n)];
    await expect(verifyRecoveryFunding(recovery(), client({ fundingLogs }))).rejects.toThrow("isolated distributor transfer");
  });

  it("rejects a receipt whose amount differs from the ledger", async () => {
    await expect(verifyRecoveryFunding(recovery(), client({ fundingLogs: [log(5, SDCRV, DEPLOYER, DISTRIBUTOR, AMOUNT - 1n)] }))).rejects.toThrow("transfer receipt mismatch");
  });
});
