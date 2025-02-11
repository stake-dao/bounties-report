import { Chain, createPublicClient, getAddress, http } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { TokenInfos } from "../interfaces/TokenInfos";
import { AddressClaim } from "../interfaces/AddressClaim";

export const fetchTokenInfos = async (combinedDistribution: MerkleData, previousMerkleData: MerkleData, chain: Chain): Promise<TokenInfos> => {
    const rewardTokenAddresses = new Set<string>();

    // Collect from current distribution
    Object.values(combinedDistribution.claims).forEach((data: AddressClaim) => {
        Object.keys(data.tokens).forEach((tokenAddress) =>
            rewardTokenAddresses.add(tokenAddress.toLowerCase())
        );
    });

    // Collect from previous merkle data
    Object.values(previousMerkleData.claims).forEach((claim: AddressClaim) => {
        if (claim.tokens) {
            Object.keys(claim.tokens).forEach((tokenAddress) =>
                rewardTokenAddresses.add(tokenAddress.toLowerCase())
            );
        }
    });

    const publicClient = createPublicClient({
        chain,
        transport: http(),
    });

    const tokenInfoArray = await Promise.allSettled(
        Array.from(rewardTokenAddresses).map(async (tokenAddress) => {
            const address = getAddress(tokenAddress.toLowerCase());
            try {
                const [symbol, decimals] = await Promise.all([
                    publicClient.readContract({
                        address,
                        abi: [
                            {
                                inputs: [],
                                name: "symbol",
                                outputs: [{ type: "string" }],
                                stateMutability: "view",
                                type: "function",
                            },
                        ],
                        functionName: "symbol",
                    }),
                    publicClient.readContract({
                        address,
                        abi: [
                            {
                                inputs: [],
                                name: "decimals",
                                outputs: [{ type: "uint8" }],
                                stateMutability: "view",
                                type: "function",
                            },
                        ],
                        functionName: "decimals",
                    }),
                ]);

                return { tokenAddress: address, symbol, decimals };
            } catch (error) {
                console.error(`Error fetching info for token ${address}:`, error);
                throw error;
            }
        })
    );

    const tokenInfo: TokenInfos = {};
    tokenInfoArray.forEach((result, index) => {
        if (result.status === "fulfilled") {
            const { tokenAddress, symbol, decimals } = result.value;
            tokenInfo[tokenAddress] = {
                symbol: symbol as string,
                decimals: Number(decimals),
            };
        } else {
            const tokenAddress = Array.from(rewardTokenAddresses)[index];
            console.warn(
                `Failed to fetch info for token ${tokenAddress}. Using default values.`
            );
            tokenInfo[tokenAddress] = { symbol: "UNKNOWN", decimals: 18 };
        }
    });

    return tokenInfo;
}
