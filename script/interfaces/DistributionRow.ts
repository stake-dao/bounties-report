export interface DistributionRow {
    address: string;
    symbol: string;
    prevAmount: bigint;
    newAmount: bigint;
    weekChange: bigint;
    distributionAmount: bigint;
    claimed: boolean;
    isError: boolean;
}