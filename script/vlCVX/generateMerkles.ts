import { MerkleTree } from "merkletreejs";
import { utils } from "ethers";
import keccak256 from "keccak256";
import fs from "fs";
import path from "path";

interface Distribution {
  [address: string]: {
    tokens: {
      [tokenAddress: string]: number;
    };
  };
}

interface MerkleData {
  merkleRoot: string;
  claims: {
    [address: string]: {
      tokens: {
        [tokenAddress: string]: {
          amount: string;
          proof: string[];
        };
      };
    };
  };
}

const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function generateMerkleForAllTokens(distribution: Distribution): void {
  const leaves: string[] = [];
  const claims: MerkleData['claims'] = {};
  const leafData: { address: string; tokenAddress: string; amount: string }[] = [];

  Object.entries(distribution).forEach(([address, data]) => {
    Object.entries(data.tokens).forEach(([tokenAddress, amount]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ['bytes'],
          [utils.keccak256(
            utils.defaultAbiCoder.encode(
              ['address', 'address', 'uint256'],
              [address, tokenAddress, utils.parseEther(amount.toString())]
            )
          )]
        )
      );
      leaves.push(leaf);
      leafData.push({ address, tokenAddress, amount: utils.parseEther(amount.toString()).toString() });

      if (!claims[address]) {
        claims[address] = { tokens: {} };
      }
      claims[address].tokens[tokenAddress] = {
        amount: utils.parseEther(amount.toString()).toString(),
        proof: []
      };
    });
  });

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();

  // Generate proofs
  leafData.forEach((data, index) => {
    const leaf = utils.keccak256(
      utils.solidityPack(
        ['bytes'],
        [utils.keccak256(
          utils.defaultAbiCoder.encode(
            ['address', 'address', 'uint256'],
            [data.address, data.tokenAddress, data.amount]
          )
        )]
      )
    );
    const proof = merkleTree.getHexProof(leaf);
    claims[data.address].tokens[data.tokenAddress].proof = proof;
  });

  const merkleData: MerkleData = { merkleRoot, claims };

  const outputPath = path.join(__dirname, "..", "..", "bounties-reports", currentPeriodTimestamp.toString(), "vlCVX", "merkle_all_tokens.json");
  ensureDirectoryExistence(outputPath);
  fs.writeFileSync(outputPath, JSON.stringify(merkleData, null, 2));
  console.log(`Merkle tree data for all tokens written to ${outputPath}`);
}

// Example usage
async function runExample() {
  const exampleDistribution: Distribution = {
    "0x1111111111111111111111111111111111111111": {
      tokens: {
        "0xD533a949740bb3306d119CC777fa900bA034cd52": 100, // CRV token
        "0x6B175474E89094C44Da98b954EedeAC495271d0F": 100, // DAI token
      }
    },
    "0x2222222222222222222222222222222222222222": {
      tokens: {
        "0xD533a949740bb3306d119CC777fa900bA034cd52": 100, // CRV token
        "0x6B175474E89094C44Da98b954EedeAC495271d0F": 100, // DAI token
      }
    }
  };

  console.log("Generating Merkle tree for all tokens:");
  generateMerkleForAllTokens(exampleDistribution);
}

// Run the example
runExample().catch((error) => {
  console.error("An error occurred in the example:", error);
  process.exit(1);
});
