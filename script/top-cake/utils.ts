import fs from "fs";
import path from "path";
import {
    generateMerkleTree,
} from "../vlCVX/utils";

export const SDT_ADDRESS = "0x07715EE7219B07b8e01CC7d2787f4e5e75860383" as `0x${string}`;

type Airdrop = UserAirdrop[];

interface UserAirdrop {
    address: string;
    amount: string;
}

interface UsersDistribution {
    [address: string]: { [tokenAddress: string]: string };
}

export async function generateMerkles() {

    // Step 1: Load airdrop distribution
    const airdropPath = path.join(
        __dirname,
        `./top-cake-airdrop.json`
    );
    const airdrop: Airdrop = JSON.parse(
        fs.readFileSync(airdropPath, "utf-8")
    );

    // Step 2 : convert airdrop file to user distributions
    const distribution = airdrop.reduce((acc: UsersDistribution, userAirdrop) => {
        acc[userAirdrop.address] = { [SDT_ADDRESS]: userAirdrop.amount };
        return acc
    }, {});

    // Step 3 : generate the merkle data
    const merkleData = generateMerkleTree(distribution);

    // Step 4: Save merkle data
    const merkleDataPath = path.join(
        __dirname,
        `./merkle_data.json`
    );

    // Step 5: Save the Merkle data to a JSON file
    fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

    console.log("Merkle trees generated and saved successfully.");
    console.log(`Merkle root : ${merkleData.merkleRoot}`);
    return merkleData;
}