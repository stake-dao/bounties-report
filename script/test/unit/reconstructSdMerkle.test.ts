import { BigNumber, utils } from "ethers";
import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";
import { describe, expect, it } from "vitest";
import { SD_CRV } from "../../utils/constants";
import { buildTransactionLog } from "../../sdTkns/generateMerkle";
import {
  entryKey,
  recomputeMerkleRoot,
  type ClaimAwareContext,
  type MerkleEntry,
} from "../../sdTkns/verify/checkBeforeSetRoots";
import {
  attributionDestinations,
  checkAprPresence,
  compareClaimAwareWeeklyDistributions,
  compareDistributions,
  V2_HOLDER_EPSILON_WEI,
  V2_TOKEN_EPSILON_WEI,
  withinMedianBand,
} from "../../sdTkns/verify/reconstructSdMerkle";
import { eligibleDelegatorCount } from "../../utils/merkle/createMultiMerkle";

const HOLDERS = [
  "0x1000000000000000000000000000000000000001",
  "0x2000000000000000000000000000000000000002",
  "0x3000000000000000000000000000000000000003",
];

function fixtureEntry(amounts = [11n, 22n, 33n]): MerkleEntry {
  const leaves = HOLDERS.map((holder, index) =>
    utils.solidityKeccak256(["uint256", "address", "uint256"], [index, holder, amounts[index]]),
  );
  const tree = new MerkleTree(leaves, keccak256, { sort: true });
  return {
    symbol: "sdCRV",
    address: SD_CRV,
    chainId: 1,
    merkleContract: "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4",
    root: tree.getHexRoot(),
    total: BigNumber.from(amounts.reduce((sum, value) => sum + value, 0n)),
    merkle: Object.fromEntries(
      HOLDERS.map((holder, index) => [holder, {
        index,
        amount: BigNumber.from(amounts[index]),
        proof: tree.getHexProof(leaves[index]),
      }]),
    ),
  };
}

function amountEntry(amounts: Map<string, bigint>): MerkleEntry {
  return {
    symbol: "sdCRV",
    address: SD_CRV,
    chainId: 1,
    merkle: Object.fromEntries(
      [...amounts].map(([holder, amount], index) => [holder, { index, amount, proof: [] }]),
    ),
  };
}

function claimContext(
  entry: MerkleEntry,
  previousAmounts = new Map<string, bigint>(),
  claimedSince = new Map<string, bigint>(),
): ClaimAwareContext {
  return {
    previousPeriod: 1785974400,
    previousMerkle: [],
    tokens: new Map([[entryKey(entry), {
      previousAmounts,
      currentAmounts: new Map(),
      claimedSince,
      eventCount: 0,
    }]]),
  };
}

const generatedHolder = (index: number): string =>
  `0x${index.toString(16).padStart(40, "0")}`;

describe("Run 2 sdMerkle reconstruction helpers", () => {
  it("recomputes the complete sorted merkle root, including an odd leaf", () => {
    const entry = fixtureEntry();
    expect(recomputeMerkleRoot(entry)).toBe(String(entry.root).toLowerCase());
  });

  it("compares rebuilt distributions wallet-by-wallet and wei-exact", () => {
    const expected = fixtureEntry();
    expect(compareDistributions([expected], [fixtureEntry()])).toEqual([]);
    expect(compareDistributions([expected], [fixtureEntry([11n, 22n, 34n])])).toEqual([
      "sdCRV 0x3000000000000000000000000000000000000003 expected=33 current=34",
    ]);
  });

  it("accepts 1-wei V2 noise across many holders", () => {
    const expectedAmounts = new Map<string, bigint>();
    const currentAmounts = new Map<string, bigint>();
    for (let index = 1; index <= 5_000; index++) {
      const holder = generatedHolder(index);
      expectedAmounts.set(holder, 100n);
      currentAmounts.set(holder, 101n);
    }
    const expected = amountEntry(expectedAmounts);
    expect(
      compareClaimAwareWeeklyDistributions(
        [expected],
        [amountEntry(currentAmounts)],
        claimContext(expected),
      ),
    ).toEqual([]);
  });

  it("rejects a single 1e10-wei V2 holder deviation", () => {
    const holder = generatedHolder(1);
    const expected = amountEntry(new Map([[holder, 0n]]));
    const failures = compareClaimAwareWeeklyDistributions(
      [expected],
      [amountEntry(new Map([[holder, 10_000_000_000n]]))],
      claimContext(expected),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(holder);
    expect(failures[0]).toContain(`holderBound=${V2_HOLDER_EPSILON_WEI}`);
  });

  it("rejects cumulative V2 noise beyond 1e12 wei", () => {
    const expectedAmounts = new Map<string, bigint>();
    const currentAmounts = new Map<string, bigint>();
    for (let index = 1; index <= 1_001; index++) {
      const holder = generatedHolder(index);
      expectedAmounts.set(holder, 0n);
      currentAmounts.set(holder, V2_HOLDER_EPSILON_WEI);
    }
    const expected = amountEntry(expectedAmounts);
    const failures = compareClaimAwareWeeklyDistributions(
      [expected],
      [amountEntry(currentAmounts)],
      claimContext(expected),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      `tokenCumulativeAbsDiff=1001000000000 tokenBound=${V2_TOKEN_EPSILON_WEI}`,
    );
    expect(failures[0]).toContain("largestHolder=0x0000000000000000000000000000000000000001");
    expect(failures[0]).toContain("largestAbsDiff=1000000000");
  });

  it("counts one transfer destination per pre/post-flip mode", () => {
    expect(attributionDestinations("botmarket")).toHaveLength(1);
    expect(attributionDestinations("distributor")).toHaveLength(1);
    expect(attributionDestinations("botmarket")).not.toEqual(
      attributionDestinations("distributor"),
    );
  });

  it("uses voting-power eligibility rather than raw registry membership for V9", () => {
    expect(eligibleDelegatorCount({ delegation: 1_000, eligible: 10, zero: 0 }, 1_000)).toBe(1);
  });

  it("enforces the four-week median band and positive current count", () => {
    expect(withinMedianBand(100, [90, 100, 100, 110])).toBe(true);
    expect(withinMedianBand(131, [90, 100, 100, 110])).toBe(false);
    expect(withinMedianBand(0, [90, 100, 100, 110])).toBe(false);
  });

  it("requires APRs for each nonzero sdToken delta", () => {
    expect(
      checkAprPresence(
        { TotalReported: { sdCRV: 1, sdFXN: 0, RawToken_curve_CRV: 2 } },
        { "sdcrv.eth": 12.5 },
      ).ok,
    ).toBe(true);
    expect(() => checkAprPresence({ TotalReported: { sdCRV: 1 } }, {})).toThrow(
      /no numeric sdcrv\.eth entry/,
    );
  });

  it("emits only the raw legacy transaction fields", () => {
    const transaction = buildTransactionLog("ethereum", [SD_CRV], [fixtureEntry().root as string]);
    expect(Object.keys(transaction)).toEqual([
      "network",
      "tokenAddressesToFreeze",
      "newMerkleRoots",
    ]);
    expect(transaction).not.toHaveProperty("toFreeze");
    expect(transaction).not.toHaveProperty("toSet");
  });
});
