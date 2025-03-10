import { expect } from "chai";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { WEEK } from "../script/utils/constants";

// --------------------------------------------------------------------------------
// Adjust these constants for your environment
// --------------------------------------------------------------------------------
const MERKLE_CONTRACT_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const OWNER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";
const GOVERNANCE_ADDRESS = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";
const BOTMARKET_ADDRESS = "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF";

const sdTokens = [
  "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5" as `0x${string}`, // sdCRV
  "0xF24d8651578a55b0C119B9910759a351A3458895" as `0x${string}`, // sdBAL
  "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36" as `0x${string}`, // sdFXS
  "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD" as `0x${string}`, // sdFXN
  "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9" as `0x${string}`, // sdPendle
];

// --------------------------------------------------------------------------------
// Load the Merkle JSON data from file specified as command line argument or default to "merkle.json"
// --------------------------------------------------------------------------------
const getMerkleData = () => {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentWeek =  Math.floor(currentTimestamp / WEEK) * WEEK;
  const merkleFilePath = `../bounties-reports/${currentWeek}/merkle.json`;
  console.log(`Loading Merkle data from: ${merkleFilePath}`);
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, merkleFilePath), "utf-8")
  );
};

const merkleNewData = getMerkleData();

/**
 * Helper function to format token amounts to human-readable format
 */
const formatTokenAmount = (amount: bigint): string => {
  return (Number(amount) / 10**18).toFixed(6);
};

/**
 * Sets up the environment:
 *   1. Gets contract references for "MultiMerkleStash", "Botmarket", and each sdToken.
 *   2. Impersonates GOVERNANCE so that OWNER can use Botmarket.
 *   3. Impersonates OWNER and gives it ETH.
 *   4. (Optional) Transfers small missing amounts, e.g. 0.005 sdFXN from a known holder.
 *   5. Freeze each token's Merkle root = 0x0, then withdraw from Botmarket => Merkle contract.
 */
const setupTest = async () => {
  // 1) MultiMerkleStash contract
  const contract = await hre.viem.getContractAt(
    "MultiMerkleStash",
    MERKLE_CONTRACT_ADDRESS
  );

  // 2) ERC20 token contracts for each sdToken
  const tokenContracts = await Promise.all(
    sdTokens.map((token) => hre.viem.getContractAt("IERC20", token))
  );

  // 3) Botmarket contract
  const botmarketContract = await hre.viem.getContractAt(
    "Botmarket",
    BOTMARKET_ADDRESS
  );

  // --- Impersonate GOVERNANCE for the botmarket allow-listing ---
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [GOVERNANCE_ADDRESS],
  });
  // Give GOVERNANCE some ETH
  await hre.network.provider.send("hardhat_setBalance", [
    GOVERNANCE_ADDRESS,
    "0x56BC75E2D63100000", // 100 ETH
  ]);

  // Permit the OWNER to use Botmarket
  await botmarketContract.write.allowAddress([OWNER_ADDRESS], {
    account: GOVERNANCE_ADDRESS,
  });

  // --- Impersonate OWNER ---
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [OWNER_ADDRESS],
  });
  // Give OWNER some ETH
  await hre.network.provider.send("hardhat_setBalance", [
    OWNER_ADDRESS,
    "0x56BC75E2D63100000", // 100 ETH
  ]);

  // --- (Optional) Example: transfer 0.005 sdFXN from a known holder to the Merkle contract ---
  const sdFXNHolder = "0xbcfE5c47129253C6B8a9A00565B3358b488D42E0";
  const missingAmount = 5_000_000_000_000_000n; // 0.005 * 1e18
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [sdFXNHolder],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    sdFXNHolder,
    "0x56BC75E2D63100000", // 100 ETH
  ]);
  const sdFXNContract = await hre.viem.getContractAt("IERC20", sdTokens[3]); // sdFXN
  await sdFXNContract.write.transfer([MERKLE_CONTRACT_ADDRESS, missingAmount], {
    account: sdFXNHolder,
  });

  // --- Freeze + withdraw from Botmarket for each token ---
  for (let i = 0; i < sdTokens.length; i++) {
    const sdToken = sdTokens[i];

    // Freeze by setting merkleRoot = 0x00
    await contract.write.updateMerkleRoot(
      [sdToken, "0x0000000000000000000000000000000000000000000000000000000000000000"],
      {
        account: OWNER_ADDRESS,
      }
    );

    // Withdraw from Botmarket => Merkle contract
    const balanceBotmarket = await tokenContracts[i].read.balanceOf([
      BOTMARKET_ADDRESS,
    ]);
    if (balanceBotmarket > 0n) {
      await botmarketContract.write.withdraw(
        [[sdToken], [balanceBotmarket], MERKLE_CONTRACT_ADDRESS],
        {
          account: OWNER_ADDRESS,
        }
      );
    }
  }

  return { contract, botmarketContract, tokenContracts };
};

