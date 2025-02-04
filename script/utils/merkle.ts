import { getAddress } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { Distribution } from "../spectra/3_merkles";

export const createCombineDistribution = (
    currentDistribution: { distribution: Distribution },
    previousMerkleData: MerkleData
): Distribution => {
    let combinedDistribution: Distribution = {};

    // Add current week distribution
    Object.entries(currentDistribution.distribution).forEach(
        ([address, data]) => {
            combinedDistribution[address] = {
                tokens: {},
            };
            Object.entries(data.tokens).forEach(
                ([tokenAddress, amount]) => {
                    combinedDistribution[address].tokens[getAddress(tokenAddress)] =
                        BigInt(amount.toString());
                }
            );
        }
    );

    // Add previous merkle amounts
    if (
        previousMerkleData.claims
    ) {
        combinedDistribution = combinePreviousMerkle(previousMerkleData, combinedDistribution);
    }

    return combinedDistribution;
}

const combinePreviousMerkle = (previousMerkleData: MerkleData, combinedDistribution: Distribution): Distribution => {
    Object.entries(previousMerkleData.claims).forEach(
        ([address, claimData]: [string, any]) => {
            if (!combinedDistribution[address]) {
                combinedDistribution[address] = {
                    tokens: {},
                };
            }
            if (claimData && claimData.tokens) {
                Object.entries(claimData.tokens).forEach(
                    ([tokenAddress, tokenData]: [string, any]) => {
                        if (tokenData && tokenData.amount) {
                            const normalizedAddress = getAddress(tokenAddress);

                            if (
                                !combinedDistribution[address].tokens[
                                normalizedAddress
                                ]
                            ) {
                                combinedDistribution[address].tokens[
                                    normalizedAddress
                                ] = 0n;
                            }

                            combinedDistribution[address].tokens[
                                normalizedAddress
                            ] += BigInt(tokenData.amount);
                        }
                    }
                );
            }
        }
    );

    return combinedDistribution;
}

