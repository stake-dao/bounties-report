// nonDelegators.ts
export type Distribution = Record<string, { tokens: Record<string, bigint> }>;

/**
 * Computes vlAURA rewards distribution for non-delegation voters.
 * It processes the CSV report and votes using gauge mapping to compute each voter's share.
 */
export const computeNonDelegatorsDistribution = (
  csvResult: any,
  gaugeMapping: any,
  votes: any
): Distribution => {
  const distribution: Distribution = {};

  Object.entries(csvResult).forEach(([gauge, rewardInfos]) => {
    const gaugeInfo = gaugeMapping[gauge.toLowerCase()];
    if (!gaugeInfo) throw new Error(`Choice ID not found for gauge: ${gauge}`);
    const choiceId = gaugeInfo.choiceId;
    let totalVp = 0;
    const voterVps: Record<string, number> = {};

    // Calculate total VP for this gauge.
    votes.forEach((voter: any) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      if (currentChoiceIndex === 0) return;
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      totalVp += (voter.vp * ratio) / 100;
    });

    // Calculate each voter's share.
    votes.forEach((voter: any) => {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (choiceId === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      if (currentChoiceIndex === 0) return;
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      const voterShare = (voter.vp * ratio) / 100;
      voterVps[voter.voter] = voterShare / totalVp;
    });

    // Distribute rewards based on voting shares
    (rewardInfos as any[]).forEach(({ rewardAddress, rewardAmount }: any) => {
      let remainingRewards = rewardAmount;
      let processedVoters = 0;
      const totalVoters = Object.keys(voterVps).length;
      Object.entries(voterVps).forEach(([voter, share]) => {
        processedVoters++;
        let amount: bigint;
        if (processedVoters === totalVoters) {
          amount = remainingRewards; // last voter gets remaining to avoid dust.
        } else {
          amount =
            (rewardAmount * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);
          remainingRewards -= amount;
        }
        if (amount > 0n) {
          if (!distribution[voter]) {
            distribution[voter] = { tokens: {} };
          }
          distribution[voter].tokens[rewardAddress] =
            (distribution[voter].tokens[rewardAddress] || 0n) + amount;
        }
      });
    });
  });

  // Remove any entries with zero amounts.
  Object.keys(distribution).forEach((voter) => {
    const nonZeroTokens = Object.entries(distribution[voter].tokens).filter(
      ([, amount]) => amount > 0
    );
    if (nonZeroTokens.length === 0) {
      delete distribution[voter];
    } else {
      distribution[voter].tokens = Object.fromEntries(nonZeroTokens);
    }
  });

  return distribution;
};
