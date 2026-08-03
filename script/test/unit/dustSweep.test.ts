import { describe, it, expect } from "vitest";
import {
  processSwaps,
  isDustSweepTx,
  distributeSweepSd,
  BOTMARKET,
} from "../../utils/reportUtils";

// Real shapes from period 1785369600: main batch 0xad58a9a3 (BOTMARKET forwards
// bounties, sd comes back) followed by anti-dust sweep 0xf4227776 (WETH residue
// already in the aggregator -> CRV -> sdCRV -> BOTMARKET, no BOTMARKET input).
const AM2 = "0xDBd24b092f686b12650EC1450e3A7138F714506c";
const DEPOSITOR = "0xca0253a98d16e9c1e3614cafda19318ee69772d0";
const POOL = "0x111116053f09d34a7eae8102887004445176ca11";
const SDCRV = "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DOLA = "0x865377367054516e17014CcdED1e7d814EDC9ce4";

const BATCH_TX = "0xbatch";
const SWEEP_TX = "0xsweep";
const OTC_TX = "0xotc";

const tokenInfos = {
  [SDCRV.toLowerCase()]: { symbol: "sdCRV", decimals: 18 },
  [CRV.toLowerCase()]: { symbol: "CRV", decimals: 18 },
  [WETH.toLowerCase()]: { symbol: "WETH", decimals: 18 },
};

const swap = (
  blockNumber: number,
  logIndex: number,
  token: string,
  from: string,
  to: string,
  amount: bigint,
  transactionHash: string
) => ({ blockNumber, logIndex, from, to, token, amount, transactionHash });

// Swap-ins: transfers to the aggregator; swap-outs: transfers from it
const swapIn = [
  swap(100, 1, WETH, BOTMARKET, AM2, 2n * 10n ** 18n, BATCH_TX),
  swap(100, 5, SDCRV, DEPOSITOR, AM2, 31468n * 10n ** 18n, BATCH_TX),
  swap(101, 2, CRV, POOL, AM2, 93n * 10n ** 18n, SWEEP_TX),
  swap(101, 4, SDCRV, DEPOSITOR, AM2, 155n * 10n ** 18n, SWEEP_TX),
];
const swapOut = [
  swap(100, 6, SDCRV, AM2, BOTMARKET, 31468n * 10n ** 18n, BATCH_TX),
  swap(101, 1, WETH, AM2, POOL, 10386n * 10n ** 12n, SWEEP_TX),
  swap(101, 3, CRV, AM2, DEPOSITOR, 93n * 10n ** 18n, SWEEP_TX),
  swap(101, 5, SDCRV, AM2, BOTMARKET, 155n * 10n ** 18n, SWEEP_TX),
];

describe("processSwaps markerSwaps", () => {
  it("drops sweep swap-ins when markers only come from the in-array (legacy behavior)", () => {
    const filtered = processSwaps(swapIn, tokenInfos);
    const txs = new Set(filtered.map((s) => s.transactionHash));
    expect(txs.has(BATCH_TX)).toBe(true);
    expect(txs.has(SWEEP_TX)).toBe(false);
  });

  it("keeps sweep swap-ins when markers are scanned over both directions", () => {
    const markerSwaps = [...swapIn, ...swapOut];
    const filtered = processSwaps(swapIn, tokenInfos, { markerSwaps });
    const sweepSdIn = filtered.filter(
      (s) =>
        s.transactionHash === SWEEP_TX &&
        s.token.toLowerCase() === SDCRV.toLowerCase()
    );
    expect(sweepSdIn).toHaveLength(1);
    expect(sweepSdIn[0].formattedAmount).toBe(155);
    // BOTMARKET-sourced transfers stay excluded as rows even though they mark blocks
    expect(
      filtered.some((s) => s.from.toLowerCase() === BOTMARKET.toLowerCase())
    ).toBe(false);
  });
});

describe("isDustSweepTx", () => {
  it("flags sd sent to BOTMARKET without any BOTMARKET input", () => {
    expect(isDustSweepTx(SWEEP_TX, swapIn, swapOut, SDCRV, BOTMARKET)).toBe(
      true
    );
  });

  it("does not flag regular batches (BOTMARKET forwards bounties in)", () => {
    expect(isDustSweepTx(BATCH_TX, swapIn, swapOut, SDCRV, BOTMARKET)).toBe(
      false
    );
  });

  it("does not flag txs whose sd goes elsewhere (e.g. vlCVX recipient)", () => {
    const otherIn = [swap(102, 1, SDCRV, DEPOSITOR, AM2, 10n ** 18n, OTC_TX)];
    const otherOut = [swap(102, 2, SDCRV, AM2, POOL, 10n ** 18n, OTC_TX)];
    expect(isDustSweepTx(OTC_TX, otherIn, otherOut, SDCRV, BOTMARKET)).toBe(
      false
    );
  });
});

describe("distributeSweepSd", () => {
  it("spreads pro-rata over non-native attributed sd", () => {
    const sdByToken = {
      [CRV.toLowerCase()]: 7306,
      [USDC.toLowerCase()]: 300,
      [DOLA.toLowerCase()]: 100,
    };
    const spread = distributeSweepSd(sdByToken, 40, CRV, WETH);
    expect(spread[USDC.toLowerCase()]).toBeCloseTo(30);
    expect(spread[DOLA.toLowerCase()]).toBeCloseTo(10);
    expect(spread[CRV.toLowerCase()]).toBeUndefined();
    const total = Object.values(spread).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(40);
  });

  it("falls back to WETH when nothing but native was attributed", () => {
    const spread = distributeSweepSd({ [CRV.toLowerCase()]: 7306 }, 40, CRV, WETH);
    expect(spread).toEqual({ [WETH.toLowerCase()]: 40 });
  });

  it("returns nothing for zero sweep sd", () => {
    expect(distributeSweepSd({ [USDC.toLowerCase()]: 1 }, 0, CRV, WETH)).toEqual(
      {}
    );
  });
});
