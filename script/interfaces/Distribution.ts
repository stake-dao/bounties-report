export interface Distribution {
    [address: string]: {
        tokens: {
            [tokenAddress: string]: bigint;
        };
    };
}