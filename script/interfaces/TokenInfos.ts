export interface TokenInfos {
    [tokenAddress: string]: {
        symbol: string;
        decimals: number;
    };
}