import fs from "fs";
import path from "path";
import {
  generateMerkleTree,
} from "../vlCVX/utils";

export const SDT_ADDRESS = "0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f" as `0x${string}`;

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
    `./airdrop.json`
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
    `../../bounties-reports/top-cake-airdrop/merkle_data.json`
  );

  // Step 5: Save the Merkle data to a JSON file
  fs.writeFileSync(merkleDataPath, JSON.stringify(merkleData, null, 2));

  console.log("Merkle trees generated and saved successfully.");
  return merkleData;
}

generateMerkles().catch(console.error);