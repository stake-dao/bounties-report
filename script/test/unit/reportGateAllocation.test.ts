import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseUnits } from "viem";
import { runR1, runR2, runR4, runR5, wethResidual, formatReportGateMessages } from "../../sdTkns/verify/reportGate";
import { checkSdAttribution } from "../../sdTkns/verify/reconstructSdMerkle";

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

const PERIOD = 1789603200;
const CSV = `bounties-reports/${PERIOD}/curve.csv`;
const ATTR = `bounties-reports/${PERIOD}/curve-attribution.json`;
const sixDecimals = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x501ebf66d76a96d4fb26ccead42957653e16b8b8", "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
]);
const attr = () => JSON.parse(readFileSync(ATTR, "utf8"));
const client = {
  readContract: async ({ address }: any) => sixDecimals.has(address.toLowerCase()) ? 6 : 18,
  getBlockNumber: async () => 3n,
  getBlock: async ({ blockNumber }: any) => ({ timestamp: [0n, BigInt(PERIOD), BigInt(PERIOD + 604799), BigInt(PERIOD + 604800)][Number(blockNumber)] }),
  request: async () => attr().txs.map((tx: any, i: number) => ({
    data: `0x${parseUnits(tx.sdIn.toFixed(18), 18).toString(16)}`, transactionHash: tx.tx, logIndex: `0x${i.toString(16)}`,
  })),
};

function changeRows(change: (rows: string[][]) => void) {
  const rows = readFileSync(CSV, "utf8").trimEnd().split("\n").map((line) => line.split(";"));
  change(rows);
  files.set(CSV, rows.map((row) => row.join(";")).join("\n") + "\n");
}

