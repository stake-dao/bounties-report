import { TokenClaim } from "./TokenClaim";

export interface AddressClaim {
    tokens: {
        [tokenAddress: string]: TokenClaim;
    };
}