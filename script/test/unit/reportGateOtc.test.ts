import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseUnits, toHex } from "viem";
import { runR2, runR4, verifyCurveInputs } from "../../sdTkns/verify/reportGate";
import { checkSdAttribution } from "../../sdTkns/verify/reconstructSdMerkle";
import { readOtcLanes, type OtcLane } from "../../sdTkns/verify/reportOtc";
import { loadCompletion } from "../../reports/guardCompletion";
import processOTCReport from "../../reports/processOTCReport";

const files = vi.hoisted(() => new Map<string, string | null>());
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: (file: any) => files.has(String(file)) ? files.get(String(file)) !== null : original.existsSync(file),
    readFileSync: (file: any, ...args: any[]) => files.get(String(file)) ?? original.readFileSync(file, ...args),
  };
});
afterEach(() => files.clear());

const PERIOD = 1790208000;
const DIR = `bounties-reports/${PERIOD}`;
const OTC_CSV = `${DIR}/curve-otc.csv`;
const HEADER = "Period;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const REGISTRY = "0x9cc16bdd233a74646e31100b2f13334810d12cb0";
const ALL_MIGHT_V2 = "0xdbd24b092f686b12650ec1450e3a7138f714506c";
const BOTMARKET = "0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff";
const PARASWAP = "0x6a000f20005980200259b80c5102003040001068";
const CRV_WETH_POOL = "0x919fa96e88d67499339577fa202345436bcdaf79";
const SD_POOL = "0xca0253a98d16e9c1e3614cafda19318ee69772d0";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CRV = "0xd533a949740bb3306d119cc777fa900ba034cd52";
const SDCRV = "0xd1b5651e55d4ceed36251c61c50c889b36f6abb5";
const OTC_TX = "0xd19c74b131395da911f098d80afb22d24874da13596307c1e6fc5866ebb82466";
const SD_DELIVERED = 1206456434218249062538n;
const OTCS: Record<string, { gauge: string; amount: bigint }> = {
  436: { gauge: "0x1211B5cB09Ba1aDa8F11de757d5a13C5CA407162", amount: 88595450410828053n },
  437: { gauge: "0xB84637aB9Be835580821A67823f414FFd0bbf625", amount: 31249571521814n },
};
// The curve-otc.csv the 2026-09-28 OTC run generated for these two releases.
const OTC_ROWS = [
  `${PERIOD};sdUSD+frxUSD ;${OTCS[436].gauge};WETH;0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;0.088595;1206.031040;99.96`,
  `${PERIOD};WETH+SDT ;${OTCS[437].gauge};WETH;0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;0.000031;0.425394;0.04`,
];
const otcReport = (rows: string[] = OTC_ROWS) => files.set(OTC_CSV, [HEADER, ...rows].join("\n"));

const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: word(value) });
// Transfers in 0xd19c…: WETH released to AllMight, sold for CRV through ParaSwap, CRV swapped to sdCRV, sdCRV sent to Botmarket.
const OTC_LOGS = [
  transfer(WETH, REGISTRY, ALL_MIGHT_V2, OTCS[436].amount),
  transfer(WETH, REGISTRY, ALL_MIGHT_V2, OTCS[437].amount),
  transfer(CRV, CRV_WETH_POOL, PARASWAP, 0x23cf71f8c0e34980a1n),
  transfer(WETH, ALL_MIGHT_V2, CRV_WETH_POOL, 0x013a8ce89717d020n),
  transfer(CRV, PARASWAP, "0x00700052c0608f670705380a4900e0a8080010cc", 0xeaafc4d503c542n),
  transfer(CRV, PARASWAP, ALL_MIGHT_V2, 660517986320911809375n),
  transfer(CRV, ALL_MIGHT_V2, SD_POOL, 660517986320911809375n),
  transfer(SDCRV, SD_POOL, ALL_MIGHT_V2, SD_DELIVERED),
  transfer(SDCRV, ALL_MIGHT_V2, BOTMARKET, SD_DELIVERED),
];

