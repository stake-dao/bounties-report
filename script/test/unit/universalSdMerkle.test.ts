import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { SD_CRV, SD_FXN, SDCRV_SPACE, SDCRV_UNIVERSAL_MERKLE, SDFXN_SPACE } from "../../utils/constants";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import {
  checkV12,
  ethereumTargets,
  universalTargets,
  type UniversalFiles,
} from "../../sdTkns/verify/checkBeforeSetRoots";
import { buildDistribution } from "../../sdTkns/prepareDistribution";
import { compareUniversalWeeklyDistributions } from "../../sdTkns/verify/reconstructSdMerkle";
import { tokenTotal, weeklyDistribution } from "../../utils/merkle/universalSdMerkle";

const A = "0x1000000000000000000000000000000000000001";
const B = "0x2000000000000000000000000000000000000002";
const period = 1788393600;

const previous = generateMerkleTree({ [A]: { [SD_CRV]: parseEther("10").toString() } });
const current = generateMerkleTree({
  [A]: { [SD_CRV]: parseEther("16").toString() },
  [B]: { [SD_CRV]: parseEther("4").toString() },
});

function entry(overrides: Record<string, unknown> = {}) {
  return {
    space: SDCRV_SPACE, symbol: "sdCRV", token: SD_CRV, distributor: SDCRV_UNIVERSAL_MERKLE,
    file: "sdTkns/sdtkns_merkle_1_sdcrv.json", root: current.merkleRoot, previousRoot: previous.merkleRoot,
    weekly: parseEther("10").toString(), total: parseEther("20").toString(), previousTotal: parseEther("10").toString(),
    ...overrides,
  };
}

const files: UniversalFiles = new Map([["sdTkns/sdtkns_merkle_1_sdcrv.json", { current, previous, previousFile: `bounties-reports/${period - 604800}/sdTkns/sdtkns_merkle_1_sdcrv.json` }]]);

describe("universal sdToken merkles", () => {
  it("parses log.Universal against the constants", () => {
    const [parsed] = universalTargets({ Universal: [entry()] });
    expect(parsed.weekly).toBe(parseEther("10"));
    expect(parsed.distributor).toBe(SDCRV_UNIVERSAL_MERKLE.toLowerCase());
    expect(universalTargets({})).toEqual([]);
    for (const bad of [
      { distributor: "0x0000000000000000000000000000000000000001" },
      { file: "sdTkns/sdtkns_merkle_1_sdfxn.json" },
      { space: SDFXN_SPACE },
      { total: parseEther("21").toString() },
      { weekly: "0", total: parseEther("10").toString() },
    ]) {
      expect(() => universalTargets({ Universal: [entry(bad)] })).toThrow();
    }
  });

  it("accepts a week without legacy targets when universal targets exist", () => {
    const log = { Transactions: [{ network: "ethereum", tokenAddressesToFreeze: [], newMerkleRoots: [] }], Universal: [entry()] };
    expect(ethereumTargets(log)).toEqual({ tokens: [], roots: [] });
    expect(() => ethereumTargets({ Transactions: [] })).toThrow(/no ethereum entry/);
  });

  it("V12 rebuilds the cumulative file and its weekly delta", () => {
    const [parsed] = universalTargets({ Universal: [entry()] });
    expect(checkV12([parsed], files).ok).toBe(true);
    const shrunk = generateMerkleTree({ [A]: { [SD_CRV]: parseEther("9").toString() }, [B]: { [SD_CRV]: parseEther("11").toString() } });
    const [bad] = universalTargets({ Universal: [entry({ root: shrunk.merkleRoot })] });
    expect(() => checkV12([bad], new Map([["sdTkns/sdtkns_merkle_1_sdcrv.json", { current: shrunk, previous }]]))).toThrow(/decreased/);
    const foreign = generateMerkleTree({ [A]: { [SD_CRV]: parseEther("16").toString() }, [B]: { [SD_FXN]: parseEther("4").toString() } });
    expect(() => tokenTotal(foreign, SD_CRV)).toThrow(/foreign token/);
  });

  it("funds the universal delta from Botmarket next to the legacy shortfall", () => {
    const sdCRV = SD_CRV.toLowerCase();
    const root = `0x${"11".repeat(32)}`;
    const log = {
      period, postFreeze: true, DistributionSurplus: { sdCRV: 0 },
      Transactions: [{ network: "ethereum", tokenAddressesToFreeze: [sdCRV], newMerkleRoots: [root] }],
      Universal: [entry()],
    };
    const merkle = [{ symbol: "sdCRV", chainId: 1, address: sdCRV, root, total: "100", merkle: { [sdCRV]: { amount: "100" } }, merkleContract: "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4" }];
    const enough = new Map([[sdCRV, [60n, 40n + parseEther("10")] as const]]);
    const result = buildDistribution(log, merkle, period, true, enough, files);
    expect(result.tokens[0].maxFunding).toBe("40");
    expect(result.universal).toEqual([{
      distributor: SDCRV_UNIVERSAL_MERKLE.toLowerCase(), token: sdCRV, file: "sdTkns/sdtkns_merkle_1_sdcrv.json",
      previousRoot: previous.merkleRoot, previousFile: `bounties-reports/${period - 604800}/sdTkns/sdtkns_merkle_1_sdcrv.json`,
      root: current.merkleRoot.toLowerCase(), total: parseEther("20").toString(), maxFunding: parseEther("10").toString(),
    }]);
    const short = new Map([[sdCRV, [60n, 39n + parseEther("10")] as const]]);
    expect(() => buildDistribution(log, merkle, period, true, short, files)).toThrow(/insufficient funding/);
    const universalOnly = { ...log, Transactions: [{ network: "ethereum", tokenAddressesToFreeze: [], newMerkleRoots: [] }] };
    expect(buildDistribution(universalOnly, merkle, period, true, new Map([[sdCRV, [60n, parseEther("10")] as const]]), files).tokens).toEqual([]);
    expect(() => buildDistribution(universalOnly, merkle, period, true, new Map([[sdCRV, [60n, parseEther("9")] as const]]), files)).toThrow(/insufficient funding/);
  });

  it("V2 compares the rebuilt diverted share with the file delta", () => {
    const [parsed] = universalTargets({ Universal: [entry()] });
    const diverted = new Map([[SDCRV_SPACE, { [A]: 6, [B]: 4 }]]);
    expect(compareUniversalWeeklyDistributions([parsed], files, diverted)).toEqual([]);
    expect(compareUniversalWeeklyDistributions([parsed], files, new Map([[SDCRV_SPACE, { [A]: 7, [B]: 3 }]]))).toHaveLength(3);
    expect(weeklyDistribution({ [A]: 1e-9 }, SD_CRV)).toEqual({});
  });

});
