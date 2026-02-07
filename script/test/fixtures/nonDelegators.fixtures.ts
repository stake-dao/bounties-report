/**
 * Test fixtures for computeNonDelegatorsDistribution.
 *
 * These fixtures model the real data shapes used in both vlAURA and vlCVX
 * pipelines. Each fixture exercises a different aspect of the distribution logic.
 */

// A token address used across tests (USDC-like)
export const TOKEN_A = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
// A second token address (DOLA-like)
export const TOKEN_B = "0x865377367054516e17014ccded1e7d814edc9ce4";

// Gauge addresses
export const GAUGE_1 = "0x1111111111111111111111111111111111111111";
export const GAUGE_2 = "0x2222222222222222222222222222222222222222";

/**
 * Minimal CSV result: one gauge, one reward token, single reward amount.
 */
export const minimalCsvResult = {
  [GAUGE_1]: [
    {
      rewardAddress: TOKEN_A,
      rewardAmount: BigInt("1000000000000000000"), // 1e18
    },
  ],
};

/**
 * Gauge mapping that maps GAUGE_1 to choiceId 1.
 */
export const minimalGaugeMapping = {
  [GAUGE_1.toLowerCase()]: { choiceId: 1 },
};

/**
 * Two voters, both voting for choice 1.
 * Voter A: vp=100, 100% to choice 1
 * Voter B: vp=100, 100% to choice 1
 * => each gets 50% of rewards.
 */
export const twoEqualVoters = [
  {
    voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vp: 100,
    choice: { "1": 1 },
  },
  {
    voter: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    vp: 100,
    choice: { "1": 1 },
  },
];

/**
 * Two voters with unequal VP: voter A has 75% of total VP.
 */
export const unequalVoters = [
  {
    voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vp: 300,
    choice: { "1": 1 },
  },
  {
    voter: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    vp: 100,
    choice: { "1": 1 },
  },
];

/**
 * A voter who votes for multiple choices (split vote).
 * Voter A: vp=200, 50% to choice 1, 50% to choice 2
 * Voter B: vp=100, 100% to choice 1
 *
 * For gauge 1 (choiceId=1):
 *   Voter A effective VP = 200 * (1/2) = 100
 *   Voter B effective VP = 100 * (1/1) = 100
 *   Total VP = 200, each gets 50%
 */
export const splitVoteVoters = [
  {
    voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vp: 200,
    choice: { "1": 1, "2": 1 },
  },
  {
    voter: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    vp: 100,
    choice: { "1": 1 },
  },
];

/**
 * A voter who did NOT vote for gauge 1 -- should receive nothing.
 */
export const nonParticipatingVoter = [
  {
    voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vp: 100,
    choice: { "1": 1 },
  },
  {
    voter: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    vp: 100,
    choice: { "2": 1 }, // votes for choice 2 only
  },
];

/**
 * Multiple gauges with multiple reward tokens.
 */
export const multiGaugeCsvResult = {
  [GAUGE_1]: [
    {
      rewardAddress: TOKEN_A,
      rewardAmount: BigInt("1000000000000000000"),
    },
  ],
  [GAUGE_2]: [
    {
      rewardAddress: TOKEN_B,
      rewardAmount: BigInt("2000000000000000000"),
    },
  ],
};

export const multiGaugeMapping = {
  [GAUGE_1.toLowerCase()]: { choiceId: 1 },
  [GAUGE_2.toLowerCase()]: { choiceId: 2 },
};

/**
 * A voter who votes for both gauges.
 */
export const multiGaugeVoters = [
  {
    voter: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    vp: 100,
    choice: { "1": 1, "2": 1 },
  },
];

/**
 * Empty inputs for edge cases.
 */
export const emptyCsvResult = {};
export const emptyVotes: any[] = [];

/**
 * CSV with a gauge that does not exist in gaugeMapping -- should throw.
 */
export const unmappedGaugeCsvResult = {
  "0x9999999999999999999999999999999999999999": [
    {
      rewardAddress: TOKEN_A,
      rewardAmount: BigInt("1000000000000000000"),
    },
  ],
};
