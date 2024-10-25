import { BigNumber } from "ethers";

export interface Bounty {
  rewardToken: string;
  gauge: string;
  amount: BigInt;
}

export interface VotemarketBounty extends Bounty {
  bountyId: BigInt;
}

export interface WardenBounty extends Bounty {
  questID: BigInt;
  period: BigInt;
  distributor: string;
}

export interface GaugeShare {
  voted: number;
  share: number;
  gaugeAddress?: string;
  stakeVote?: number;
}

export interface SwapEvent {
  blockNumber: number;
  logIndex: number;
  token: string;
  amount: bigint;
}

export interface GaugeInfo {
  name: string;
  fullName?: string;
  address: string;
  price?: string;
}

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
  space: {
    id: string;
  };
}

export interface Strategy {
  name: string;
  network: string;
  params: any;
}

export interface Delegation {
  delegator: string;
  delegate: string;
}

export interface Vote {
  id: string;
  ipfs: string;
  voter: string;
  created: number;
  choice: Record<string, number>;
  vp: number;
  vp_by_strategy: number[];
  vp_without_delegation: number;
  totalSnapshotWeight: number;
  delegation: DelegationVote[];
}

export interface DelegationVote {
  voter: string;
  vp: number;
}

export type LogId = "TotalReported" | "Concentrator" | "sdCAKE";

export interface Log {
  id: LogId;
  content: string[];
}

export interface RawMerkle {
  merkle: any;
  root: string;
  total: BigNumber;
  chainId: number;
  merkleContract: string;
}

export interface MerkleStat {
  apr: number;
  merkle: Merkle;
  logs: Log[];
}

export interface Merkle {
  symbol: string;
  address: string;
  image: string;
  merkle: any;
  root: string;
  total: BigNumber;
  chainId: number;
  merkleContract: string;
}

export interface DelegatorData {
  event: string;
  user: string;
  spaceId: string;
  timestamp: number;
  blockNumber: number;
}