const sixDecimals = new Set([
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7",
  "0x501ebf66d76a96d4fb26ccead42957653e16b8b8", "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
]);
const attribution = () => JSON.parse(readFileSync(`${DIR}/curve-attribution.json`, "utf8"));
// Botmarket sdCRV inflows of the week: every attributed conversion, then the OTC swap.
const inflows = () => [
  ...attribution().txs.map((tx: any) => ({ hash: tx.tx as string, amount: parseUnits(tx.sdIn.toFixed(18), 18) })),
  { hash: OTC_TX, amount: SD_DELIVERED },
];
const client = (logs = inflows()) => ({
  getBlockNumber: async () => 3n,
  getBlock: async ({ blockNumber }: any) => ({ timestamp: [0n, BigInt(PERIOD), BigInt(PERIOD + 604799), BigInt(PERIOD + 604800)][Number(blockNumber)] }),
  getLogs: async ({ address }: any) => address.toLowerCase() !== REGISTRY ? [] : Object.entries(OTCS).map(([id, otc], index) => ({
    args: { id: BigInt(id), withdrawer: ALL_MIGHT_V2, amount: otc.amount }, transactionHash: OTC_TX, logIndex: 0x169 + 2 * index, blockNumber: 2n,
  })),
  readContract: async ({ address, functionName, args }: any) => functionName === "otcs"
    ? ["0x0000000a3Fc396B89e4c11841B39D9dff85a5D05", "Curve", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", OTCS[String(args[0])].gauge, 1n, OTCS[String(args[0])].amount, 1790623624n, 1n, OTCS[String(args[0])].amount]
    : sixDecimals.has(address.toLowerCase()) ? 6 : 18,
  getTransactionReceipt: async () => ({ status: "success", logs: OTC_LOGS }),
  request: async () => logs.map((log, index) => ({ data: word(log.amount), transactionHash: log.hash, logIndex: toHex(index) })),
}) as any;

describe("OTC lane gate", () => {
  it("reconciles the 1790208000 OTC release, swap and allocation instead of failing them as unclaimed", async () => {
    otcReport();
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    expect(otc.curve.withdrawals).toHaveLength(2);
    expect(otc.curve.delivered).toEqual(new Map([[OTC_TX, SD_DELIVERED]]));
    expect(otc.curve.nativeIn).toBe(660517986320911809375n);
    const claims = await runR2(PERIOD, ["curve"], client(), undefined, otc);
    expect(claims.ok, claims.detail).toBe(true);
    const weights = runR4(PERIOD, ["curve"], undefined, otc);
    expect(weights.ok, weights.detail).toBe(true);
    expect((await checkSdAttribution(PERIOD, client(), ["curve"], "botmarket", undefined, otc)).detail).toContain("otc=1206.456434218249062538");
  });

  it("rejects OTC rows the registry did not release, released OTCs without rows and changed amounts", async () => {
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    const cases: Array<[string[], string]> = [
      [[...OTC_ROWS, OTC_ROWS[1].replace(OTCS[437].gauge, "0x0000000000000000000000000000000000000001")], "OTC row has no registry withdrawal"],
      [[OTC_ROWS[0]], "OTC withdrawal has no report row"],
      [[OTC_ROWS[0].replace(";0.088595;", ";0.098595;"), OTC_ROWS[1]], "OTC reward amount differs from the registry withdrawal"],
    ];
    for (const [rows, reason] of cases) {
      otcReport(rows);
      const result = await runR2(PERIOD, ["curve"], client(), undefined, otc);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain(reason);
    }
  });

  it("rejects OTC proceeds moved between OTC gauges even when the lane total holds", async () => {
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    otcReport([OTC_ROWS[0].replace("1206.031040", "1205.031040"), OTC_ROWS[1].replace("0.425394", "1.425394")]);
    await expect(checkSdAttribution(PERIOD, client(), ["curve"], "botmarket", undefined, otc)).resolves.toMatchObject({ ok: true });
    const result = runR4(PERIOD, ["curve"], undefined, otc);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("OTC allocation differs");
  });

  it("rejects OTC rows that do not add up to the OTC swap's delivery", async () => {
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    otcReport([OTC_ROWS[0].replace("1206.031040", "1216.031040"), OTC_ROWS[1]]);
    await expect(checkSdAttribution(PERIOD, client(), ["curve"], "botmarket", undefined, otc)).rejects.toThrow(/OTC/);
  });

  it("lets a released OTC await its report under the weekly completion proof, and requires its rows otherwise", async () => {
    files.set(OTC_CSV, null);
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    const proof = loadCompletion(`${DIR}/curve-completion.json`, "curve");
    const weekly = await runR2(PERIOD, ["curve"], client(), proof, otc);
    expect(weekly.ok, weekly.detail).toBe(true);
    expect(weekly.warnings?.join("\n")).toContain("awaits the OTC report");
    const final = await runR2(PERIOD, ["curve"], client(), undefined, otc);
    expect(final.ok).toBe(false);
    expect(final.detail).toContain("OTC withdrawal has no report row");
  });

  it("keeps an OTC swap inside the completion window out of the vault's own deliveries", async () => {
    files.set(OTC_CSV, null);
    const otc = await readOtcLanes(PERIOD, ["curve"], client());
    const proof = loadCompletion(`${DIR}/curve-completion.json`, "curve");
    const logs = inflows();
    // The JSON sidecar keeps doubles; pin the vault's own deliveries to the proof's exact total.
    const own = logs.slice(0, -1);
    own[own.length - 1].amount += BigInt(proof.sdDelivered) - own.reduce((sum, log) => sum + log.amount, 0n);
    await expect(checkSdAttribution(PERIOD, client(logs), ["curve"], "botmarket", proof, otc)).resolves.toMatchObject({ ok: true });
  });

  it("credits WETH, native and sd OTC bounties exactly like the OTC report", () => {
    // One swap releases 2 + 1 WETH, 100 CRV and 50 sdCRV; the WETH buys 9000 CRV and 9100 CRV become 16380 sdCRV.
    const gauges = ["a1", "a2", "a3", "a4"].map((suffix) => `0x${suffix.padStart(40, "0")}`);
    const bounties = ([[WETH, "2"], [WETH, "1"], [CRV, "100"], [SDCRV, "50"]] as const).map(([token, amount], index) => ({
      bountyId: String(index), gauge: gauges[index], rewardToken: token, amount: parseUnits(amount, 18).toString(), gaugeName: `G${index}`,
    }));
    let logIndex = 0;
    const swap = (token: string, from: string, to: string, amount: string) => ({
      blockNumber: 7, logIndex: logIndex++, from, to, token, amount: parseUnits(amount, 18), transactionHash: OTC_TX, formattedAmount: Number(amount), symbol: "",
    });
    const swapsIn = [
      swap(WETH, REGISTRY, ALL_MIGHT_V2, "2"), swap(WETH, REGISTRY, ALL_MIGHT_V2, "1"), swap(CRV, REGISTRY, ALL_MIGHT_V2, "100"),
      swap(SDCRV, REGISTRY, ALL_MIGHT_V2, "50"), swap(CRV, PARASWAP, ALL_MIGHT_V2, "9000"), swap(SDCRV, SD_POOL, ALL_MIGHT_V2, "16380"),
    ];
    const swapsOut = [swap(WETH, ALL_MIGHT_V2, CRV_WETH_POOL, "3"), swap(CRV, ALL_MIGHT_V2, SD_POOL, "9100"), swap(SDCRV, ALL_MIGHT_V2, BOTMARKET, "16430")];
    const infos = Object.fromEntries([[WETH, "WETH"], [CRV, "CRV"], [SDCRV, "sdCRV"]].map(([token, symbol]) => [token, { symbol, decimals: 18 }]));
    const { curve } = processOTCReport(1, swapsIn, swapsOut, { curve: bounties }, infos, []);
    const shared = curve.filter((row) => ![CRV, SDCRV].includes(row.rewardAddress));
    const base = shared.reduce((sum, row) => sum + row.rewardSdValue, 0);
    const rows = curve.map((row) => [PERIOD, row.gaugeName, row.gaugeAddress, row.rewardToken, row.rewardAddress, row.rewardAmount.toFixed(6),
      row.rewardSdValue.toFixed(6), shared.includes(row) ? (row.rewardSdValue / base * 100).toFixed(2) : "0.00"].join(";"));
    const lane: OtcLane = {
      withdrawals: bounties.map((bounty) => ({ gauge: bounty.gauge, token: bounty.rewardToken, amount: BigInt(bounty.amount) })),
      delivered: new Map([[OTC_TX, parseUnits("16430", 18)]]),
      nativeIn: parseUnits("9100", 18),
    };
    otcReport(rows);
    const result = runR4(PERIOD, ["curve"], undefined, { curve: lane });
    expect(result.ok, result.detail).toBe(true);
    // The released CRV credited 1:1 instead of at the swap's rate, the difference parked on a WETH gauge.
    otcReport(rows.map((row) => row.replace(";180.000000;", ";100.000000;").replace(";10800.000000;", ";10880.000000;")));
    expect(runR4(PERIOD, ["curve"], undefined, { curve: lane }).detail).toContain("OTC allocation differs");
  });
});

describe("Curve input check on a Guard week", () => {
  const untouched = new Proxy({}, { get: () => { throw new Error("vault inputs read"); } }) as any;

  it("relies on the published Guard proof while the report it certified is unchanged", async () => {
    expect(await verifyCurveInputs(PERIOD, untouched)).toContain("published Guard completion");
    files.set(`${DIR}/curve.csv`, readFileSync(`${DIR}/curve.csv`, "utf8").replace("1693.653428", "1693.653429"));
    await expect(verifyCurveInputs(PERIOD, untouched)).rejects.toThrow(/changed since its Guard completion was published/);
  });

  it("keeps the vault check for legacy weeks and leaves an explicit proof to the completion", async () => {
    await expect(verifyCurveInputs(1789603200, untouched)).rejects.toThrow("vault inputs read");
    expect(await verifyCurveInputs(PERIOD, untouched, loadCompletion(`${DIR}/curve-completion.json`, "curve"))).toBe("");
  });
});
