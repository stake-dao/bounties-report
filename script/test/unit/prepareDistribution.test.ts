import { describe, expect, it } from "vitest";
import { buildDistribution } from "../../sdTkns/prepareDistribution";

const sdCRV = "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5";
const root = `0x${"11".repeat(32)}`;
const period = 1788393600;
const log = {
  period, postFreeze: true,
  Transactions: [{ network: "ethereum", tokenAddressesToFreeze: [sdCRV], newMerkleRoots: [root] }],
};
const merkle = [{ chainId: 1, address: sdCRV, root, total: "100", merkle: { [sdCRV]: { amount: "100" } }, merkleContract: "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4" }];

describe("guard distribution artifact", () => {
  it("uses integer liabilities and caps the exact shortfall", () => {
    const result = buildDistribution(log, merkle, period, true, new Map([[sdCRV.toLowerCase(), [60n, 50n]]]));
    expect(result.tokens[0]).toEqual({ address: sdCRV.toLowerCase(), root, total: "100", maxFunding: "40" });
    expect(result.verified).toBe(true);
  });

  it("rejects stale and pre-freeze logs for submission", () => {
    expect(() => buildDistribution({ ...log, period: period - 604800 }, merkle, period, true, new Map())).toThrow();
    expect(() => buildDistribution({ ...log, postFreeze: false }, merkle, period, true, new Map())).toThrow();
  });

  it("rejects underfunding and foreign distributors", () => {
    expect(() => buildDistribution(log, merkle, period, true, new Map([[sdCRV.toLowerCase(), [60n, 30n]]]))).toThrow(/fund/);
    expect(() => buildDistribution(log, [{ ...merkle[0], merkleContract: sdCRV }], period, true, new Map())).toThrow(/distributor/);
  });

  it("rejects unknown tokens and duplicate targets", () => {
    const tx = log.Transactions[0];
    expect(() => buildDistribution({ ...log, Transactions: [{ ...tx, tokenAddressesToFreeze: ["0x0000000000000000000000000000000000000001"] }] }, merkle, period, true, new Map())).toThrow();
    expect(() => buildDistribution({ ...log, Transactions: [{ ...tx, tokenAddressesToFreeze: [sdCRV, sdCRV], newMerkleRoots: [root, root] }] }, merkle, period, true, new Map())).toThrow(/duplicate/);
  });

  it("rejects an understated liability even when the declared total is funded", () => {
    expect(() => buildDistribution(log, [{ ...merkle[0], total: "99" }], period, true, new Map([[sdCRV.toLowerCase(), [100n, 0n]]]))).toThrow(/liability/);
  });
});
