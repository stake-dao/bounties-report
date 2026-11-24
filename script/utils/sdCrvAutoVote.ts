import request, { gql } from "graphql-request";
import pLimit from "p-limit";
import type { PublicClient } from "viem";
import { SDCRV_SPACE, SNAPSHOT_ENDPOINT, getClient } from "./constants";
import { getBlockNumberByTimestamp } from "./chainUtils";
import { getVoters, getSnapshotStrategyScores } from "./snapshot";
import { getSdCrvAutoVoteDelegators, readSdCrvAutoVoteArchive, type SdCrvAutoRegistration } from "./sdCrvAutoVoteArchive";
import { reconcileSdCrvAutoVote, type SdCrvAutoVoteCandidate } from "./sdCrvAutoVoteReconciliation";
import type { Proposal } from "./types";

interface BotBallot {
  id?: string;
  created?: number;
  choice: Record<string, number>;
}

async function getScoringStrategies(proposalId: string, ballotId: string) {
  // The bot used the space settings at collection time, while the report stores
  // the strategies on the proposal. Establish that these were the same version.
  const records = await request(SNAPSHOT_ENDPOINT, gql`
    query VoteHistory($space: String!, $proposal: String!, $ballot: String!) {
      settings: proposal(id: $proposal) { network strategies { name params network } }
      proposal: messages(first: 1, where: { space: $space, id: $proposal, type: "proposal" }) { mci }
      ballot: messages(first: 1, where: { space: $space, id: $ballot, type: "vote" }) { mci }
    }`, { space: SDCRV_SPACE, proposal: proposalId, ballot: ballotId });
  const strategies: Proposal["strategies"] = records.settings?.strategies;
  if (records.settings?.network !== "1" || !Array.isArray(strategies) || !strategies.length) {
    throw new Error("Incomplete historical sdCRV scoring strategies");
  }
  const start = records.proposal?.[0]?.mci;
  const end = records.ballot?.[0]?.mci;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
    throw new Error("Cannot verify the sdCRV proposal and ballot in Snapshot history");
  }
  const result = await request(SNAPSHOT_ENDPOINT, gql`
    query ScoringSettings($space: String!, $start: Int!, $end: Int!) {
      messages(first: 1, where: { space: $space, type: "settings", mci_gt: $start, mci_lt: $end }) { mci }
    }`, { space: SDCRV_SPACE, start, end });
  if (!Array.isArray(result.messages) || result.messages.length) {
    throw new Error("Cannot establish stable Snapshot settings for this sdCRV ballot");
  }
  return strategies;
}

async function blockAtOrBefore(client: PublicClient, timestamp: number): Promise<bigint> {
  const height = await getBlockNumberByTimestamp(timestamp, "before", 1);
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("Invalid Ethereum block height");
  const estimate = BigInt(height);
  const block = await client.getBlock({ blockNumber: estimate });
  // The fallback timestamp service returns the nearest block in either direction.
  const after = block.timestamp > BigInt(timestamp);
  const neighbor = await client.getBlock({ blockNumber: after ? estimate - 1n : estimate + 1n });
  if (after === (neighbor.timestamp > BigInt(timestamp))) {
    throw new Error(`Cannot bracket Ethereum timestamp ${timestamp}`);
  }
  return after ? estimate - 1n : estimate;
}

function registrationWeights(registration: SdCrvAutoRegistration, gauges: ReadonlyMap<string, number>) {
  if (registration.gauges.length !== registration.weights.length) throw new Error("Invalid sdCRV registration");
  const totalWeight = Number(registration.weights.reduce((sum, weight) => sum + weight, 0n));
  const weightedChoices: [number, number][] = [];
  for (const [i, gauge] of registration.gauges.entries()) {
    const index = gauges.get(gauge.slice(0, 17).toLowerCase());
    if (index !== undefined) weightedChoices.push([index, Number(registration.weights[i])]);
  }
  return { weightedChoices, totalWeight };
}

