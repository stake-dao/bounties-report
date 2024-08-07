import request, { gql } from "graphql-request";
import { SNAPSHOT_ENDPOINT, WEEK } from "./constants";
import axios from "axios";
import { orderBy } from 'lodash';

/**
 * Fetch last proposal id for all spaces
 */
export const fetchLastProposalsIds = async (spaces: string[], currentTimestamp: number): Promise<Record<string,string>> => {
  const query = gql`
      query Proposals {
        proposals(
          first: 1000
          skip: 0
          orderBy: "created",
          orderDirection: desc,
          where: {
            space_in: [${spaces.map((space) => '"' + space + '"').join(",")}]
            type: "weighted"
            start_lt: ${currentTimestamp-WEEK}
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
  const proposals = result.proposals.filter((proposal: any) => proposal.title.indexOf("Gauge vote") > -1);

  const proposalIdPerSpace: Record<string,string> = {};
  for (const space of spaces) {

    for (const proposal of proposals) {
      if (proposal.space.id !== space) {
        continue;
      }

      proposalIdPerSpace[space] = proposal.id;
      break;

    }
  }

  return proposalIdPerSpace;
}

export const fetchProposalsIdsBasedOnPeriods = async (space: string, periods: string[], currentTimestamp: number): Promise<Record<string,string>> => {
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
          start_lt: ${currentTimestamp-WEEK}
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
  const proposals = result.proposals.filter((proposal: any) => proposal.title.indexOf("Gauge vote") > -1);

  // Extract dates from proposals "title"

  let associated_timestamps: Record<string,string> = {};

  for (const proposal of proposals) {
    const title = proposal.title;
    const dateStrings = title.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);

    const date_a = dateStrings[0];
    const date_b = dateStrings[1];

    const parts_a = date_a.split('/');
    const parts_b = date_b.split('/');

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
}

/**
 * Fetch the proposal
 */
export const getProposal = async (idProposal: string): Promise<any> => {

  const QUERY_PROPOSAL = gql`
      query Proposal(
        $id: String!
      ) {
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
}

/**
 * Get all voters for a proposal
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
  let created = null

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
    }
    else {
      run = false;
    }

  } while (run);

  return votes;
}

export const getVoterVotingPower = async (proposal: any, votes: any[], network: string): Promise<any[]> => {
  try {
    const votersAddresses = votes.map((v) => v.voter);

    const { data } = await axios.post(
      "https://score.snapshot.org/api/scores",
      {
        params: {
          network,
          snapshot: parseInt(proposal.snapshot),
          strategies: proposal.strategies,
          space: proposal.space.id,
          addresses: votersAddresses
        },
      },
    );

    const scores = votes.map((vote) => {
      let vp = 0;
      if (vote.vp > 0) {
        vp = vote.vp;
      } else if (data?.result?.scores) {
        for (const score of data.result.scores) {
          const keys = Object.keys(score);
          for (const key of keys) {
            if (key.toLowerCase() === vote.voter.toLowerCase()) {
              vp += score[key];
              break;
            }
          }
        }
        //vp = data?.result?.scores?.[0]?.[vote.voter] || data?.result?.scores?.[1]?.[vote.voter];
      }
      return { ...vote, vp };
    });

    return orderBy(scores, "vp", "desc");
  }
  catch (e) {
    console.log("Error getVoterVotingPower");
    throw e;
  }
}