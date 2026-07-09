import { parseAbi, formatUnits } from "viem";
import { VLCVX_ADDRESS } from "./constants";
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
 * Reads the latest proposal from a GaugeVotePlatform (Curve or FXN) and maps it
 * to the Proposal interface: choices = lowercase gauge addresses,
 * snapshot = vlCVX epoch number.
 * Throws if no proposal exists yet, or (unless opts.requireFinal is false) if
 * the latest one is not past endTime + overtime — the repartition must only run
 * on final results.
 */
export const getOnChainProposal = async (
  gaugeVotePlatformAddress: string,
  spaceId: string,
  client: any,
  opts: { requireFinal?: boolean } = { requireFinal: true }
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
  const proposalId = Number(count) - 1;

  const [proposalData, gaugeCount] = await client.multicall({
    allowFailure: false,
    contracts: [
      {
        address: gaugeVotePlatformAddress,
        abi: GAUGE_VOTE_PLATFORM_ABI,
        functionName: "proposals",
        args: [BigInt(proposalId)],
      },
      {
        address: gaugeVotePlatformAddress,
        abi: GAUGE_VOTE_PLATFORM_ABI,
        functionName: "getGaugeCount",
        args: [BigInt(proposalId)],
      },
    ],
  });
  const [startTime, endTime, epoch] = proposalData as [bigint, bigint, bigint];

  const now = Math.floor(Date.now() / 1000);
  if (opts.requireFinal !== false && now < Number(endTime) + EQUALIZER_OVERTIME) {
    throw new Error(
      `On-chain proposal ${proposalId} not final yet (ends at ${Number(
        endTime
      )} + ${EQUALIZER_OVERTIME}s equalizer overtime)`
    );
  }

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
 * vp = baseWeight + max(adjustedWeight, 0), in vlCVX (18 decimals).
 * choice keys are 1-indexed positions in proposal.choices, values in percent
 * (on-chain weights are basis points 0-10000 → divided by 100).
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

    const effectiveWeight =
      baseWeight + (adjustedWeight > 0n ? adjustedWeight : 0n);
    const vp = Number(formatUnits(effectiveWeight, 18));
    if (vp === 0) return;

    const choice: Record<string, number> = {};
    for (let j = 0; j < gauges.length; j++) {
      const choiceIndex = proposal.choices.indexOf(gauges[j].toLowerCase());
      if (choiceIndex !== -1) {
        choice[(choiceIndex + 1).toString()] = Number(weights[j]) / 100; // bps → %
      }
    }

    votes.push({ voter: voters[i].toLowerCase(), choice, vp });
  });

  return votes;
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
