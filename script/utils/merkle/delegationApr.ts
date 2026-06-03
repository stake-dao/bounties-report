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
