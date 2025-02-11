export interface DelegatorDataAugmented {
    delegators: string[];
    votingPowers: Record<string, number>;
    totalVotingPower: number;
}