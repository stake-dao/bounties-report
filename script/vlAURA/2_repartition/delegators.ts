import {
  getDelegatorsWithBalances,
  formatVlAuraBalance,
  type AggregatedDelegator,
} from "../../utils/vlAuraUtils";

export type DelegationDistribution = Record<
  string,
  | { tokens: Record<string, bigint> }
  | { share: string }
>;

export type DelegationSummary = {
  totalTokens: Record<string, string>;
  delegators: Record<string, string>; // address -> normalized share
};

/**
 * Compute delegation distribution for vlAURA.
 * Unlike vlCVX, there is no forwarder/non-forwarder split.
 * All delegators receive native tokens proportionally based on vlAURA balance.
 *
 * @param snapshotBlocks - Map of chainId to block number for balance queries
 * @param stakeDaoDelegators - List of delegator addresses (from GraphQL)
 * @param tokens - Token amounts to distribute
 * @param delegationVoter - The delegation address that voted
 */
export const computeStakeDaoDelegation = async (
  snapshotBlocks: Record<number, bigint>,
  stakeDaoDelegators: string[],
  tokens: Record<string, bigint>,
  delegationVoter: string
): Promise<DelegationDistribution> => {
  const delegationDistribution: DelegationDistribution = {};

  // Store the delegation voter's token totals
  delegationDistribution[delegationVoter] = { tokens: { ...tokens } };

  // Get vlAURA balances for all delegators at snapshot blocks
  const delegatorsWithBalances = await getDelegatorsWithBalances(snapshotBlocks);

  // Filter to only include delegators in our list and compute total
  const delegatorSet = new Set(stakeDaoDelegators.map((d) => d.toLowerCase()));
  const filteredDelegators: AggregatedDelegator[] = delegatorsWithBalances.filter(
    (d) => delegatorSet.has(d.address.toLowerCase())
  );

  const totalVlAura = filteredDelegators.reduce(
    (acc, d) => acc + d.totalBalance,
    BigInt(0)
  );

  console.log(`Total vlAURA delegated: ${formatVlAuraBalance(totalVlAura)}`);
  console.log(`Delegators with balance: ${filteredDelegators.length}`);

  // Compute each delegator's share based on vlAURA balance
  for (const delegator of filteredDelegators) {
    if (delegator.totalBalance > BigInt(0)) {
      // Calculate share as a decimal string (balance / total)
      const share = Number(delegator.totalBalance) / Number(totalVlAura);
      delegationDistribution[delegator.address] = { share: share.toString() };
    }
  }

  return delegationDistribution;
};

/**
 * Compute delegation summary for vlAURA.
 */
export const computeDelegationSummary = (
  delegationDistribution: DelegationDistribution
): DelegationSummary => {
  let totalTokens: Record<string, string> = {};
  const delegators: Record<string, string> = {};

  for (const [address, data] of Object.entries(delegationDistribution)) {
    if ("tokens" in data) {
      totalTokens = Object.entries(data.tokens).reduce(
        (acc, [token, amount]) => {
          acc[token] = amount.toString();
          return acc;
        },
        {} as Record<string, string>
      );
    } else {
      delegators[address] = data.share;
    }
  }

  return { totalTokens, delegators };
};
