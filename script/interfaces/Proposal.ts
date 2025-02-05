import { Strategy } from "../utils/types";

export interface Proposal {
  id: string;
  title: string;
  start: number;
  end: number;
  state: string;
  created: number;
  choices: string[];
  snapshot: string;
  type: string;
  scores_state: string;
  scores_total: number;
  scores: number[];
  votes: number;
  strategies: Strategy[];
  author: string;
  space: {
    id: string;
  };
}