import { getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { Distribution } from "../interfaces/Distribution";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";

export const createCombineDistribution = (
    currentDistribution: { distribution: Distribution },
    previousMerkleData: MerkleData
): UniversalMerkle => {
    const normalizedMerkleDistribution: UniversalMerkle = {};

    const addPositiveAmount = (
        address: string,
        tokenAddress: string,
        amount: bigint
    ) => {
        if (amount <= 0n) return;

        const normalizedAddress = getAddress(address);
        const normalizedTokenAddress = getAddress(tokenAddress);

        if (!normalizedMerkleDistribution[normalizedAddress]) {
            normalizedMerkleDistribution[normalizedAddress] = {};
        }

        const currentAmount = BigInt(
            normalizedMerkleDistribution[normalizedAddress][normalizedTokenAddress] || "0"
        );
        normalizedMerkleDistribution[normalizedAddress][normalizedTokenAddress] = (
            currentAmount + amount
        ).toString();
    };

    // Normalize the new distribution first
    Object.entries(currentDistribution.distribution).forEach(([address, data]) => {
        Object.entries(data.tokens).forEach(([tokenAddress, amount]) => {
            addPositiveAmount(address, tokenAddress, amount);
        });
    });

    // Then merge with previous merkle data
    if (previousMerkleData && previousMerkleData.claims) {
        Object.entries(previousMerkleData.claims).forEach(
            ([address, claimData]) => {
                if (claimData && claimData.tokens) {
                    Object.entries(claimData.tokens).forEach(
                        ([tokenAddress, tokenData]: [string, any]) => {
                            const prevAmount = BigInt(tokenData.amount || "0");
                            addPositiveAmount(address, tokenAddress, prevAmount);
                        }
                    );
                }
            }
        );
    }

    return normalizedMerkleDistribution;
}


export const createSimpleDistribution = (distribution: Distribution): UniversalMerkle => {
    return Object.entries(distribution).reduce((acc, [address, data]) => {
        acc[address] = Object.entries(data.tokens).reduce((tokenAcc, [tokenAddress, amount]) => {
            tokenAcc[tokenAddress] = amount.toString();
            return tokenAcc;
        }, {} as { [tokenAddress: string]: string });
        return acc;
    }, {} as { [address: string]: { [tokenAddress: string]: string } });
}
