import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateExact,
  computeDirectWeights,
} from "../../vlCVX/3_merkles/directForwarderPayouts";

const USER_A = "0x1732951b80c737dbb8f367e83e530623bb612e54";
const USER_A_CHECKSUMMED = "0x1732951b80C737dBb8F367e83E530623bB612E54";
const USER_B = "0x6cd1b82490eb7aa18bec4305c6c2e691194c6898";
const USER_B_CHECKSUMMED = "0x6CD1B82490Eb7aA18beC4305C6c2E691194C6898";
const TOKEN = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";

// Last real pre-pause artifact, kept in-tree — the exact shape the pipeline reads
const REAL_FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../weekly-bounties/1770249600/votium/forwarders_voted_rewards.json",
);

describe("computeDirectWeights", () => {
  it("sums per-address USD micros across tokens with checksummed keys", () => {
    const { weightsMicros, totalMicros } = computeDirectWeights({
      tokenAllocations: {
        [USER_A]: {
          [TOKEN]: { amount: "1", amountWei: "1000000000000000000", usd: 0.25 },
          "0xdBdb4d16EdA451D0503b854CF79D55697F90c8DF": {
            amount: "2",
            amountWei: "2000000000000000000",
            usd: 1.75,
          },
        },
        [USER_B]: {
          [TOKEN]: { amount: "3", amountWei: "3000000000000000000", usd: 6 },
        },
      },
    });

    expect(weightsMicros).toEqual({
      [USER_A_CHECKSUMMED]: 2_000_000n,
      [USER_B_CHECKSUMMED]: 6_000_000n,
    });
    expect(totalMicros).toBe(8_000_000n);
  });

  it("sums duplicate casings of the same address instead of overwriting", () => {
    const { weightsMicros, totalMicros } = computeDirectWeights({
      tokenAllocations: {
        [USER_A]: { [TOKEN]: { usd: 1 } },
        [USER_A_CHECKSUMMED]: { [TOKEN]: { usd: 2 } },
      },
    });

    expect(Object.keys(weightsMicros)).toEqual([USER_A_CHECKSUMMED]);
    expect(weightsMicros[USER_A_CHECKSUMMED]).toBe(3_000_000n);
    expect(totalMicros).toBe(3_000_000n);
  });

  it("skips invalid, missing, non-finite and non-positive usd values without throwing", () => {
    const { weightsMicros, totalMicros } = computeDirectWeights({
      tokenAllocations: {
        [USER_A]: {
          a: { usd: 0 },
          b: { usd: -5 },
          c: { usd: Number.NaN },
          d: { usd: Number.POSITIVE_INFINITY },
          e: { usd: "12" },
          f: {},
          g: { usd: 1e-9 }, // rounds to 0 micros -> no weight
        },
        [USER_B]: { [TOKEN]: { usd: 0.5 } },
      },
    });

    expect(weightsMicros).toEqual({ [USER_B_CHECKSUMMED]: 500_000n });
    expect(totalMicros).toBe(500_000n);
  });

  it("returns empty weights for missing or malformed tokenAllocations", () => {
    for (const payload of [
      undefined,
      null,
      {},
      { tokenAllocations: null },
      { tokenAllocations: [] },
      { tokenAllocations: "nope" },
    ]) {
      const { weightsMicros, totalMicros } = computeDirectWeights(payload);
      expect(weightsMicros).toEqual({});
      expect(totalMicros).toBe(0n);
    }
  });

  it("throws on a usd value beyond the safe-integer micros range (corruption, not dust)", () => {
    expect(() =>
      computeDirectWeights({
        tokenAllocations: { [USER_A]: { [TOKEN]: { usd: 1e10 } } },
      }),
    ).toThrow("usd value out of safe range");
  });

  it("throws on an unparseable forwarder address (corruption, not dust)", () => {
    expect(() =>
      computeDirectWeights({
        tokenAllocations: { "not-an-address": { [TOKEN]: { usd: 1 } } },
      }),
    ).toThrow("invalid forwarder address");
  });

  it("reads the last real production artifact unchanged", () => {
    const raw = JSON.parse(fs.readFileSync(REAL_FIXTURE_PATH, "utf8"));
    const { weightsMicros, totalMicros } = computeDirectWeights(raw);

    // The two Union delegators of that round, with positive USD weights
    expect(Object.keys(weightsMicros)).toHaveLength(2);
    expect(totalMicros).toBeGreaterThan(0n);
    for (const [address, weight] of Object.entries(weightsMicros)) {
      // keys must round-trip through getAddress (EIP-55)
      expect(address).not.toBe(address.toLowerCase());
      expect(weight > 0n).toBe(true);
    }
  });
});