async function getIndividualVotingPower(proposal: Proposal, voter: string) {
  const scores = await getSnapshotStrategyScores(proposal, [voter], "1");
  if (scores.length !== proposal.strategies.length) throw new Error("Incomplete sdCRV strategy scores");
  let total = 0;
  for (const score of scores) {
    for (const [address, amount] of Object.entries(score)) {
      if (address.toLowerCase() !== voter) continue;
      if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid sdCRV strategy score");
      total += amount;
    }
  }
  if (!Number.isFinite(total)) throw new Error("Invalid sdCRV voting power");
  return total;
}

export async function reconstructSdCrvAutoVote(
  proposal: Proposal,
  ballot: BotBallot,
  snapshotVoters: ReadonlySet<string>
) {
  const accepted = ballot.created;
  const opened = Math.max(proposal.created, proposal.start);
  if (!proposal.id || !ballot.id || !Number.isSafeInteger(proposal.created) ||
      !Number.isSafeInteger(opened) || !Number.isSafeInteger(proposal.end) ||
      typeof accepted !== "number" || !Number.isSafeInteger(accepted) ||
      accepted < opened || accepted > proposal.end || proposal.space?.id !== SDCRV_SPACE ||
      !/^\d+$/.test(proposal.snapshot) || !Number.isSafeInteger(Number(proposal.snapshot))) {
    throw new Error("Incomplete historical data for sdCRV auto-vote");
  }

  // Earlier sdCRV ballots used a different calculation under the same strategy
  // name (snapshot-labs/snapshot-strategies#1734, merged May 20, 2025).
  if (proposal.created < Date.UTC(2025, 4, 21) / 1000) {
    throw new Error("sdCRV ballots before May 21, 2025 require the original scoring implementation");
  }
  const strategies = await getScoringStrategies(proposal.id, ballot.id);
  const client = await getClient(1);
  const timestamps = [...new Set([proposal.created, opened, accepted])];
  const blocks = new Map(await Promise.all(timestamps.map(async time =>
    [time, await blockAtOrBefore(client, time)] as const
  )));
  const toBlock = blocks.get(accepted)!;
  const accounts = await getSdCrvAutoVoteDelegators(client, blocks.get(proposal.created)!, toBlock);
  const addresses = accounts.map(account => account.voter);
  const [archive, zeroPowerBallots] = await Promise.all([
    readSdCrvAutoVoteArchive({ addresses, fromBlock: blocks.get(opened)!, toBlock }),
    getVoters(proposal.id, "zero"),
  ]);

  const directVoters = new Set(snapshotVoters);
  for (const { voter } of zeroPowerBallots) directVoters.add(voter.toLowerCase());

  // Match the original producer's 17-character prefixes and Unicode ellipsis.
  const gauges = new Map<string, number>();
  for (const [i, label] of proposal.choices.entries()) {
    const start = label.lastIndexOf(" - ");
    const end = label.lastIndexOf("…");
    if (start >= 0 && end > start) gauges.set(label.slice(start + 3, end).toLowerCase(), i + 1);
  }

  const candidates: SdCrvAutoVoteCandidate[] = [];
  const scoringProposal = { ...proposal, strategies };
  const limit = pLimit(3);
  const rows = await Promise.all(accounts.map(account => limit(async () => {
    const voter = account.voter.toLowerCase();
    const history = archive.get(voter);
    if (!history?.length) throw new Error(`Missing archived sdCRV registration for ${voter}`);
    const variants = history.filter(state => !state.killed && state.user.toLowerCase() === voter)
      .map(state => registrationWeights(state, gauges))
      .filter(state => state.weightedChoices.some(([, weight]) => weight > 0));
    if (!variants.length) return;
    // A delegation strategy's scores depend on its input cohort. The producer
    // scored each address separately, even when several users chose the same gauge.
    const vp = await getIndividualVotingPower(scoringProposal, voter);
    return { voter, vp, direct: directVoters.has(voter), ...variants[0], alternatives: variants.slice(1) };
  })));
  for (const row of rows) if (row) candidates.push(row);
  const contributions = reconcileSdCrvAutoVote(ballot.choice, candidates);
  const eligible = new Set(accounts.filter(account => account.delegatedAtCreation).map(account => account.voter.toLowerCase()));
  if (contributions.some(row => !eligible.has(row.voter))) {
    throw new Error("The sdCRV ballot would pay an address outside the delegation at proposal creation");
  }
  return contributions;
}
