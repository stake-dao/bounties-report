import { parseAbi, formatUnits } from "viem";
import { VLCVX_ADDRESS, WEEK } from "./constants";
import { Proposal } from "./types";

/**
 * Readers for the Convex Voting Platform GaugeVotePlatform contracts
 * (CurveGaugeVoting / FxGaugeVoting). They return objects compatible with the
 * Snapshot-based Proposal / Vote shapes so the vlCVX repartition downstream
 * (computeNonDelegatorsDistribution, computeStakeDaoDelegation, ...) is unchanged.
 *
 * IMPORTANT: for on-chain proposals, `proposal.snapshot` is the vlCVX epoch
 * number (small integer, ~227+), NOT a block number. Never call getBlock on it.
 */

const GAUGE_VOTE_PLATFORM_ABI = parseAbi([
  "function proposalCount() external view returns (uint256)",
  "function proposals(uint256) external view returns (uint48 startTime, uint48 endTime, uint48 epoch)",
  "function getGaugeCount(uint256) external view returns (uint256)",
  "function getGaugeEntry(uint256, uint256) external view returns (address gauge, uint256 totalWeight)",
  "function getVoterCount(uint256) external view returns (uint256)",
  "function getVoterAtIndex(uint256, uint256) external view returns (address)",
  "function getVote(uint256, address) external view returns (address[] gauges, uint256[] weights, bool voted, uint256 baseWeight, int256 adjustedWeight)",
]);

const VLCVX_ABI = parseAbi([
  "function balanceAtEpochOf(uint256 epoch, address user) external view returns (uint256)",
]);

// "Equalizer" accounts (e.g. Votium) may still vote until endTime + 10 minutes;
// the final state can only be read after that overtime.
const EQUALIZER_OVERTIME = 600;

/**
 * Reads the FINALIZED proposal to distribute from a GaugeVotePlatform (Curve
 * or FXN) and maps it to the Proposal interface: choices = lowercase gauge
 * addresses, snapshot = vlCVX epoch number.
 *
 * Proposals last 2 weeks but the distribution runs weekly: on the second
 * Thursday a fresh (active) proposal may already exist, so "latest" is wrong —
 * we walk back from the newest proposal to the most recent finalized one.
 * Finality mirrors the contract's isFinalized: endTime > 0 AND strictly past
 * endTime + overtime. forceEndProposal zeroes startTime/endTime/epoch, so a
 * force-ended proposal is never distributable.
 *
 * opts.targetPeriod (WEEK-aligned start of the distribution period being
 * computed) pins the selection to that period instead of the current clock:
 * only proposals already finalized by the period start are eligible, so a
 * late retry of a past period cannot drift onto the round that finalized in
 * between. Rounds are biweekly, so a proposal legitimately serves at most two
 * weekly periods — if the newest eligible proposal ended more than 2 weeks
 * before the period, it throws instead of silently serving a third week.
 *
 * Throws if no proposal exists, or none is eligible.
 * With opts.requireFinal === false (TEST-ONLY fork escape hatch) the newest
 * non-force-ended proposal is returned regardless of finality and
 * targetPeriod is ignored.
 */
