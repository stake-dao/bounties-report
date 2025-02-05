export interface DistributionRow {
    address: string;
    prevAmount: bigint;
    newAmount: bigint;
    weekChange: bigint;
    claimed: boolean;
    isError: boolean;
}