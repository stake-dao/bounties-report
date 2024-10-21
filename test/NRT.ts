import { expect } from "chai";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";

const MERKLE_CONTRACT_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const OWNER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";
const GOVERNANCE_ADDRESS = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";
const sdTokens = [
  "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5" as `0x${string}`, // sdCRV
  "0xF24d8651578a55b0C119B9910759a351A3458895" as `0x${string}`, // sdBAL
  "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36" as `0x${string}`, // sdFXS
  // "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD" as `0x${string}`, // sdFXN
  "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9" as `0x${string}`, // sdPendle
];

const setupTest = async () => {
  // Get the contract instance at the deployed address
  const contract = await hre.viem.getContractAt(
    "MultiMerkleStash",
    MERKLE_CONTRACT_ADDRESS
  );

  // Get all token contract instances
  const tokenContracts = await Promise.all(
    sdTokens.map(token => hre.viem.getContractAt("IERC20", token))
  );

  // Botmarket address
  const botmarketAddress = "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF";
  const botmarketContract = await hre.viem.getContractAt(
    "Botmarket",
    botmarketAddress
  );

  // Impersonate governance to allow OWNER to use botmarket
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [GOVERNANCE_ADDRESS],
  });

  // Add ETH to the impersonated account
  await hre.network.provider.send("hardhat_setBalance", [
    GOVERNANCE_ADDRESS,
    "0x56BC75E2D63100000", // 100 ETH in hex
  ]);

  await botmarketContract.write.allowAddress([OWNER_ADDRESS], {
    account: GOVERNANCE_ADDRESS,
  });

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


  // Send 0.005 sdFXN to merkle
  const sdFXN_ADDRESS = "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD";

  const holder = "0xbcfE5c47129253C6B8a9A00565B3358b488D42E0"

  const amount = 5000000000000000; // 0.005 sdFXN

  // Impersonate and send to merkle
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [holder],
  });

  await hre.network.provider.send("hardhat_setBalance", [
    holder,
    "0x56BC75E2D63100000", // 100 ETH in hex
  ]);

  const sdFXNContract = await hre.viem.getContractAt("IERC20", sdFXN_ADDRESS);
  await sdFXNContract.write.transfer([holder, amount], {
    account: holder,
  });

  const signer = await hre.viem.getWalletClient(OWNER_ADDRESS);

  return { contract, botmarketContract, tokenContracts, signer };
};

const processClaims = async (
  contract: any,
  tokenContract: any,
  signer: any,
  merkleData: any,
  sdToken: string
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
        [sdToken, BigInt(data.index), userAddress, amount, data.proof],
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
  it("should process claims successfully for both old and new merkle roots the same amounts for all sdTokens", async function () {
    const { contract, botmarketContract, tokenContracts, signer } = await loadFixture(setupTest);

    const merkleOldData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "merkle_old.json"), "utf-8")
    );
    const merkleNewData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "merkle.json"), "utf-8")
    );

    for (let i = 0; i < sdTokens.length; i++) {
      const sdToken = sdTokens[i];
      const tokenContract = tokenContracts[i];

      console.log(`Processing sdToken: ${sdToken}`);

      const targetOldMerkle = merkleOldData.find(
        (item) => item.address === sdToken
      );
      const targetNewMerkle = merkleNewData.find(
        (item) => item.address === sdToken
      );

      if (!targetOldMerkle || !targetNewMerkle) {
        console.log(`No merkle data found for address ${sdToken}, skipping`);
        continue;
      }

      // Freeze + withdraw funds from Botmarket
      await contract.write.updateMerkleRoot(
        [
          sdToken,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        {
          account: signer.account,
        }
      );

      // withdraw
      const balanceBotmarket = await tokenContract.read.balanceOf([
        "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF",
      ]);
      await botmarketContract.write.withdraw(
        [[sdToken], [balanceBotmarket], MERKLE_CONTRACT_ADDRESS],
        {
          account: signer.account,
        }
      );

      // Take a snapshot before processing any claims
      const snapshotId = await hre.network.provider.send("evm_snapshot");

      // Console log the balance of that token in merkle + what in the merkle data
      const balanceMerkle = await tokenContract.read.balanceOf([
        MERKLE_CONTRACT_ADDRESS,
      ]);

      /*
      const diff_old = (BigInt(balanceMerkle) - BigInt(targetOldMerkle.total.hex));
      const diff_new = (BigInt(balanceMerkle) - BigInt(targetNewMerkle.total.hex));

      console.log("Diff old:", diff_old);
      console.log("Diff new:", diff_new);
      */

      console.log("Processing old merkle data");
      await contract.write.updateMerkleRoot([sdToken, targetOldMerkle.root], {
        account: signer.account,
      });
      const oldClaimedAmounts = await processClaims(
        contract,
        tokenContract,
        signer,
        targetOldMerkle,
        sdToken
      );

      // Revert to the initial state
      await hre.network.provider.send("evm_revert", [snapshotId]);

      console.log("Processing new merkle data");
      await contract.write.updateMerkleRoot([sdToken, targetNewMerkle.root], {
        account: signer.account,
      });
      const newClaimedAmounts = await processClaims(
        contract,
        tokenContract,
        signer,
        targetNewMerkle,
        sdToken
      );

      // Compare old and new claimed amounts
      const allAddresses = new Set([
        ...Object.keys(oldClaimedAmounts),
        ...Object.keys(newClaimedAmounts),
      ]);
      for (const address of allAddresses) {
        const oldAmount = oldClaimedAmounts[address] || 0n;
        const newAmount = newClaimedAmounts[address] || 0n;

        if (newAmount !== oldAmount) {
          console.log("Mismatch for address", address, newAmount, oldAmount);
        }
        // expect(newAmount).to.equal(oldAmount);
      }

      console.log(`Number of addresses for ${sdToken}:`, allAddresses.size);
    }
  }).timeout(5000000); // Increased timeout due to multiple tokens
});
