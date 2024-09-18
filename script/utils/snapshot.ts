import request, { gql } from "graphql-request";
import { SNAPSHOT_ENDPOINT, WEEK } from "./constants";
import axios from "axios";
import { orderBy } from "lodash";
import { GaugeInfo, Proposal, Delegation, Vote } from "./types";
import { CurveGauge } from "./curveApi";

/**
 * Fetch last proposal ID for all specified spaces with an optional global filter.
 * @param spaces - Array of space IDs
 * @param currentTimestamp - Current timestamp
 * @param filter - "all" to fetch without filtering or a regex pattern string to match titles
 * @returns Record of space IDs to their last proposal IDs
 */
export const fetchLastProposalsIds = async (
  spaces: string[],
  currentTimestamp: number,
  filter: string = "all"
): Promise<Record<string, string>> => {
  const query = gql`
    query Proposals($spaces: [String!], $start_lt: Int!) {
      proposals(
        first: 1000
        skip: 0
        orderBy: "created"
        orderDirection: desc
        where: { space_in: $spaces, type: "weighted", start_lt: $start_lt }
      ) {
        id
        title
        space {
          id
        }
      }
    }
  `;

  const variables = {
    spaces,
    start_lt: currentTimestamp - WEEK,
  };

  const result = await request(SNAPSHOT_ENDPOINT, query, variables);
  let proposals = result.proposals;

  if (filter !== "all") {
    let regex: RegExp;

    try {
      // Create a RegExp object from the filter string
      regex = new RegExp(filter);
    } catch (error) {
      throw new Error(`Invalid regex pattern provided for filter: "${filter}"`);
    }

    // Filter proposals based on the regex pattern
    proposals = proposals.filter((proposal: any) => regex.test(proposal.title));
  }

  const proposalIdPerSpace: Record<string, string> = {};
  for (const space of spaces) {
    for (const proposal of proposals) {
      if (proposal.space.id !== space) {
        continue;
      }

      proposalIdPerSpace[space] = proposal.id;
      break; // Stop after finding the latest matching proposal for the space
    }
  }

  return proposalIdPerSpace;
};

/**
 * Fetch proposal IDs based on specified periods for a space
 * @param space - Space ID
 * @param periods - Array of period timestamps
 * @param currentTimestamp - Current timestamp
 * @returns Record of period timestamps to their corresponding proposal IDs
 */
export const fetchProposalsIdsBasedOnPeriods = async (
  space: string,
  periods: string[],
  currentTimestamp: number
): Promise<Record<string, string>> => {
  const query = gql`
    query Proposals {
      proposals(
        first: 1000
        skip: 0
        orderBy: "created",
        orderDirection: desc,
        where: {
          space_in: ["${space}"]
          type: "weighted"
          start_lt: ${currentTimestamp - WEEK}
        }
      ) {
        id
        title
        space {
          id
        }
      }
    }
  `;
  const result = await request(SNAPSHOT_ENDPOINT, query);
  const proposals = result.proposals.filter(
    (proposal: any) => proposal.title.indexOf("Gauge vote") > -1
  );

  // Extract dates from proposals "title"

  let associated_timestamps: Record<string, string> = {};

  for (const proposal of proposals) {
    const title = proposal.title;
    const dateStrings = title.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);

    const date_a = dateStrings[0];
    const date_b = dateStrings[1];

    const parts_a = date_a.split("/");
    const parts_b = date_b.split("/");

    // Convert dd/mm/yyyy to mm/dd/yyyy by swapping the first two elements
    const correctFormat_a = `${parts_a[1]}/${parts_a[0]}/${parts_a[2]}`;
    const correctFormat_b = `${parts_b[1]}/${parts_b[0]}/${parts_b[2]}`;

    const timestamp_a = new Date(correctFormat_a).getTime() / 1000;
    const timestamp_b = new Date(correctFormat_b).getTime() / 1000;

    // Associate if the period is between a and b
    for (const period of periods) {
      if (parseInt(period) >= timestamp_a && parseInt(period) <= timestamp_b) {
        associated_timestamps[period] = proposal.id;
      }
    }
  }
  return associated_timestamps;
};

/**
 * Fetch a specific proposal by ID
 * @param idProposal - Proposal ID
 * @returns Proposal details
 */
export const getProposal = async (idProposal: string): Promise<any> => {
  const QUERY_PROPOSAL = gql`
    query Proposal($id: String!) {
      proposal(id: $id) {
        id
        ipfs
        title
        body
        start
        end
        state
        author
        created
        choices
        snapshot
        type
        strategies {
          name
          params
        }
        space {
          id
          name
          members
          avatar
          symbol
        }
        scores_state
        scores_total
        scores
        votes
      }
    }
  `;

  const result = await request(SNAPSHOT_ENDPOINT, QUERY_PROPOSAL, {
    id: idProposal,
  });
  return result.proposal;
};

/**
 * Get all voters for a proposal
 * @param proposalId - Proposal ID
 * @returns Array of votes
 */
export const getVoters = async (proposalId: string): Promise<any[]> => {
  const QUERY_VOTES = gql`
    query Proposal(
      $proposal: String!
      $orderBy: String
      $orderDirection: OrderDirection
      $created: Int
    ) {
      votes(
        first: 1000
        where: { proposal: $proposal, vp_gt: 0, created_lt: $created }
        orderBy: $orderBy
        orderDirection: $orderDirection
      ) {
        id
        ipfs
        voter
        created
        choice
        vp
        vp_by_strategy
      }
    }
  `;

  let votes: any[] = [];
  let run = true;
  let created = null;

  // Fetch all data
  do {
    let params: any = {
      proposal: proposalId,
      orderBy: "created",
      orderDirection: "desc",
    };

    if (created) {
      params["created"] = created;
    }

    const result = await request(SNAPSHOT_ENDPOINT, QUERY_VOTES, params);

    if (result.votes?.length > 0) {
      votes = votes.concat(result.votes);
      created = result.votes[result.votes.length - 1].created;
    } else {
      run = false;
    }
  } while (run);

  return votes;
};

