export interface DistributionRow {
    address: string;
    tokenAddress: string;
    symbol: string;
    prevAmount: bigint;
    newAmount: bigint;
    weekChange: bigint;
    distributionAmount: bigint;
    claimed: boolean;
    isError: boolean;
    weekChangePercentage?: number;
    userType?: "forwarder" | "non-forwarder" | "voter";
}