describe("Report allocation gates", () => {
  it("keeps valid high volume advisory and compares tokens separately", () => {
    const result = runR1(PERIOD, ["curve"]);
    expect(result.ok).toBe(true);
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it("accepts this week's actual allocations, including favorable swaps", async () => {
    expect((await runR2(PERIOD, ["curve"], client as any)).ok).toBe(true);
    expect(runR4(PERIOD, ["curve"]).ok).toBe(true);
    expect((await checkSdAttribution(PERIOD, client as any, ["curve"])).ok).toBe(true);
  });

  it("rejects changed source amounts even when gauge/token keys remain", async () => {
    changeRows((rows) => { rows[1][5] = "0.000000"; rows[1][4] = "0.000000"; });
    expect((await runR2(PERIOD, ["curve"], client as any)).ok).toBe(false);
  });

  it("rejects moving a gauge budget to another token while preserving the total", () => {
    changeRows((rows) => {
      rows[2][5] = (Number(rows[1][5]) + Number(rows[2][5])).toFixed(6);
      rows[1][5] = "0.000000";
    });
    expect(runR4(PERIOD, ["curve"]).ok).toBe(false);
  });

  it("rejects shifting rewards between gauges of the same token", () => {
    changeRows((rows) => {
      rows[1][5] = (Number(rows[1][5]) - 100).toFixed(6);
      rows[5][5] = (Number(rows[5][5]) + 100).toFixed(6);
    });
    expect(runR4(PERIOD, ["curve"]).ok).toBe(false);
  });

  it("rejects a fabricated printed share percentage", () => {
    changeRows((rows) => { rows[1][6] = "99.99"; });
    expect(runR4(PERIOD, ["curve"]).ok).toBe(false);
  });

  it("rejects a sidecar that duplicates a conversion", () => {
    const data = attr(); data.txs.push(data.txs[0]); files.set(ATTR, JSON.stringify(data));
    expect(runR4(PERIOD, ["curve"]).ok).toBe(false);
  });

  it("rejects conversion allocations that do not follow their WETH input weights", () => {
    const data = attr();
    const tx = data.txs.find((entry: any) => Object.keys(entry.tokenWeth).length > 0);
    tx.tokenWeth[Object.keys(tx.tokenWeth)[0]] *= 2;
    files.set(ATTR, JSON.stringify(data));
    expect(runR4(PERIOD, ["curve"]).ok).toBe(false);
  });

  it("checks FXN token budgets against confirmed native proceeds, even when every report total agrees", () => {
    const native = "0x365accfca291e7d3914637abf1f7635db165bb09";
    const sell = "0x5de8ab7e27f6e7a1fff3e5b337584aa43961beef";
    const proof = {
      nativeFunded: parseUnits("80", 18).toString(), sdDelivered: parseUnits("120", 18).toString(),
      transactions: [{ swaps: [{ sellToken: sell, amountOut: parseUnits("20", 18).toString() }] }],
    } as any;
    for (const source of ["votemarket", "votemarket-v2", "warden", "hiddenhand"]) {
      files.set(`weekly-bounties/${PERIOD}/${source}/claimed_bounties.json`, JSON.stringify({ fxn: source === "votemarket" ? {
        a: { gauge: "0x01", rewardToken: native, amount: parseUnits("80", 18).toString() },
        b: { gauge: "0x02", rewardToken: sell, amount: parseUnits("1000", 18).toString() },
      } : {} }));
    }
    const report = (nativeSd: number, sellSd: number) => {
      files.set(`bounties-reports/${PERIOD}/fxn.csv`, [
        readFileSync(CSV, "utf8").split("\n")[0],
        `Native;0x01;FXN;${native};80;${nativeSd};${(nativeSd / 1.2).toFixed(2)}`,
        `Sell;0x02;SDEX;${sell};1000;${sellSd};${(sellSd / 1.2).toFixed(2)}`,
      ].join("\n"));
      files.set(`bounties-reports/${PERIOD}/fxn-attribution.json`, JSON.stringify({
        protocol: "fxn", period: PERIOD, totals: { sdInTotal: 120 },
        perToken: { [native]: { sd: nativeSd }, [sell]: { sd: sellSd } },
        txs: [{ tx: `0x${"1".repeat(64)}`, sdIn: 120, tokenSd: { [native]: nativeSd, [sell]: sellSd } }],
      }));
    };
    report(96, 24);
    expect(runR4(PERIOD, ["fxn"], proof).ok).toBe(true);
    report(60, 60);
    expect(runR4(PERIOD, ["fxn"]).ok).toBe(true);
    const result = runR4(PERIOD, ["fxn"], proof);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("confirmed FXN proceeds");
  });

  it("rejects a 100 sdCRV shortfall instead of allowing 0.1%", async () => {
    changeRows((rows) => { rows[1][5] = (Number(rows[1][5]) - 100).toFixed(6); });
    await expect(checkSdAttribution(PERIOD, client as any, ["curve"])).rejects.toThrow(/CSV/);
  });

  it("rejects malformed and negative report amounts", () => {
    changeRows((rows) => { rows[1][5] = "-1"; });
    expect(() => runR4(PERIOD, ["curve"])).toThrow(/amount/i);
  });

  it("never uses cleanup to erase negative WETH residuals", () => {
    expect(wethResidual({
      totals: { sdInTotal: 0, sdAssigned: 0, wethInTotal: 1, wethOutTotal: 2 },
      cleanupTransactions: [{ residualWethConsumed: { token: 1 } }],
    })).toBeLessThanOrEqual(-1);
  });

  it("rejects WETH totals that preserve the residual but differ from the ledger", async () => {
    const data = attr(); data.totals.wethInTotal += 1; data.totals.wethOutTotal += 1;
    files.set(ATTR, JSON.stringify(data));
    expect((await runR5(PERIOD, ["curve"], 3000)).ok).toBe(false);
  });

  it("rejects substituted transaction identities even when the grand total agrees", async () => {
    const data = attr();
    const logs = await client.request();
    data.txs[0].tx = `0x${"f".repeat(64)}`;
    files.set(ATTR, JSON.stringify(data));
    await expect(checkSdAttribution(PERIOD, { ...client, request: async () => logs } as any, ["curve"])).rejects.toThrow(/transfer/);
  });

  it("escapes report notifications and keeps each message within Telegram's limit", () => {
    const messages = formatReportGateMessages([
      { id: "R5", name: "WETH ledger", ok: true, detail: "residual (<$50) & checked" },
      { id: "R1", name: "Sources", ok: true, detail: "complete", warnings: ["<large & unusual>".repeat(1000)] },
    ]);
    expect(messages.join("\n")).toContain("&lt;$50");
    expect(messages.join("\n")).not.toContain("<$50");
    expect(messages.every((message) => message.length <= 4000)).toBe(true);
  });
});