describe("allocateExact", () => {
  it("conserves the pool exactly and splits pro-rata", () => {
    const payouts = allocateExact(100n, {
      [USER_A_CHECKSUMMED]: 1n,
      [USER_B_CHECKSUMMED]: 3n,
    });
    expect(payouts[USER_A_CHECKSUMMED]).toBe(25n);
    expect(payouts[USER_B_CHECKSUMMED]).toBe(75n);
  });

  it("is deterministic regardless of input order, including remainder ties", () => {
    const first = allocateExact(10n, {
      [USER_A_CHECKSUMMED]: 1n,
      [USER_B_CHECKSUMMED]: 2n,
    });
    const second = allocateExact(10n, {
      [USER_B_CHECKSUMMED]: 2n,
      [USER_A_CHECKSUMMED]: 1n,
    });
    expect(first).toEqual(second);
    expect(Object.values(first).reduce((s, v) => s + v, 0n)).toBe(10n);

    // exact tie in remainders: 1 wei must go to the lexicographically-first address
    const tie1 = allocateExact(3n, { [USER_A_CHECKSUMMED]: 1n, [USER_B_CHECKSUMMED]: 1n });
    const tie2 = allocateExact(3n, { [USER_B_CHECKSUMMED]: 1n, [USER_A_CHECKSUMMED]: 1n });
    expect(tie1).toEqual(tie2);
    expect(Object.values(tie1).reduce((s, v) => s + v, 0n)).toBe(3n);
  });

  it("handles a pool smaller than the number of recipients", () => {
    const payouts = allocateExact(2n, {
      [USER_A_CHECKSUMMED]: 1n,
      [USER_B_CHECKSUMMED]: 1n,
      "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063": 1n,
    });
    const total = Object.values(payouts).reduce((s, v) => s + v, 0n);
    expect(total).toBe(2n);
    // zero-amount entries are dropped from the result
    expect(Object.values(payouts).every((v) => v > 0n)).toBe(true);
    expect(Object.keys(payouts)).toHaveLength(2);
  });

  it("supports pools far above Number.MAX_SAFE_INTEGER", () => {
    const pool = 2n ** 200n + 1n;
    const payouts = allocateExact(pool, {
      [USER_A_CHECKSUMMED]: 7n,
      [USER_B_CHECKSUMMED]: 13n,
    });
    expect(Object.values(payouts).reduce((s, v) => s + v, 0n)).toBe(pool);
  });

  it("returns empty for a zero pool and ignores zero weights", () => {
    expect(allocateExact(0n, { [USER_A_CHECKSUMMED]: 5n })).toEqual({});
    const payouts = allocateExact(9n, {
      [USER_A_CHECKSUMMED]: 3n,
      [USER_B_CHECKSUMMED]: 0n,
    });
    expect(payouts).toEqual({ [USER_A_CHECKSUMMED]: 9n });
  });

  it("fails closed on invalid inputs", () => {
    expect(() => allocateExact(-1n, { [USER_A_CHECKSUMMED]: 1n })).toThrow(
      "negative pool",
    );
    expect(() => allocateExact(1n, { [USER_A_CHECKSUMMED]: -1n })).toThrow(
      "negative weight",
    );
    expect(() => allocateExact(1n, {})).toThrow("zero total weight");
    expect(() =>
      allocateExact(1n, { [USER_A_CHECKSUMMED]: 0n }),
    ).toThrow("zero total weight");
  });
});
