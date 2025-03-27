import request, { gql } from "graphql-request";
import { SNAPSHOT_ENDPOINT, WEEK } from "./constants";
import axios from "axios";
import { orderBy } from "lodash";
import { Proposal, Delegation, Vote } from "./types";

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
      // Modify the filter string to make it a valid regex pattern
      const modifiedFilter = filter.replace(/^\*/, ".*");
      regex = new RegExp(modifiedFilter);
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
 * Fetch last proposal ID for all specified spaces with an optional global filter.
 * @param spaces - Array of space IDs
 * @param currentTimestamp - Current timestamp
 * @param filter - "all" to fetch without filtering or a regex pattern string to match titles
 * @returns Record of space IDs to their last proposal IDs
 */
export const fetchLastProposalsIdsCurrentPeriod = async (
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
    start_lt: currentTimestamp,
  };

  const result = await request(SNAPSHOT_ENDPOINT, query, variables);
  let proposals = result.proposals;

  if (filter !== "all") {
    let regex: RegExp;

    try {
      // Modify the filter string to make it a valid regex pattern
      const modifiedFilter = filter.replace(/^\*/, ".*");
      regex = new RegExp(modifiedFilter);
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
export const fetchProposalsIdsBasedOnExactPeriods = async (
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
          start_lt: ${currentTimestamp}
          title_contains: "Gauge vote"
        }
      ) {
        id
        title
        end
        created
        space {
          id
        }
      }
    }
  `;
  const result = await request(SNAPSHOT_ENDPOINT, query);
  const proposals = result.proposals;

  let associated_timestamps: Record<string, string> = {};
  for (const period of periods) {
    const periodTimestamp = parseInt(period);
    const reportPeriod = (Math.floor(periodTimestamp / WEEK) * WEEK) - WEEK;

    const matchingProposal = proposals.find((proposal: any) => {
      const proposalPeriod = Math.floor(proposal.created / WEEK) * WEEK;
      return proposalPeriod === reportPeriod;
    });

    if (matchingProposal) {
      associated_timestamps[period] = matchingProposal.id;
    } else {
      // Try to find the closest proposal before this period
      const closestProposal = proposals
        .filter((proposal: any) => Math.floor(proposal.created / WEEK) * WEEK <= reportPeriod)
        .sort((a: any, b: any) => b.created - a.created)[0];
      
      if (closestProposal) {
        associated_timestamps[period] = closestProposal.id;
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
export const getProposal = async (idProposal: string): Promise<Proposal> => {
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

export const getLastClosedProposal = async (space: string): Promise<Proposal> => {
  const QUERY_PROPOSAL = gql`
    query Proposal {
      proposals(
        first: 1
        skip: 0
        orderBy: "created",
        orderDirection: desc,
        where: {
          space: "${space}"
          type: "weighted"
          state: "closed"
          title_contains: "Gauge vote"
        }
      ) {
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

  const result = await request(SNAPSHOT_ENDPOINT, QUERY_PROPOSAL);
  return result.proposals[0];
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
    console.log("parseInt(proposal.snapshot)", parseInt(proposal.snapshot));
    console.log("proposal.strategies", proposal.strategies);
    console.log("proposal.space.id", proposal.space.id);
    console.log("addresses", addresses);
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
  proposal: any,
  curveGauges: any[]
): { [key: string]: { shortName: string; choiceId: number } } => {
  const result: { [key: string]: { shortName: string; choiceId: number } } = {};

  for (let i = 0; i < proposal.choices.length; i++) {
    const choice = proposal.choices[i];
    // Case 1: Direct match with shortName
    let curveGauge = curveGauges.find(
      gauge => gauge.shortName.toLowerCase() === choice.toLowerCase()
    );

    if (!curveGauge) {
      // Case 2: Match by extracting addresses
      const addressMatches = choice.match(/0x[a-fA-F0-9]{4}(?:[a-fA-F0-9]{36})?/g);
      if (addressMatches) {
        // Try to match either full address or short address
        curveGauge = curveGauges.find(gauge => 
          addressMatches.some((addr: any) => {
            const gaugeAddr = gauge.gauge.toLowerCase();
            const matchAddr = addr.toLowerCase();
            return gaugeAddr === matchAddr || gaugeAddr.startsWith(matchAddr);
          })
        );
      }
    }

    if (!curveGauge) {
      // Case 3: Match by pool name without addresses
      const poolName = choice.split(/[\s(]/)[0]; // Get text before space or parenthesis
      curveGauge = curveGauges.find(gauge => 
        gauge.shortName.toLowerCase().includes(poolName.toLowerCase())
      );
    }

    if (curveGauge) {
      const gaugeAddress = (curveGauge.rootGauge || curveGauge.gauge).toLowerCase();
      result[gaugeAddress] = {
        shortName: curveGauge.shortName,
        choiceId: i + 1 // Snapshot choices are 1-indexed
      };
    } else {
      console.warn(`Warning: No matching gauge found for choice: ${choice}`);
    }
  }

  return result;
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
