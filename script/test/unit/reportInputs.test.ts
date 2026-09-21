import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCurveReportInputs } from "../../sdTkns/verify/reportInputs";
import { ALL_MIGHT_V2, BOTMARKET } from "../../utils/reportUtils";

const transaction = `0x${"1".repeat(64)}`;
const router = `0x${"2".repeat(40)}`;
const token = `0x${"3".repeat(40)}`;
const period = 1789603200;
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: (file: any, ...args: any[]) => {
    if (String(file).endsWith(`${period}/curve.csv`)) return `Reward Address;Reward Amount\n${token};10.000000\n`;
    if (String(file).endsWith(`${period}/curve-attribution.json`)) return JSON.stringify({ txs: [{ tx: transaction }] });
    return original.readFileSync(file, ...args);
  } };
});

function transfer(from: string, to: string, units: bigint, hash = transaction) {
  return { transactionHash: hash, args: { from, to, value: units * 10n ** 18n } };
}
let incoming = [transfer(BOTMARKET, ALL_MIGHT_V2, 10n)];
let outgoing = [transfer(ALL_MIGHT_V2, router, 10n)];
afterEach(() => {
  incoming = [transfer(BOTMARKET, ALL_MIGHT_V2, 10n)];
  outgoing = [transfer(ALL_MIGHT_V2, router, 10n)];
});
const client = {
  readContract: async () => 18,
  getBlockNumber: async () => 3n,
  getBlock: async ({ blockNumber }: any) => ({ timestamp: [0n, BigInt(period), BigInt(period + 604799), BigInt(period + 604800)][Number(blockNumber)] }),
  getLogs: async ({ args }: any) => args.to ? incoming : outgoing,
} as any;

describe("Curve conversion input completeness", () => {
  it("accepts fully consumed rewards and extra accumulated dust", async () => {
    expect(await verifyCurveReportInputs(period, client)).toBe(1);
    incoming[0] = transfer(BOTMARKET, ALL_MIGHT_V2, 11n);
    outgoing[0] = transfer(ALL_MIGHT_V2, router, 11n);
    expect(await verifyCurveReportInputs(period, client)).toBe(1);
  });
  it("rejects a partial conversion even when the full claim was forwarded", async () => {
    outgoing[0] = transfer(ALL_MIGHT_V2, router, 9n);
    await expect(verifyCurveReportInputs(period, client)).rejects.toThrow(/not fully consumed/);
  });
  it("rejects claims funded in a transaction missing from the conversion report", async () => {
    incoming[0] = transfer(BOTMARKET, ALL_MIGHT_V2, 10n, `0x${"4".repeat(64)}`);
    await expect(verifyCurveReportInputs(period, client)).rejects.toThrow(/not fully consumed/);
  });
  it("nets intermediate native-token receipts against outgoing conversions", async () => {
    incoming.push(transfer(router, ALL_MIGHT_V2, 5n));
    outgoing[0] = transfer(ALL_MIGHT_V2, router, 15n);
    expect(await verifyCurveReportInputs(period, client)).toBe(1);
    outgoing[0] = transfer(ALL_MIGHT_V2, router, 14n);
    await expect(verifyCurveReportInputs(period, client)).rejects.toThrow(/not fully consumed/);
  });
  it("does not count refunded rewards as consumed", async () => {
    outgoing = [transfer(ALL_MIGHT_V2, router, 9n), transfer(ALL_MIGHT_V2, BOTMARKET, 1n)];
    await expect(verifyCurveReportInputs(period, client)).rejects.toThrow(/not fully consumed/);
  });
});