interface ScoreResponse {
  result?: {
    scores: Record<string, number>[];
  };
}

/**
 * Get voting power for a list of addresses
 * @param proposal - Proposal object
 * @param addresses - Array of addresses
 * @param network - Network ID (default: '1')
 * @param includeExistingVp - Whether to include existing voting power (default: false)
 * @returns Record of addresses to their voting power
 */
export const getVotingPower = async (
  proposal: Proposal,
  addresses: string[],
  network: string = "1",
  includeExistingVp: boolean = false
): Promise<Record<string, number>> => {
  try {
    const { data } = await axios.post<ScoreResponse>(
      "https://score.snapshot.org/api/scores",
      {
        params: {
          network,
          snapshot: parseInt(proposal.snapshot),
          strategies: proposal.strategies,
          space: proposal.space.id,
          addresses,
        },
      }
    );

    if (!data?.result?.scores) {
      throw new Error("No scores returned from the API");
    }

    const result: Record<string, number> = {};

    for (const score of data.result.scores) {
      for (const [address, scoreValue] of Object.entries(score)) {
        const normalizedAddress = address.toLowerCase();
        if (!result[normalizedAddress]) {
          result[normalizedAddress] = 0;
        }
        result[normalizedAddress] += scoreValue as number;
      }
    }

    if (includeExistingVp) {
      addresses.forEach((address) => {
        const vote = (addresses as any as Vote[]).find(
          (v) => v.voter.toLowerCase() === address.toLowerCase()
        );
        if (vote && vote.vp && vote.vp > 0) {
          result[address.toLowerCase()] = vote.vp;
        }
      });
    }

    return result;
  } catch (error) {
    console.error("Error in getVotingPower:", error);
    throw error;
  }
};

/**
 * Format voting power result
 * @param votes - Array of votes
 * @param votingPower - Record of addresses to their voting power
 * @returns Formatted array of votes with voting power
 */
export const formatVotingPowerResult = (
  votes: Vote[],
  votingPower: Record<string, number>
): Vote[] => {
  return orderBy(
    votes.map((vote) => ({
      ...vote,
      vp: votingPower[vote.voter.toLowerCase()] || 0,
    })),
    "vp",
    "desc"
  );
};

/**
 * Associate gauges with choice IDs
 * @param proposal - Proposal object
 * @param curveGauges - Array of Curve gauges
 * @returns Record of gauge addresses to their choice IDs
 */
export const associateGaugesPerId = (
  proposal: Proposal,
  curveGauges: CurveGauge[]
): Record<string, number> => {
  // Create a map gauge address => choice id
  const gaugePerChoiceId: Record<string, number> = {};
  for (let i = 0; i < proposal.choices.length; i++) {
    const choice = proposal.choices[i];

    // Specific case for VeFunder-vyper
    if (choice.toLowerCase() === "VeFunder-vyper".toLowerCase()) {
      gaugePerChoiceId[choice] = i + 1;
      continue;
    }

    // Try to find the gauge object in curve api based on shortName
    const curveGauge = curveGauges.find(
      (curveGauge) =>
        curveGauge.shortName.toLowerCase() === choice.toLowerCase()
    );
    if (!curveGauge) {
      throw new Error(
        "Can't find the correct gauge in the api for choice " + choice
      );
    }

    gaugePerChoiceId[curveGauge.gauge] = i + 1; // + 1 because when you vote for the first gauge, id starts at 1 and not 0
  }
  return gaugePerChoiceId;
};

/**

 * All endpoints here : https://raw.githubusercontent.com/snapshot-labs/snapshot.js/master/src/delegationSubgraphs.json
 */
function wait(ms: number) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve(ms);
    }, ms);
  });
}

/**
 * Get delegators for a space
 * @param space - Space ID
 * @param delegationAddresses - Array of delegation addresses
 * @param proposalCreatedTimestamp - Timestamp when the proposal was created
 * @returns Array of delegations
 */
export const getDelegators = async (
  space: string,
  delegationAddresses: string[],
  proposalCreatedTimestamp: number
): Promise<Delegation[]> => {
  // Rate limit subgraph
  let delegations: Delegation[] = [];
  let run = true;
  let skip = 0;

  const DELEGATIONS_QUERY = gql`
    query Proposal(
      $skip: Int
      $timestamp: Int
      ) {
      delegations(first: 1000 skip: $skip where: {
        space: "${space}"
        delegate_in: [${delegationAddresses
          .map((delegationAddress) => '"' + delegationAddress + '"')
          .join(",")}]
        timestamp_lte: $timestamp
      }) {
        delegator
        delegate
      }
    }
  `;

  do {
    const result = await request(
      "https://subgraph.satsuma-prod.com/c27342af4445/pierres-team--102159/snapshot/api",
      DELEGATIONS_QUERY,
      { skip, timestamp: proposalCreatedTimestamp }
    );

    if (result.delegations?.length > 0) {
      delegations = delegations.concat(result.delegations);
      skip += 1000;
      await wait(500); // Rate limite subgraph
    } else {
      run = false;
    }
  } while (run);

  return delegations;
};
