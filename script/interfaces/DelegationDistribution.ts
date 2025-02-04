export interface DelegationDistribution {
    [address: string]: {
        tokens?: {
            [tokenAddress: string]: bigint;
        };
        share?: string;
    };
}