/**
 * processClaims
 *  - Accepts the Merkle data for a single token: includes a 'merkle' object of user => { index, amount, proof }
 *  - For each user with a > 0n amount, claims from `contract`
 *  - Compares the user's pre/post balance to confirm the claim amount matches exactly
 */
const processClaims = async (
  contract: any,
  tokenContract: any,
  merkleData: any,
  sdToken: string
) => {
  const claimedAmounts: { [key: string]: bigint } = {};
  let totalClaimed = 0n;

  // Filter for addresses with an amount > 0
  const numberOfClaims = Object.keys(merkleData.merkle).filter(
    (key) => BigInt(merkleData.merkle[key].amount.hex) > 0n
  ).length;
  console.log(`Processing ${numberOfClaims} claims for token ${sdToken}...`);

  for (const [userAddress, data] of Object.entries(merkleData.merkle)) {
    const amount = BigInt(data.amount.hex);
    if (amount > 0n) {
      // 1) Check user balance before claim
      const balanceBefore = await tokenContract.read.balanceOf([userAddress]);

      // 2) Claim
      await contract.write.claim(
        [sdToken, BigInt(data.index), userAddress, amount, data.proof],
        { account: OWNER_ADDRESS }
      );

      // 3) Check user balance after claim
      const balanceAfter = await tokenContract.read.balanceOf([userAddress]);
      const claimed = balanceAfter - balanceBefore;

      // 4) Ensure claimed == merkle amount
      expect(claimed).to.equal(amount, `Claim mismatch for ${userAddress}`);

      claimedAmounts[userAddress] = claimed;
      totalClaimed += claimed;
    }
  }

  return { claimedAmounts, totalClaimed };
};

describe("MultiMerkleStash - Botmarket Withdraw + New Merkle Test", function () {
  it("should process new merkle roots, logging contract balances before/after", async function () {
    // 1) Setup
    const { contract, tokenContracts } = await loadFixture(setupTest);

    // 2) For each token: test only new merkle
    for (let i = 0; i < sdTokens.length; i++) {
      const sdToken = sdTokens[i];
      const tokenContract = tokenContracts[i];

      console.log(`\n===== Testing sdToken: ${sdToken} =====`);

      // Find the new merkle entry for this token
      const targetNewMerkle = merkleNewData.find(
        (item: any) => item.address.toLowerCase() === sdToken.toLowerCase()
      );

      if (!targetNewMerkle) {
        console.log(`No new merkle data for token ${sdToken}, skipping...`);
        continue;
      }

      // --------------------------------------------------------------------------------
      // Process NEW Merkle
      // --------------------------------------------------------------------------------
      console.log("\n[NEW] Setting merkle root & claiming...");

      // 1) Contract balance before claims
      const balanceMerkleBefore = await tokenContract.read.balanceOf([
        MERKLE_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance BEFORE claims: ${balanceMerkleBefore} (${formatTokenAmount(balanceMerkleBefore)} tokens)`
      );
      
      const merkleTotal = BigInt(targetNewMerkle.total.hex);
      console.log(`New Merkle total: ${merkleTotal} (${formatTokenAmount(merkleTotal)} tokens)`);
      
      const diff = BigInt(balanceMerkleBefore) - merkleTotal;
      console.log(`Diff: ${diff} (${formatTokenAmount(diff)} tokens)`);

      // 2) Update to new merkle root
      await contract.write.updateMerkleRoot([sdToken, targetNewMerkle.root], {
        account: OWNER_ADDRESS,
      });

      // 3) Claim for every user
      const { totalClaimed } = await processClaims(
        contract,
        tokenContract,
        targetNewMerkle,
        sdToken
      );

      // 4) Contract balance after claims
      const balanceMerkleAfter = await tokenContract.read.balanceOf([
        MERKLE_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance AFTER claims: ${balanceMerkleAfter} (${formatTokenAmount(balanceMerkleAfter)} tokens)`
      );

      const balanceDelta = balanceMerkleBefore - balanceMerkleAfter;
      console.log(
        `Total tokens withdrawn via claims: ${balanceDelta} (${formatTokenAmount(balanceDelta)} tokens)`
      );
      
      // Check totalClaimed matches merkle total
      expect(totalClaimed).to.equal(
        merkleTotal,
        "Total claimed doesn't match merkle total"
      );
      
      // Check balanceDelta == totalClaimed
      expect(balanceDelta).to.equal(
        totalClaimed,
        "Mismatch in total claimed vs. contract's balance change"
      );
    }
  }).timeout(5000000);
});
