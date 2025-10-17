import fs from 'fs';
import path from 'path';
import { createCombineDistribution } from '../utils/merkle/merkle';
import { generateMerkleTree } from '../vlCVX/utils';
import { MerkleData } from '../interfaces/MerkleData';
import { Distribution } from '../interfaces/Distribution';

const main = async () => {
    // Load YB merkle
    const ybMerkle: MerkleData = JSON.parse(fs.readFileSync(path.resolve(__dirname, "yb_merkle.json"), { encoding: 'utf-8' }));

    // Load current extra reward merkle
    const pathExtraMerkle = path.resolve(__dirname, "..", "..", "data", "extra_merkle", "merkle.json")
    const extraRewardMerkle: MerkleData = JSON.parse(fs.readFileSync(pathExtraMerkle, { encoding: 'utf-8' }));

    // Convert userRewards to Distribution format
    const currentDistribution: Distribution = {};
    for(const userAddress of Object.keys(ybMerkle.claims)) {
        if(!currentDistribution[userAddress]) {
            currentDistribution[userAddress] = { tokens: {} };
        }

        for(const tokenAddress of Object.keys(ybMerkle.claims[userAddress].tokens)) {
            currentDistribution[userAddress].tokens[tokenAddress] = BigInt(ybMerkle.claims[userAddress].tokens[tokenAddress].amount);
        }
    }

    // Combine with previous unclaimed rewards
    const combinedDistribution = createCombineDistribution(
        { distribution: currentDistribution },
        extraRewardMerkle
    );

    // Generate merkle tree using shared utility
    const merkleData = generateMerkleTree(combinedDistribution);
    fs.writeFileSync(pathExtraMerkle, JSON.stringify(merkleData, null, 2));
}

main();