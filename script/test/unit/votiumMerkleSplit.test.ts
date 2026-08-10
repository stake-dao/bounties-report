import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEEK, VOTIUM_FORWARDER, ALL_MIGHT_V2 } from "../../utils/constants";
import {
  assertCarryoverMatchesChain,
  carryoverPath,
  classifyVotiumDeposits,
  findUnconsumedCarryovers,
  pooledVotiumRemainder,
  isVotiumSplitActive,
  isVotiumSwapReceipt,
  parseCarryover,
  planVotiumPot,
  serializeCarryover,
  splitVotiumProceeds,
  type VotiumCarryover,
} from "../../vlCVX/votiumSplit";

const PERIOD = 1786060800;
const TX_VOTIUM = `0x${"a1".repeat(32)}`;
const TX_OTHER = `0x${"b2".repeat(32)}`;

const pad32 = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2)}`.toLowerCase();
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const votiumLog = {
  topics: [TRANSFER_TOPIC, pad32(VOTIUM_FORWARDER), pad32(ALL_MIGHT_V2)],
};

let tmpRoot: string;

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};

const writeCarry = (period: number, votiumScrvUsd: bigint) => {
  const { distributed, carried } = splitVotiumProceeds(votiumScrvUsd);
  writeJson(
    carryoverPath(period, tmpRoot),
    serializeCarryover({
      period,
      votiumScrvUsd,
      distributed,
      carried,
      fromBlock: 100,
      toBlock: 200,
      sourceTxs: [TX_VOTIUM],
    })
  );
};

const writeBreakdown = (period: number, carriedInFrom: number[]) => {
  writeJson(path.join(tmpRoot, String(period), "vlCVX", "delegators_split_breakdown.json"), {
    period,
    votium: { carriedInFrom },
  });
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "votium-split-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.VOTIUM_MERKLE_SPLIT_FROM;
});

describe("splitVotiumProceeds", () => {
  it("splits evenly and keeps the odd wei with the carried half", () => {
    expect(splitVotiumProceeds(100n)).toEqual({
      distributed: 50n,
      carried: 50n,
    });
    expect(splitVotiumProceeds(101n)).toEqual({
      distributed: 50n,
      carried: 51n,
    });
  });

  it("never loses a wei", () => {
    for (const total of [0n, 1n, 7n, 10n ** 21n + 3n]) {
      const { distributed, carried } = splitVotiumProceeds(total);
      expect(distributed + carried).toBe(total);
    }
  });

  it("rejects negative totals", () => {
    expect(() => splitVotiumProceeds(-1n)).toThrow(/cannot be negative/);
  });
});

describe("parseCarryover", () => {
  const valid = {
    period: PERIOD,
    votiumScrvUsd: "101",
    distributed: "50",
    carried: "51",
    fromBlock: 100,
    toBlock: 200,
    sourceTxs: [TX_VOTIUM],
  };

  it("accepts a well-formed artifact", () => {
    const carry = parseCarryover(valid, PERIOD);
    expect(carry.carried).toBe(51n);
    expect(carry.sourceTxs).toEqual([TX_VOTIUM]);
  });

  it("rejects an artifact found in the wrong period", () => {
    expect(() => parseCarryover(valid, PERIOD + WEEK)).toThrow(
      /does not match the period/
    );
  });

  it("rejects an inflated carried half", () => {
    expect(() =>
      parseCarryover({ ...valid, carried: "9999" }, PERIOD)
    ).toThrow(/does not conserve the split/);
  });

  it("rejects a total that does not back the halves", () => {
    expect(() =>
      parseCarryover({ ...valid, votiumScrvUsd: "10" }, PERIOD)
    ).toThrow(/does not conserve the split/);
  });

  it("rejects malformed amounts and tx hashes", () => {
    expect(() =>
      parseCarryover({ ...valid, carried: 51 }, PERIOD)
    ).toThrow(/unsigned integer string/);
    expect(() =>
      parseCarryover({ ...valid, sourceTxs: ["nope"] }, PERIOD)
    ).toThrow(/must be a transaction hash/);
  });
});

describe("findUnconsumedCarryovers", () => {
  it("finds last week's carryover", () => {
    writeCarry(PERIOD - WEEK, 100n);
    const found = findUnconsumedCarryovers(PERIOD, tmpRoot);
    expect(found).toHaveLength(1);
    expect(found[0].carry.carried).toBe(50n);
  });

  it("ignores a carryover a later period already paid", () => {
    writeCarry(PERIOD - 2 * WEEK, 100n);
    writeBreakdown(PERIOD - WEEK, [PERIOD - 2 * WEEK]);
    expect(findUnconsumedCarryovers(PERIOD, tmpRoot)).toHaveLength(0);
  });

  it("still pays a carryover whose distribution week was skipped", () => {
    // Week B never ran: no breakdown recorded consuming it.
    writeCarry(PERIOD - 2 * WEEK, 100n);
    const found = findUnconsumedCarryovers(PERIOD, tmpRoot);
    expect(found.map((f) => f.period)).toEqual([PERIOD - 2 * WEEK]);
  });

  it("collects several unconsumed carryovers oldest first", () => {
    writeCarry(PERIOD - 3 * WEEK, 100n);
    writeCarry(PERIOD - WEEK, 200n);
    const found = findUnconsumedCarryovers(PERIOD, tmpRoot);
    expect(found.map((f) => f.period)).toEqual([
      PERIOD - 3 * WEEK,
      PERIOD - WEEK,
    ]);
  });

  it("does not look further back than the window", () => {
    writeCarry(PERIOD - 5 * WEEK, 100n);
    expect(findUnconsumedCarryovers(PERIOD, tmpRoot)).toHaveLength(0);
  });

  it("propagates a corrupt artifact instead of skipping it", () => {
    writeJson(carryoverPath(PERIOD - WEEK, tmpRoot), {
      period: PERIOD - WEEK,
      votiumScrvUsd: "100",
      distributed: "50",
      carried: "500",
      fromBlock: 100,
      toBlock: 200,
      sourceTxs: [],
    });
    expect(() => findUnconsumedCarryovers(PERIOD, tmpRoot)).toThrow(
      /does not conserve the split/
    );
  });
});

describe("isVotiumSwapReceipt", () => {
  it("matches the vault → executor withdraw", () => {
    expect(isVotiumSwapReceipt([votiumLog])).toBe(true);
  });

  it("ignores transfers from other senders", () => {
    expect(
      isVotiumSwapReceipt([
        {
          topics: [
            TRANSFER_TOPIC,
            pad32("0x000000000000000000000000000000000000dEaD"),
            pad32(ALL_MIGHT_V2),
          ],
        },
      ])
    ).toBe(false);
  });

  it("ignores vault withdraws that go somewhere else (Thursday batch)", () => {
    expect(
      isVotiumSwapReceipt([
        {
          topics: [
            TRANSFER_TOPIC,
            pad32(VOTIUM_FORWARDER),
            pad32("0x000000006feeE0b7a0564Cd5CeB283e10347C4Db"),
          ],
        },
      ])
    ).toBe(false);
  });

  it("ignores non-Transfer events", () => {
    expect(
      isVotiumSwapReceipt([
        { topics: [`0x${"11".repeat(32)}`, pad32(VOTIUM_FORWARDER), pad32(ALL_MIGHT_V2)] },
      ])
    ).toBe(false);
  });
});

describe("classifyVotiumDeposits", () => {
  const getReceipt = async (txHash: string) => ({
    logs: txHash === TX_VOTIUM ? [votiumLog] : [{ topics: [TRANSFER_TOPIC] }],
  });

  it("separates the Votium batch from the other deposits", async () => {
    const result = await classifyVotiumDeposits(getReceipt, [
      { txHash: TX_VOTIUM, amount: 300n },
      { txHash: TX_OTHER, amount: 700n },
    ]);
    expect(result.votiumAmount).toBe(300n);
    expect(result.nonVotiumAmount).toBe(700n);
    expect(result.votiumTxs).toEqual([TX_VOTIUM]);
  });

  it("sums several mints inside one transaction", async () => {
    const result = await classifyVotiumDeposits(getReceipt, [
      { txHash: TX_VOTIUM, amount: 300n },
      { txHash: TX_VOTIUM, amount: 200n },
    ]);
    expect(result.votiumAmount).toBe(500n);
    expect(result.votiumTxs).toEqual([TX_VOTIUM]);
  });

  it("handles a week with no deposits at all", async () => {
    const result = await classifyVotiumDeposits(getReceipt, []);
    expect(result).toEqual({
      votiumAmount: 0n,
      nonVotiumAmount: 0n,
      votiumTxs: [],
    });
  });
});

describe("planVotiumPot", () => {
  const classification = {
    votiumAmount: 1000n,
    nonVotiumAmount: 400n,
    votiumTxs: [TX_VOTIUM],
  };

  it("holds back half of the Votium proceeds in the swap week", () => {
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: true, hasRemainder: true },
      classification,
      carryovers: [],
    });
    expect(plan.withheld).toBe(500n);
    expect(plan.carriedIn).toBe(0n);
    expect(plan.isRoundWeekA).toBe(true);
  });

  it("changes nothing while the split is not activated", () => {
    const plan = planVotiumPot({
      active: false,
      remainder: { claimDataPresent: true, hasRemainder: true },
      classification,
      carryovers: [],
    });
    expect(plan.withheld).toBe(0n);
    expect(plan.carriedIn).toBe(0n);
  });

  it("pays in the carried half on the following week", () => {
    const carry: VotiumCarryover = {
      period: PERIOD - WEEK,
      votiumScrvUsd: 1000n,
      distributed: 500n,
      carried: 500n,
      fromBlock: 100,
      toBlock: 200,
      sourceTxs: [TX_VOTIUM],
    };
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: true, hasRemainder: false },
      classification: { votiumAmount: 0n, nonVotiumAmount: 0n, votiumTxs: [] },
      carryovers: [{ period: carry.period, carry }],
    });
    expect(plan.withheld).toBe(0n);
    expect(plan.carriedIn).toBe(500n);
    expect(plan.carriedInFrom).toEqual([PERIOD - WEEK]);
  });

  it("distributes a delayed swap in full — no round claimed that week", () => {
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: true, hasRemainder: false },
      classification,
      carryovers: [],
    });
    expect(plan.withheld).toBe(0n);
    expect(plan.votiumReceived).toBe(1000n);
  });

  it("can withhold and carry in at once after a missed distribution", () => {
    const carry: VotiumCarryover = {
      period: PERIOD - 2 * WEEK,
      votiumScrvUsd: 800n,
      distributed: 400n,
      carried: 400n,
      fromBlock: 100,
      toBlock: 200,
      sourceTxs: [TX_VOTIUM],
    };
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: true, hasRemainder: true },
      classification,
      carryovers: [{ period: carry.period, carry }],
    });
    expect(plan.withheld).toBe(500n);
    expect(plan.carriedIn).toBe(400n);
  });

  it("refuses to guess the round when the period's claim data is missing", () => {
    // Absent claim data is "cannot tell", not "no claim": treating it as week B
    // would pay a whole round out in one week and quietly defeat the split.
    expect(() =>
      planVotiumPot({
        active: true,
        remainder: { claimDataPresent: false, hasRemainder: false },
        classification,
        carryovers: [],
      })
    ).toThrow(/no claimed_bounties_convex.json/);
  });

  it("still distributes normally with no claim data and no Votium proceeds", () => {
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: false, hasRemainder: false },
      classification: { votiumAmount: 0n, nonVotiumAmount: 900n, votiumTxs: [] },
      carryovers: [],
    });
    expect(plan.withheld).toBe(0n);
    expect(plan.nonVotiumReceived).toBe(900n);
  });

  it("refuses to run when the swap week's deposits cannot be attributed", () => {
    expect(() =>
      planVotiumPot({
        active: true,
        remainder: { claimDataPresent: true, hasRemainder: true },
        classification: {
          votiumAmount: 0n,
          nonVotiumAmount: 1000n,
          votiumTxs: [],
        },
        carryovers: [],
      })
    ).toThrow(/none of the 1000 wei .* could be attributed to the Votium swap/);
  });

  it("stays quiet when nothing arrived at all", () => {
    const plan = planVotiumPot({
      active: true,
      remainder: { claimDataPresent: true, hasRemainder: true },
      classification: { votiumAmount: 0n, nonVotiumAmount: 0n, votiumTxs: [] },
      carryovers: [],
    });
    expect(plan.withheld).toBe(0n);
  });
});

describe("assertCarryoverMatchesChain", () => {
  const carry: VotiumCarryover = {
    period: PERIOD - WEEK,
    votiumScrvUsd: 1000n,
    distributed: 500n,
    carried: 500n,
    fromBlock: 100,
    toBlock: 200,
    sourceTxs: [TX_VOTIUM],
  };

  it("accepts a carryover backed by the chain", async () => {
    await expect(
      assertCarryoverMatchesChain(carry, async () => ({
        votiumAmount: 1000n,
        nonVotiumAmount: 0n,
        votiumTxs: [TX_VOTIUM],
      }))
    ).resolves.toBeUndefined();
  });

  it("re-measures the window the artifact recorded, not 'up to now'", async () => {
    // A later deposit — a manual swap after that Tuesday, say — lands outside
    // the recorded range and must not turn the next week into a hard failure.
    const seen: [number, number][] = [];
    await assertCarryoverMatchesChain(carry, async (fromBlock, toBlock) => {
      seen.push([fromBlock, toBlock]);
      return { votiumAmount: 1000n, nonVotiumAmount: 0n, votiumTxs: [TX_VOTIUM] };
    });
    expect(seen).toEqual([[carry.fromBlock, carry.toBlock]]);
  });

  it("rejects an artifact claiming more than the chain shows", async () => {
    await expect(
      assertCarryoverMatchesChain(carry, async () => ({
        votiumAmount: 10n,
        nonVotiumAmount: 0n,
        votiumTxs: [TX_VOTIUM],
      }))
    ).rejects.toThrow(/refusing to distribute it/);
  });
});

describe("activation", () => {
  it("is dormant by default", () => {
    expect(isVotiumSplitActive(PERIOD, {})).toBe(false);
  });

  it("activates from the configured period onwards", () => {
    const env = { VOTIUM_MERKLE_SPLIT_FROM: String(PERIOD) };
    expect(isVotiumSplitActive(PERIOD - WEEK, env)).toBe(false);
    expect(isVotiumSplitActive(PERIOD, env)).toBe(true);
    expect(isVotiumSplitActive(PERIOD + WEEK, env)).toBe(true);
  });

  it("rejects a nonsense activation period", () => {
    expect(() =>
      isVotiumSplitActive(PERIOD, { VOTIUM_MERKLE_SPLIT_FROM: "soon" })
    ).toThrow(/weekly period timestamp/);
  });
});

describe("pooledVotiumRemainder", () => {
  const claimsFile = (period: number) =>
    path.join(
      tmpRoot,
      "weekly",
      String(period),
      "votium",
      "claimed_bounties_convex.json"
    );
  const roots = () => ({
    reportsRoot: tmpRoot,
    weeklyBountiesRoot: path.join(tmpRoot, "weekly"),
  });

  it("is false without claim data", () => {
    expect(pooledVotiumRemainder(PERIOD, roots())).toEqual({
      claimDataPresent: false,
      hasRemainder: false,
    });
  });

  it("is false for a claim file with nothing claimed", () => {
    writeJson(claimsFile(PERIOD), { curve: {}, fxn: {} });
    expect(pooledVotiumRemainder(PERIOD, roots()).hasRemainder).toBe(false);
  });

  it("is true when something is left after the Thursday reserve", () => {
    writeJson(claimsFile(PERIOD), {
      curve: { "1": { rewardToken: "0xAAA", amount: "1000" } },
    });
    writeJson(
      path.join(tmpRoot, String(PERIOD), "vlCVX", "votium_thursday_withdrawal.json"),
      { period: PERIOD, tokens: { "0xaaa": "400" } }
    );
    expect(pooledVotiumRemainder(PERIOD, roots()).hasRemainder).toBe(true);
  });

  it("is false when the whole claim is reserved for the Thursday merkle", () => {
    writeJson(claimsFile(PERIOD), {
      curve: { "1": { rewardToken: "0xAAA", amount: "1000" } },
    });
    writeJson(
      path.join(tmpRoot, String(PERIOD), "vlCVX", "votium_thursday_withdrawal.json"),
      { period: PERIOD, tokens: { "0xaaa": "1000" } }
    );
    expect(pooledVotiumRemainder(PERIOD, roots()).hasRemainder).toBe(false);
  });
});
