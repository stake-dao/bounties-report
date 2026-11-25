import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import { AUTO_VOTER_DELEGATION_ADDRESS } from "../../utils/constants";

const USER = "0xe4f02accc88a3000f11afec71c04896127a3aeb5";
const END_BLOCK = 25581555;

const capturedBlockNumbers: unknown[] = [];
let registeredVotingPower = 7093281.81;
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

vi.mock("../../utils/rpcConfig", () => ({ getAvailableEndpoints: () => [] }));

vi.mock("../../utils/cacheUtils", () => ({
  processAllDelegators: async () => [USER],
}));

vi.mock("../../utils/chainUtils", () => ({
  getBlockNumberByTimestamp: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: async () => ({
      data: { result: { scores: [{ [USER]: registeredVotingPower }] } },
    }),
  },
}));

import { addVotersFromAutoVoter } from "../../utils/utils";

const proposal = {
  end: 1784642400,
  created: 1784170674,
  snapshot: "25542094",
  strategies: [],
  space: { id: "sdfxn.eth" },
};

const addressesPerChoice = {
  "0x4e6bB6B7": 276,
  "0x95f00391": 309,
};

const autoVoter = {
  id: "0x" + "11".repeat(32),
  created: proposal.end - 3600,
  voter: AUTO_VOTER_DELEGATION_ADDRESS,
  vp: 9742814,
  choice: { "276": 3546640, "309": 3546640 },
};

describe("legacy auto-voter registration reads", () => {
  beforeEach(() => {
    capturedBlockNumbers.length = 0;
    vi.mocked(getBlockNumberByTimestamp).mockReset().mockResolvedValue(END_BLOCK);
    registeredVotingPower = 7093281.81;
  });

  it("reads preferences at the proposal end block for non-sdCRV spaces", async () => {
    const space = proposal.space.id;
    await addVotersFromAutoVoter(
      space,
      proposal,
      [autoVoter],
      addressesPerChoice
    );

    expect(getBlockNumberByTimestamp).toHaveBeenCalledWith(proposal.end, "before", 1);
    expect(capturedBlockNumbers).toEqual([BigInt(END_BLOCK)]);
  });

  it("keeps a direct ballot's choices and voting power when the voter is also registered", async () => {
    const directBallot = {
      voter: "0x" + USER.slice(2).toUpperCase(),
      choice: { "309": 1 },
      vp: 42,
    };

    const voters = await addVotersFromAutoVoter(
      "sdfxn.eth", proposal, [autoVoter, directBallot], addressesPerChoice
    );

    expect(voters).toEqual([directBallot]);
  });

  it("excludes the auto-voter account even when no delegator has voting power", async () => {
    registeredVotingPower = 0;
    const voters = await addVotersFromAutoVoter(
      "sdfxn.eth", proposal, [autoVoter], addressesPerChoice
    );

    expect(voters).toEqual([]);
  });

  it("expands the delegator with their registered weights", async () => {
    const voters = await addVotersFromAutoVoter(
      "sdfxn.eth",
      proposal,
      [autoVoter],
      addressesPerChoice
    );

    const expanded = voters.find(
      (v: { voter: string }) => v.voter.toLowerCase() === USER
    );
    expect(expanded).toBeDefined();
    expect(expanded?.vp).toBeCloseTo(7093281.81);
    expect(expanded?.choice).toEqual({ "276": 5000, "309": 5000 });
    expect(
      voters.some(
        (v: { voter: string }) =>
          v.voter.toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
      )
    ).toBe(false);
  });

  it("throws when the historical block cannot be resolved", async () => {
    vi.mocked(getBlockNumberByTimestamp).mockResolvedValue(0);

    await expect(
      addVotersFromAutoVoter("sdfxn.eth", proposal, [autoVoter], addressesPerChoice)
    ).rejects.toThrow();
  });
});
