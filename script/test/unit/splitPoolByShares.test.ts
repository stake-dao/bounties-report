import { describe, it, expect } from "vitest";
import {
  splitPoolByShares,
  applyShare,
} from "../../utils/merkle/splitPoolByShares";

// Real data from week 1781136000 (2026-06-11 incident): the legacy
// float split (BigInt(Math.floor(share * Number(pool)))) distributed
// pool + 1_802_923 wei of SDEX and pool + 323 wei of FXN, tripping the
// vlCVX Thursday preflight (merkle sum > withdraw plan).
const SDEX_POOL = 33156544916134710169173n;
const FXN_POOL = 2487609759291794853n;
const SHARES: { [address: string]: string } = {
  "0xc0c21f1ae0c7c194a76168288dd251e0cd551ac4": "0.001318983218125153",
  "0x41d7e3da4678ac1f5b7f607c9f6f2140b87adc7c": "0.1682521768965222",
  "0x181ae03a7f3f320ec1255c913c9cb63fce12f77a": "0.1509839960007886",
  "0xe99ccf02e3a3671ce4e3c176ca10a17c7c0dd2ce": "0.03516428290304468",
  "0x649f69ccd077da03dfb11f4b1daab4b625f5e9a3": "0.45650679193480004",
  "0xcb6a30e5b80f6d88c2a53b3d0fca2ff3f3b3f9fa": "0.05283140984628818",
  "0x808a8f192105d982cd0d24c1564d147fb9da5098": "0.00017448913945496364",
  "0xa04744c0bf779fdef35417503a963f79c9dc6faa": "0.0005235097218415772",
  "0x01178fccb3a6fa1fdfa4dc950e317974d071ab6b": "0.000021036768499482418",
  "0xf49126f8883208df74e9f89057b78dfbda617555": "0.0002725500721336629",
  "0xcb817e5ca5207e027f95673a41415a3f364d50c8": "0.0000842355474317864",
  "0xfc98cf4b4a2c7116551e5354d07bf205824064ee": "0.013124909616046903",
  "0xbd7316ffbaca9fae4bc1fd110641fff5223f3eb1": "0.009581085658125234",
  "0xc96c91581eeb42b636683111d76ceb1a7f68da12": "0.01287327143109956",
  "0x3a77f1490c4490ad86d54ea7be2f9e260c487d9a": "0.038716828828674554",
  "0x5dccd071ff019426f2aef9a0826726a496d3835d": "0.052525205594597314",
  "0x8885c690e316185ff91f338793dfb17c0770e1c9": "0.00091379160754342",
  "0xfa2266da1b488807fdfc9a1bfd09022f54883d90": "0.00032501939539239364",
  "0x4284219a89725ca23a9d10a4aa638b3a22724c58": "0.00005774784972168937",
  "0x38466ee37a545e7aa482f30da5776655acd76f46": "0.0009861619155959137",
  "0xd1372b50a34d613fe9c27ea85685a5166cb6ec22": "0.003004489649628639",
  "0xcf2998f3896de6f2ffc32ff482bf110c99fbe95f": "0.00015254897592984062",
  "0x857a2f9f1774e804eeb06a8b3e5e911bf86091f8": "0.0016054774287143096",
};

const sum = (rewards: { [address: string]: bigint }) =>
  Object.values(rewards).reduce((a, b) => a + b, 0n);

describe("splitPoolByShares", () => {
  it("never distributes more than the pool (SDEX regression, week 1781136000)", () => {
    const rewards = splitPoolByShares(SDEX_POOL, SHARES);
    const total = sum(rewards);
    expect(total <= SDEX_POOL).toBe(true);
    // floor-per-user leaves at most one wei of dust per address
    expect(SDEX_POOL - total < BigInt(Object.keys(SHARES).length)).toBe(true);
  });

  it("never distributes more than the pool (FXN regression, week 1781136000)", () => {
    const rewards = splitPoolByShares(FXN_POOL, SHARES);
    const total = sum(rewards);
    expect(total <= FXN_POOL).toBe(true);
    expect(FXN_POOL - total < BigInt(Object.keys(SHARES).length)).toBe(true);
  });

  it("keeps rewards proportional to shares", () => {
    const rewards = splitPoolByShares(SDEX_POOL, SHARES);
    const biggest = rewards["0x649f69ccd077da03dfb11f4b1daab4b625f5e9a3"];
    // 0.45650679193480004 of the pool, exact to ~1e-15 relative
    const approx = (SDEX_POOL * 45650679193480004n) / 10n ** 17n;
    const diff = biggest > approx ? biggest - approx : approx - biggest;
    expect(diff < SDEX_POOL / 10n ** 12n).toBe(true);
  });

  it("returns an entry for every address", () => {
    const rewards = splitPoolByShares(SDEX_POOL, SHARES);
    expect(Object.keys(rewards).sort()).toEqual(Object.keys(SHARES).sort());
  });

  it("splits exactly for simple shares", () => {
    expect(splitPoolByShares(100n, { a: "0.5", b: "0.5" })).toEqual({
      a: 50n,
      b: 50n,
    });
  });

  it("handles zero pool and empty shares", () => {
    expect(splitPoolByShares(0n, { a: "1" })).toEqual({ a: 0n });
    expect(splitPoolByShares(100n, {})).toEqual({});
  });
});

describe("applyShare", () => {
  it("floors and never exceeds total for share <= 1", () => {
    const total = 669089081336330848346894n;
    const part = applyShare(total, "0.07783431052003723");
    expect(part <= total).toBe(true);
    const approx = (total * 7783431052003723n) / 10n ** 17n;
    const diff = part > approx ? part - approx : approx - part;
    expect(diff < total / 10n ** 12n).toBe(true);
  });

  it("is exact for simple fractions", () => {
    expect(applyShare(1000n, "0.5")).toBe(500n);
    expect(applyShare(1000n, "0")).toBe(0n);
    expect(applyShare(1000n, "1")).toBe(1000n);
  });
});
