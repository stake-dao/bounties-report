export interface DistributionRow {
    address: string;
    tokenAddress: string;
    prevAmount: bigint;
    newAmount: bigint;
    weekChange: bigint;
    distributionAmount: bigint;
    claimed: boolean;
    isError: boolean;
}