/**
 * Regression tests for addVotersFromAutoVoter reading auto-voter registrations
 * at the proposal end block. The multicall's blockNumber must be a bigint:
 * viem silently ignores a JS number and reads latest state instead, which paid
 * nobody for gauges whose only voter re-registered after the vote closed
 * (2026-08-04 sdCRV surplus incident).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUTO_VOTER_DELEGATION_ADDRESS } from "../../utils/constants";

const USER = "0xe4f02accc88a3000f11afec71c04896127a3aeb5";
const END_BLOCK = 25581555;

const capturedBlockNumbers: unknown[] = [];
let resolvedEndBlock: number = END_BLOCK;
let registration = {
  user: USER,
  gauges: [
    "0x95f00391cb5eebcd190eb58728b4ce23dbfa6ac1",
    "0x4e6bb6b7447b7b2aa268c16ab87f4bb48bf57939",
  ],
  weights: [5000n, 5000n],
  killed: false,
};

vi.mock("../../utils/constants", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getClient: async () => ({
      multicall: async (args: { blockNumber?: unknown }) => {
        capturedBlockNumbers.push(args.blockNumber);
        return [{ status: "success", result: registration }];
      },
    }),
  };
});

vi.mock("../../utils/cacheUtils", () => ({
  processAllDelegators: async () => [USER],
}));

vi.mock("../../utils/chainUtils", () => ({
  getBlockNumberByTimestamp: async () => resolvedEndBlock,
}));

vi.mock("axios", () => ({
  default: {
    post: async () => ({
      data: { result: { scores: [{ [USER]: 7093281.81 }] } },
    }),
  },
}));

import { addVotersFromAutoVoter } from "../../utils/utils";

const proposal = {
  end: 1784642400,
  created: 1784170674,
  snapshot: "25542094",
  strategies: [],
  space: { id: "sdcrv.eth" },
};

const addressesPerChoice = {
  "0x4e6bB6B7": 276,
  "0x95f00391": 309,
};

const autoVoter = {
  voter: AUTO_VOTER_DELEGATION_ADDRESS,
  vp: 9742814,
  choice: { "276": 3546640, "309": 3546640 },
};

describe("addVotersFromAutoVoter end-block reads", () => {
  beforeEach(() => {
    capturedBlockNumbers.length = 0;
    resolvedEndBlock = END_BLOCK;
  });

  it("queries auto-voter weights at the proposal end block as a bigint", async () => {
    await addVotersFromAutoVoter(
      "sdcrv.eth",
      proposal,
      [autoVoter],
      addressesPerChoice
    );

    expect(capturedBlockNumbers).toHaveLength(1);
    expect(typeof capturedBlockNumbers[0]).toBe("bigint");
    expect(capturedBlockNumbers[0]).toBe(BigInt(END_BLOCK));
  });

  it("expands the delegator with their registered weights", async () => {
    const voters = await addVotersFromAutoVoter(
      "sdcrv.eth",
      proposal,
      [autoVoter],
      addressesPerChoice
    );

    const expanded = voters.find(
      (v: { voter: string }) => v.voter.toLowerCase() === USER
    );
    expect(expanded).toBeDefined();
    expect(expanded.vp).toBeCloseTo(7093281.81);
    expect(expanded.choice).toEqual({ "276": 5000, "309": 5000 });
    expect(
      voters.some(
        (v: { voter: string }) =>
          v.voter.toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
      )
    ).toBe(false);
  });

  it("throws when the proposal end block cannot be resolved", async () => {
    resolvedEndBlock = 0;

    await expect(
      addVotersFromAutoVoter("sdcrv.eth", proposal, [autoVoter], addressesPerChoice)
    ).rejects.toThrow(/end block/i);
  });
});
