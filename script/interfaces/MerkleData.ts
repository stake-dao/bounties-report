import { AddressClaim } from "./AddressClaim";

export interface MerkleData {
    merkleRoot: string;
    claims: {
        [address: string]: AddressClaim;
    };
}