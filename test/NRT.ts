import { expect } from "chai";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

const MERKLE_CONTRACT_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const OWNER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";
const sdTokens = [
  "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5" as `0x${string}`,
];

const setupTest = async () => {
  // Get the contract instance at the deployed address
  const contract = await hre.viem.getContractAt(
    "MultiMerkleStash",
    MERKLE_CONTRACT_ADDRESS
  );

  // Get the token contract instance
  const tokenContract = await hre.viem.getContractAt("IERC20", sdTokens[0]);

  // Impersonate the owner account
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [OWNER_ADDRESS],
  });

  // Add ETH to the impersonated account
  await hre.network.provider.send("hardhat_setBalance", [
    OWNER_ADDRESS,
    "0x56BC75E2D63100000", // 100 ETH in hex
  ]);

  const signer = await hre.viem.getWalletClient(OWNER_ADDRESS);

  return { contract, tokenContract, signer };
};

const processClaims = async (
  contract: any,
  tokenContract: any,
  signer: any,
  merkleData: any
) => {
  const claimedAmounts: { [key: string]: bigint } = {};

  // Count the number of claims to process (when amount is greater than 0)
  const numberOfClaims = Object.keys(merkleData.merkle).filter(
    (key) => BigInt(merkleData.merkle[key].amount.hex) > 0n
  ).length;
  console.log("Processing", numberOfClaims, "claims");

  for (const [userAddress, data] of Object.entries(merkleData.merkle)) {
    const amount = BigInt(data?.amount.hex);
    if (amount > 0n) {
      const balanceBefore = await tokenContract.read.balanceOf([userAddress]);

      await contract.write.claim(
        [sdTokens[0], BigInt(data.index), userAddress, amount, data.proof],
        {
          account: signer.account,
        }
      );

      const balanceAfter = await tokenContract.read.balanceOf([userAddress]);

      // Check that the claimed is what shown in the merkle data
      expect(balanceAfter - balanceBefore).to.equal(amount);

      claimedAmounts[userAddress] = amount;
    }
  }

  return claimedAmounts;
};

describe("Deployed Contract Tests", function () {
  it("should process claims successfully for both old and new merkle roots the same amounts", async function () {
    const { contract, tokenContract, signer } = await loadFixture(setupTest);

    const merkleOldData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "merkle_old.json"), "utf-8")
    );
    const merkleNewData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "merkle.json"), "utf-8")
    );

    const targetOldMerkle = merkleOldData.find(
      (item) => item.address === sdTokens[0]
    );
    const targetNewMerkle = merkleNewData.find(
      (item) => item.address === sdTokens[0]
    );

    if (!targetOldMerkle || !targetNewMerkle) {
      throw new Error(`No merkle data found for address ${sdTokens[0]}`);
    }

    // Take a snapshot before processing any claims
    const snapshotId = await hre.network.provider.send("evm_snapshot");

    console.log("Processing old merkle data");
    await contract.write.updateMerkleRoot([sdTokens[0], targetOldMerkle.root], {
      account: signer.account,
    });
    const oldClaimedAmounts = await processClaims(
      contract,
      tokenContract,
      signer,
      targetOldMerkle
    );

    // Revert to the initial state
    await hre.network.provider.send("evm_revert", [snapshotId]);

    console.log("Processing new merkle data");
    await contract.write.updateMerkleRoot([sdTokens[0], targetNewMerkle.root], {
      account: signer.account,
    });
    const newClaimedAmounts = await processClaims(
      contract,
      tokenContract,
      signer,
      targetNewMerkle
    );

    // Compare old and new claimed amounts
    const allAddresses = new Set([
      ...Object.keys(oldClaimedAmounts),
      ...Object.keys(newClaimedAmounts),
    ]);
    for (const address of allAddresses) {
      const oldAmount = oldClaimedAmounts[address] || 0n;
      const newAmount = newClaimedAmounts[address] || 0n;
      expect(newAmount).to.equal(oldAmount);
    }

    console.log("Number of addresses:", allAddresses.size);
  }).timeout(1000000);
});
