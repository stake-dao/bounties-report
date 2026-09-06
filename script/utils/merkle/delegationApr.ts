/**
 * Delegation APR for sdFXS.
 *
 * Annualizes the delegation's weekly sdFXS rewards against the total sdFXS
 * voting power. The x4 multiplier matches the legacy createMultiMerkle
 * computation for SDFXS_SPACE (kept after sdFXS moved to the Universal Merkle).
 */
export function computeSdFxsDelegationAPR(
  weeklyDelegationSdFxsRewards: number,
  totalVotingPower: number
): number {
  if (totalVotingPower <= 0 || weeklyDelegationSdFxsRewards <= 0) {
    return 0;
  }
  return (weeklyDelegationSdFxsRewards / totalVotingPower) * 52 * 100 * 4;
}

/**
 * Delegation APR for URD-migrated mainnet sdTokens (sdCRV, sdFXN).
 *
 * Annualizes the delegation's weekly sdToken rewards against the delegation
 * address's voting power in the week's gauge proposal. Matches the legacy
 * createMultiMerkle computation for these spaces (52 weeks, no multiplier).
 */
export function computeDelegationAPR(
  weeklyDelegationRewards: number,
  delegationVotingPower: number
): number {
  if (delegationVotingPower <= 0 || weeklyDelegationRewards <= 0) {
    return 0;
  }
  return (weeklyDelegationRewards / delegationVotingPower) * 52 * 100;
}
