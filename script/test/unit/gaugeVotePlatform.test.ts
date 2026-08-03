/**
 * Unit tests for the on-chain GaugeVotePlatform readers (ENG-1973).
 *
 * The client is injected, so scenarios are driven by a plain mock object
 * dispatching on functionName — no network, no module mocks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getOnChainProposal,
  getOnChainVoters,
} from "../../utils/gaugeVotePlatform";

const PLATFORM = "0x64D9B5AC386B70af9EDCD20A58cE9262D2EAC278";
const WEEK = 604800;
const OVERTIME = 600;

// proposals: array of [startTime, endTime, epoch] tuples (index = proposal id)
const makeProposalClient = (
  proposals: Array<[bigint, bigint, bigint]>,
  gauges: Array<[string, bigint]> = []
) => ({
  readContract: async ({ functionName, args }: any) => {
    if (functionName === "proposalCount") return BigInt(proposals.length);
    if (functionName === "proposals") return proposals[Number(args[0])];
    if (functionName === "getGaugeCount") return BigInt(gauges.length);
    throw new Error(`unexpected readContract: ${functionName}`);
  },
  multicall: async ({ contracts }: any) =>
    contracts.map((c: any) => {
      if (c.functionName === "getGaugeEntry") return gauges[Number(c.args[1])];
      throw new Error(`unexpected multicall: ${c.functionName}`);
    }),
});

const GAUGE_A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GAUGE_B = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

afterEach(() => {
  vi.useRealTimers();
});

const setNow = (unixSeconds: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(unixSeconds * 1000);
};

describe("getOnChainProposal", () => {
  it("maps a finalized proposal to the Proposal shape (lowercase choices, epoch as snapshot)", async () => {
    const end = 1_000_000;
    setNow(end + OVERTIME + 1);
    const client = makeProposalClient(
      [[BigInt(end - 5 * 86400), BigInt(end), 230n]],
      [
        [GAUGE_A, 1_500_000_000_000_000_000n], // 1.5 vlCVX
        [GAUGE_B, 500_000_000_000_000_000n],
      ]
    );

    const proposal = await getOnChainProposal(PLATFORM, "cvx.eth", client);

    expect(proposal.id).toBe("0");
    expect(proposal.snapshot).toBe("230");
    expect(proposal.end).toBe(end);
    expect(proposal.choices).toEqual([
      GAUGE_A.toLowerCase(),
      GAUGE_B.toLowerCase(),
    ]);
    expect(proposal.scores).toEqual([1.5, 0.5]);
    expect(proposal.author).toBe(PLATFORM);
  });

  it("enforces finality strictly: end + overtime is still active, one second later is final", async () => {
    const end = 1_000_000;
    const proposals: Array<[bigint, bigint, bigint]> = [
      [BigInt(end - 5 * 86400), BigInt(end), 230n],
    ];

    setNow(end + OVERTIME);
    await expect(
      getOnChainProposal(PLATFORM, "cvx.eth", makeProposalClient(proposals))
    ).rejects.toThrow("No usable on-chain proposal");

    setNow(end + OVERTIME + 1);
    const proposal = await getOnChainProposal(
      PLATFORM,
      "cvx.eth",
      makeProposalClient(proposals)
    );
    expect(proposal.id).toBe("0");
  });

  it("walks back over an active proposal to the most recent finalized one", async () => {
    const prevEnd = 1_000_000;
    const activeEnd = prevEnd + 2 * WEEK;
    setNow(activeEnd - 86400); // active proposal still running
    const client = makeProposalClient([
      [BigInt(prevEnd - 5 * 86400), BigInt(prevEnd), 228n],
      [BigInt(activeEnd - 5 * 86400), BigInt(activeEnd), 230n],
    ]);

    const proposal = await getOnChainProposal(PLATFORM, "cvx.eth", client);
    expect(proposal.id).toBe("0");
    expect(proposal.snapshot).toBe("228");
  });

  it("never selects a force-ended proposal (endTime zeroed)", async () => {
    const prevEnd = 1_000_000;
    setNow(prevEnd + 2 * WEEK);
    const client = makeProposalClient([
      [BigInt(prevEnd - 5 * 86400), BigInt(prevEnd), 228n],
      [0n, 0n, 0n], // force-ended
    ]);

    const proposal = await getOnChainProposal(PLATFORM, "cvx.eth", client);
    expect(proposal.id).toBe("0");
  });

  it("targetPeriod pins selection: a round finalized after the period start is skipped", async () => {
    // Period P distributes the round that ended before P. A newer round
    // finalized between P and the (late) re-run must not be selected.
    const periodStart = 10 * WEEK;
    const servedEnd = periodStart - 2 * 86400; // ended 2 days before P
    const newerEnd = periodStart + 5 * 86400; // finalized after P started
    setNow(periodStart + 6 * 86400); // late re-run, newer round already final
    const client = makeProposalClient([
      [BigInt(servedEnd - 5 * 86400), BigInt(servedEnd), 228n],
      [BigInt(newerEnd - 5 * 86400), BigInt(newerEnd), 230n],
    ]);

    const proposal = await getOnChainProposal(PLATFORM, "cvx.eth", client, {
      targetPeriod: periodStart,
    });
    expect(proposal.id).toBe("0");
    expect(proposal.snapshot).toBe("228");
  });

  it("throws instead of serving a proposal older than one round (2 weeks) for the period", async () => {
    const periodStart = 10 * WEEK;
    const staleEnd = periodStart - 2 * WEEK; // exactly at the boundary = stale
    setNow(periodStart + 86400);
    const client = makeProposalClient([
      [BigInt(staleEnd - 5 * 86400), BigInt(staleEnd), 226n],
    ]);

    await expect(
      getOnChainProposal(PLATFORM, "cvx.eth", client, {
        targetPeriod: periodStart,
      })
    ).rejects.toThrow("Stale on-chain proposal");
  });

  it("requireFinal=false returns the newest non-force-ended proposal (test escape hatch)", async () => {
    const end = 1_000_000;
    setNow(end - 86400); // still active
    const client = makeProposalClient(
      [[BigInt(end - 5 * 86400), BigInt(end), 230n]],
      [[GAUGE_A, 0n]]
    );

    const proposal = await getOnChainProposal(PLATFORM, "cvx.eth", client, {
      requireFinal: false,
    });
    expect(proposal.id).toBe("0");
  });

  it("throws when the platform has no proposal", async () => {
    setNow(1_000_000);
    await expect(
      getOnChainProposal(PLATFORM, "cvx.eth", makeProposalClient([]))
    ).rejects.toThrow("No on-chain proposal yet");
  });
});

describe("getOnChainVoters", () => {
  const proposal: any = {
    choices: [GAUGE_A.toLowerCase(), GAUGE_B.toLowerCase()],
  };

  // votes: voter -> [gauges[], weights[], voted, baseWeight, adjustedWeight]
  const makeVotersClient = (
    votes: Record<string, [string[], bigint[], boolean, bigint, bigint]>
  ) => {
    const voters = Object.keys(votes);
    return {
      readContract: async ({ functionName }: any) => {
        if (functionName === "getVoterCount") return BigInt(voters.length);
        throw new Error(`unexpected readContract: ${functionName}`);
      },
      multicall: async ({ contracts }: any) =>
        contracts.map((c: any) => {
          if (c.functionName === "getVoterAtIndex")
            return voters[Number(c.args[1])];
          if (c.functionName === "getVote") return votes[c.args[1]];
          throw new Error(`unexpected multicall: ${c.functionName}`);
        }),
    };
  };

  const VOTER = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

  it("maps final votes: vp = base + adjusted, choice keys 1-indexed, ppm/100 values", async () => {
    const client = makeVotersClient({
      [VOTER]: [
        [GAUGE_A, GAUGE_B],
        [250_000n, 750_000n], // ppm
        true,
        2_000_000_000_000_000_000n, // base 2 vlCVX
        1_000_000_000_000_000_000n, // adjusted +1 vlCVX
      ],
    });

    const votes = await getOnChainVoters(PLATFORM, 0, proposal, client);
    expect(votes).toHaveLength(1);
    expect(votes[0].voter).toBe(VOTER.toLowerCase());
    expect(votes[0].vp).toBe(3);
    expect(votes[0].choice).toEqual({ "1": 2500, "2": 7500 });
  });

  it("filters out accounts that did not vote and skips exact-zero effective weight", async () => {
    const other = "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    const client = makeVotersClient({
      [VOTER]: [[GAUGE_A], [1_000_000n], false, 0n, 0n], // never voted
      [other]: [
        [GAUGE_A],
        [1_000_000n],
        true,
        1_000_000_000_000_000_000n,
        -1_000_000_000_000_000_000n, // weight fully removed -> net 0
      ],
    });

    const votes = await getOnChainVoters(PLATFORM, 0, proposal, client);
    expect(votes).toHaveLength(0);
  });

  it("throws on a negative effective weight (broken contract invariant)", async () => {
    const client = makeVotersClient({
      [VOTER]: [
        [GAUGE_A],
        [1_000_000n],
        true,
        1_000_000_000_000_000_000n,
        -2_000_000_000_000_000_000n,
      ],
    });

    await expect(
      getOnChainVoters(PLATFORM, 0, proposal, client)
    ).rejects.toThrow("negative effective weight");
  });

  it("sums (not overwrites) duplicate gauge entries within one vote", async () => {
    const client = makeVotersClient({
      [VOTER]: [
        [GAUGE_A, GAUGE_A],
        [400_000n, 600_000n],
        true,
        1_000_000_000_000_000_000n,
        0n,
      ],
    });

    const votes = await getOnChainVoters(PLATFORM, 0, proposal, client);
    expect(votes[0].choice).toEqual({ "1": 10000 });
  });

  it("returns [] when the proposal has no voter", async () => {
    const client = makeVotersClient({});
    expect(await getOnChainVoters(PLATFORM, 0, proposal, client)).toEqual([]);
  });
});
