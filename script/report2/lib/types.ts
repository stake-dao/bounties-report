// ABOUTME: Shared types for the report2 pipeline
// ABOUTME: Protocol enums and stage artifact shapes used across steps

export type Protocol = "curve" | "balancer" | "fxn" | "frax" | "pendle";

export interface CollectOutput {
  period: number;
  summary: Record<Protocol, number>;
  sources: {
    timestamp1: number;
    timestamp2: number;
    blockNumber1: number;
    blockNumber2: number;
  };
  bounties: Record<Protocol, Record<string, any>>;
}

export interface FetchOutput {
  period: number;
  protocol: Protocol;
  blocks: { from: number; to: number };
  tokens: string[];
  tokenInfos: Record<string, { symbol: string; decimals: number }>;
  swapsIn: any[];
  swapsOut: any[];
  counts: { in: number; out: number };
}

export interface FilterOutput {
  period: number;
  protocol: Protocol;
  sdToken: string;
  excluded: {
    otcBlocks: number[];
    delegatedTokensCount: number;
    vlcvxExcludedBlocks: number[];
    reasons: Record<string, number>;
  };
  filtered: {
    in: any[];
    out: any[];
  };
}

export interface AttributeOutput {
  period: number;
  protocol: Protocol;
  sdMintedTotal: number;
  wethTotals: { in: number; out: number };
  includedTokens: string[];
  includedSdByToken: Record<string, number>;
  txAttributions: Array<{ tx: string; mapped: Record<string, string> }>;
}

export interface AssembleOutputRow {
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardSdValue: number;
  sharePercentage: number;
}