export const getOnChainProposal = async (
  gaugeVotePlatformAddress: string,
  spaceId: string,
  client: any,
  opts: { requireFinal?: boolean; targetPeriod?: number } = {
    requireFinal: true,
  }
): Promise<Proposal> => {
  const count: bigint = await client.readContract({
    address: gaugeVotePlatformAddress,
    abi: GAUGE_VOTE_PLATFORM_ABI,
    functionName: "proposalCount",
  });
  if (count === 0n) {
    throw new Error(
      `No on-chain proposal yet on GaugeVotePlatform ${gaugeVotePlatformAddress}`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  let proposalId = Number(count) - 1;
  let proposalData: [bigint, bigint, bigint] | undefined;

  for (let pid = Number(count) - 1; pid >= 0; pid--) {
    const data = (await client.readContract({
      address: gaugeVotePlatformAddress,
      abi: GAUGE_VOTE_PLATFORM_ABI,
      functionName: "proposals",
      args: [BigInt(pid)],
    })) as [bigint, bigint, bigint];
    const endTime = Number(data[1]);

    // forceEndProposal zeroes startTime/endTime/epoch; the contract's own
    // isFinalized requires endTime > 0 — a force-ended proposal must never
    // be distributed (its epoch is 0 and its votes are partial).
    if (endTime === 0) {
      console.log(
        `Skipping on-chain proposal ${pid}: force-ended (endTime = 0)`
      );
      continue;
    }

    if (opts.requireFinal === false) {
      proposalId = pid;
      proposalData = data;
      break;
    }

    if (now <= endTime + EQUALIZER_OVERTIME) {
      console.log(
        `Skipping on-chain proposal ${pid}: not finalized (ends at ${endTime} + ${EQUALIZER_OVERTIME}s overtime)`
      );
      continue;
    }

    if (
      opts.targetPeriod !== undefined &&
      endTime + EQUALIZER_OVERTIME > opts.targetPeriod
    ) {
      console.log(
        `Skipping on-chain proposal ${pid}: finalized after the start of ` +
          `distribution period ${opts.targetPeriod} (ends at ${endTime})`
      );
      continue;
    }

    // Walking newest -> oldest, the first eligible proposal is the answer.
    // If it ended more than one round (2 weeks) before the period, the round
    // the period should distribute is missing (never created or force-ended):
    // refuse to serve the previous round a third week.
    if (
      opts.targetPeriod !== undefined &&
      endTime <= opts.targetPeriod - 2 * WEEK
    ) {
      throw new Error(
        `Stale on-chain proposal on GaugeVotePlatform ${gaugeVotePlatformAddress}: ` +
          `newest eligible proposal ${pid} ended at ${endTime}, more than 2 weeks ` +
          `before distribution period ${opts.targetPeriod} — the expected round ` +
          `is missing, refusing to reuse it`
      );
    }

    proposalId = pid;
    proposalData = data;
    break;
  }

  if (!proposalData) {
    throw new Error(
      `No usable on-chain proposal on GaugeVotePlatform ${gaugeVotePlatformAddress} ` +
        `(${count} proposal(s): force-ended proposals excluded` +
        (opts.requireFinal === false
          ? ")"
          : `, finality = endTime + ${EQUALIZER_OVERTIME}s overtime elapsed` +
            (opts.targetPeriod !== undefined
              ? ` before period ${opts.targetPeriod})`
              : ")"))
    );
  }

  const [startTime, endTime, epoch] = proposalData as [bigint, bigint, bigint];

  const gaugeCount: bigint = await client.readContract({
    address: gaugeVotePlatformAddress,
    abi: GAUGE_VOTE_PLATFORM_ABI,
    functionName: "getGaugeCount",
    args: [BigInt(proposalId)],
  });

  const entries = (await client.multicall({
    allowFailure: false,
    contracts: Array.from({ length: Number(gaugeCount) }, (_, i) => ({
      address: gaugeVotePlatformAddress,
      abi: GAUGE_VOTE_PLATFORM_ABI,
      functionName: "getGaugeEntry",
      args: [BigInt(proposalId), BigInt(i)],
    })),
  })) as [string, bigint][];

  const choices = entries.map(([gauge]) => gauge.toLowerCase());
  const scores = entries.map(([, totalWeight]) =>
    Number(formatUnits(totalWeight, 18))
  );

  return {
    id: proposalId.toString(),
    title: `On-chain gauge vote #${proposalId} (vlCVX epoch ${Number(epoch)})`,
    start: Number(startTime),
    end: Number(endTime),
    state: "closed",
    created: Number(startTime),
    choices,
    snapshot: epoch.toString(), // vlCVX epoch number, NOT a block number
    type: "weighted",
    scores_state: "final",
    scores_total: scores.reduce((acc, s) => acc + s, 0),
    scores,
    votes: 0,
    strategies: [],
    author: gaugeVotePlatformAddress,
    space: { id: spaceId },
  };
};

/**
 * Returns all final votes for a proposal, mapped to the Snapshot voter shape
 * ({ voter, choice, vp }) consumed by the repartition.
 *
 * The contract only pushes a voter into votedUsers on their FIRST vote, so
 * getVoterCount/getVoterAtIndex enumerate unique voters directly — no event
 * scan, no dedup. getVote then reflects the final state (re-votes overwrite).
 *
 * vp = baseWeight + adjustedWeight (exact signed sum, asserted > 0 for voted
 * accounts), in vlCVX (18 decimals).
 * choice keys are 1-indexed positions in proposal.choices. Values are the
 * on-chain weights (ppm, 0-1_000_000 since the 2026-07-25 redeploy) divided
 * by 100 — only meaningful relative to the voter's other choice values; all
 * consumers normalize by the per-voter sum.
 */
export const getOnChainVoters = async (
  gaugeVotePlatformAddress: string,
  proposalId: number,
  proposal: Proposal,
  client: any
): Promise<any[]> => {
  const voterCount: bigint = await client.readContract({
    address: gaugeVotePlatformAddress,
    abi: GAUGE_VOTE_PLATFORM_ABI,
    functionName: "getVoterCount",
    args: [BigInt(proposalId)],
  });
  if (voterCount === 0n) return [];

  const voters = (await client.multicall({
    allowFailure: false,
    contracts: Array.from({ length: Number(voterCount) }, (_, i) => ({
      address: gaugeVotePlatformAddress,
      abi: GAUGE_VOTE_PLATFORM_ABI,
      functionName: "getVoterAtIndex",
      args: [BigInt(proposalId), BigInt(i)],
    })),
  })) as string[];

  const voteResults = (await client.multicall({
    allowFailure: false,
    contracts: voters.map((voter) => ({
      address: gaugeVotePlatformAddress,
      abi: GAUGE_VOTE_PLATFORM_ABI,
      functionName: "getVote",
      args: [BigInt(proposalId), voter],
    })),
  })) as [string[], bigint[], boolean, bigint, bigint][];

  const votes: any[] = [];
  voteResults.forEach((result, i) => {
    const [gauges, weights, voted, baseWeight, adjustedWeight] = result;
    if (!voted) return;

    // Exact signed sum, as applied to gaugeTotal by the contract. Every
    // subtraction is bounded by previously added weight, so a negative net is
    // a broken contract invariant — fail loudly instead of mispaying. An
    // EXACT zero is a valid final state (e.g. a delegate whose weight was
    // entirely removed by delegators voting directly or re-delegating): the
    // account carries no weight in the tally, skip it.
    const effectiveWeight = baseWeight + adjustedWeight;
    if (effectiveWeight < 0n) {
      throw new Error(
        `getOnChainVoters: voted account ${voters[i]} has negative effective weight ` +
          `(baseWeight=${baseWeight}, adjustedWeight=${adjustedWeight}) — ` +
          `contract invariant broken, refusing to distribute`
      );
    }
    if (effectiveWeight === 0n) {
      console.warn(
        `getOnChainVoters: voted account ${voters[i]} has zero effective weight — skipping`
      );
      return;
    }
    const vp = Number(formatUnits(effectiveWeight, 18));

    const choice: Record<string, number> = {};
    for (let j = 0; j < gauges.length; j++) {
      const choiceIndex = proposal.choices.indexOf(gauges[j].toLowerCase());
      if (choiceIndex !== -1) {
        // Sum (not overwrite) in case a gauge ever appears twice in a vote
        const key = (choiceIndex + 1).toString();
        choice[key] = (choice[key] || 0) + Number(weights[j]) / 100; // ppm / 100 — relative weight
      }
    }

    votes.push({ voter: voters[i].toLowerCase(), choice, vp });
  });

  return votes;
};

/**
 * Final on-chain vote of a single account on a proposal (getVote), raw wei
 * values. Used to reconcile the delegation split against the vote the
 * platform actually applied.
 */
export const getVoteOf = async (
  gaugeVotePlatformAddress: string,
  proposalId: number,
  voter: string,
  client: any
): Promise<{
  gauges: string[];
  weights: bigint[];
  voted: boolean;
  baseWeight: bigint;
  adjustedWeight: bigint;
}> => {
  const [gauges, weights, voted, baseWeight, adjustedWeight] =
    (await client.readContract({
      address: gaugeVotePlatformAddress,
      abi: GAUGE_VOTE_PLATFORM_ABI,
      functionName: "getVote",
      args: [BigInt(proposalId), voter],
    })) as [string[], bigint[], boolean, bigint, bigint];
  return { gauges, weights, voted, baseWeight, adjustedWeight };
};

/**
 * associateGaugesPerId for on-chain proposals: choices are already lowercase
 * gauge addresses, so it's a direct address match — no shortName heuristics.
 * Used for Curve AND FXN (pass the right protocol's gauge list).
 */
export const associateGaugesPerIdOnChain = (
  proposal: Proposal,
  protocolGauges: any[]
): { [key: string]: { shortName: string; choiceId: number } } => {
  const result: { [key: string]: { shortName: string; choiceId: number } } = {};

  for (let i = 0; i < proposal.choices.length; i++) {
    const choiceAddr = proposal.choices[i]; // already lowercase
    const gauge = protocolGauges.find(
      (g) => (g.rootGauge || g.gauge).toLowerCase() === choiceAddr
    );
    if (gauge) {
      result[choiceAddr] = { shortName: gauge.shortName, choiceId: i + 1 };
    } else {
      console.warn(
        `Warning: No matching gauge found for on-chain choice: ${choiceAddr}`
      );
    }
  }

  return result;
};

/**
 * Voting power of each address at a vlCVX epoch, via
 * vlCVX.balanceAtEpochOf (full 1e18 precision) in a single multicall.
 * Replaces the Snapshot score API for delegators' VP.
 * Keys of the returned record are lowercase.
 */
export const getOnChainVotingPower = async (
  epoch: number,
  addresses: string[],
  client: any
): Promise<Record<string, number>> => {
  if (addresses.length === 0) return {};

  const balances = (await client.multicall({
    allowFailure: false,
    contracts: addresses.map((addr) => ({
      address: VLCVX_ADDRESS,
      abi: VLCVX_ABI,
      functionName: "balanceAtEpochOf",
      args: [BigInt(epoch), addr],
    })),
  })) as bigint[];

  return Object.fromEntries(
    addresses.map((addr, i) => [
      addr.toLowerCase(),
      Number(formatUnits(balances[i], 18)),
    ])
  );
};
