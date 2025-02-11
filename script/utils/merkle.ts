import { getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { Distribution } from "../interfaces/Distribution";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";

export const createCombineDistribution = (
    currentDistribution: { distribution: Distribution },
    previousMerkleData: MerkleData
): UniversalMerkle => {

    // Convert distribution to merkle format
    const merkleDistribution = Object.entries(currentDistribution.distribution).reduce(
        (acc, [address, data]) => {
            acc[address] = Object.entries(data.tokens).reduce(
                (tokenAcc, [tokenAddress, amount]) => {
                    tokenAcc[tokenAddress] = amount.toString();
                    return tokenAcc;
                },
                {} as { [tokenAddress: string]: string }
            );
            return acc;
        },
        {} as { [address: string]: { [tokenAddress: string]: string } }
    );

    // First normalize the merkleDistribution addresses
    const normalizedMerkleDistribution: UniversalMerkle = {};

    // Normalize the new distribution first
    Object.entries(merkleDistribution).forEach(([address, tokens]) => {
        const normalizedAddress = getAddress(address);
        normalizedMerkleDistribution[normalizedAddress] = {};

        // Normalize and merge token amounts for the same address
        Object.entries(tokens).forEach(([tokenAddress, amount]) => {
            const normalizedTokenAddress = getAddress(tokenAddress);
            const currentAmount = BigInt(
                normalizedMerkleDistribution[normalizedAddress][
                normalizedTokenAddress
                ] || "0"
            );
            const newAmount = BigInt(amount);
            normalizedMerkleDistribution[normalizedAddress][
                normalizedTokenAddress
            ] = (currentAmount + newAmount).toString();
        });
    });

    // Then merge with previous merkle data
    if (previousMerkleData && previousMerkleData.claims) {
        Object.entries(previousMerkleData.claims).forEach(
            ([address, claimData]) => {
                const normalizedAddress = getAddress(address);

                if (!normalizedMerkleDistribution[normalizedAddress]) {
                    normalizedMerkleDistribution[normalizedAddress] = {};
                }

                if (claimData && claimData.tokens) {
                    Object.entries(claimData.tokens).forEach(
                        ([tokenAddress, tokenData]: [string, any]) => {
                            const normalizedTokenAddress = getAddress(tokenAddress);
                            const prevAmount = BigInt(tokenData.amount || "0");
                            const currentAmount = BigInt(
                                normalizedMerkleDistribution[normalizedAddress][
                                normalizedTokenAddress
                                ] || "0"
                            );

                            normalizedMerkleDistribution[normalizedAddress][
                                normalizedTokenAddress
                            ] = (prevAmount + currentAmount).toString();
                        }
                    );
                }
            }
        );
    }

    return normalizedMerkleDistribution;
}

