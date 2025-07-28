import { expect } from "chai";
import hre from "hardhat";
import fs from "fs";
import path from "path";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { WEEK } from "../script/utils/constants";

// --------------------------------------------------------------------------------
// Adjust these constants for your environment
// --------------------------------------------------------------------------------
const MERKLE_VOTERS_CONTRACT_ADDRESS =
  "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db";
const MERKLE_DELEGATORS_CONTRACT_ADDRESS =
  "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380";
const OWNER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";
const GOVERNANCE_ADDRESS = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";
const BOTMARKET_ADDRESS = "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF";
const ALL_MIGHT_ADDRESS = "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05";


// --------------------------------------------------------------------------------
// Load the Merkle JSON data from file (delegators or non‑delegators)
// --------------------------------------------------------------------------------
const getMerkleData = (delegators: boolean) => {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentWeek = Math.floor(currentTimestamp / WEEK) * WEEK;
  const filePath = delegators
    ? `../bounties-reports/${currentWeek}/vlCVX/fxn/merkle_data_non_delegators.json`
    : `../bounties-reports/${currentWeek}/vlCVX/fxn/merkle_data_non_delegators.json`;
  console.log(`Loading Merkle data from: ${filePath}`);
  return JSON.parse(fs.readFileSync(path.join(__dirname, filePath), "utf-8"));
};

// --------------------------------------------------------------------------------
// Load repartition tokens amounts (for non‑delegators only)
// --------------------------------------------------------------------------------
const getRepartitionTokens = () => {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const currentWeek = Math.floor(currentTimestamp / WEEK) * WEEK;
  const nonDelegatorsFilePath = `../bounties-reports/${currentWeek}/vlCVX/fxn/repartition.json`;
  console.log(`Loading repartition data from: ${nonDelegatorsFilePath}`);
  const repartitionData = JSON.parse(
    fs.readFileSync(path.join(__dirname, nonDelegatorsFilePath), "utf-8")
  );
  // repartitionData.distribution is an object mapping distributor addresses to an object
  // with a "tokens" property (which maps token addresses to string amounts)
  return repartitionData.distribution;
};

// --------------------------------------------------------------------------------
// Helper: Sum allocated amounts for a given token from the repartition data.
// --------------------------------------------------------------------------------
function getAllocatedAmountForToken(
  tokenAddress: string,
  repartition: any
): bigint {
  let total = 0n;
  for (const distributor in repartition) {
    const tokens = repartition[distributor].tokens;
    if (tokens && tokens[tokenAddress]) {
      total += BigInt(tokens[tokenAddress]);
    }
  }
  return total;
}

// --------------------------------------------------------------------------------
// Extract token addresses from the claims data
// --------------------------------------------------------------------------------
const getTokenAddressesFromMerkleData = (merkleData: any): string[] => {
  const tokenAddresses = new Set<string>();
  Object.values(merkleData.claims).forEach((claim: any) => {
    Object.keys(claim.tokens).forEach((tokenAddress) => {
      tokenAddresses.add(tokenAddress);
    });
  });
  return Array.from(tokenAddresses);
};

// Global data for each category
const merkleVotersData = getMerkleData(false);
const merkleDelegatorsData = getMerkleData(true);
const repartitionNonDelegators = getRepartitionTokens();

console.log(repartitionNonDelegators);

// Helper to format amounts (assumes 18 decimals)
const formatTokenAmount = (amount: bigint): string => {
  return (Number(amount) / 1e18).toFixed(6);
};

/**
 * Sets up the environment for either delegators or non‑delegators test.
 * Uses different Merkle data and contract addresses based on the `delegators` flag.
 * For non‑delegators test, it performs Botmarket withdrawal using the summed allocated amounts;
 * for delegators.
 */
const setupTest = async (delegators: boolean) => {
  const merkleData = delegators ? merkleDelegatorsData : merkleVotersData;
  const contractAddress = delegators
    ? MERKLE_DELEGATORS_CONTRACT_ADDRESS
    : MERKLE_VOTERS_CONTRACT_ADDRESS;
  const tokenAddresses = getTokenAddressesFromMerkleData(merkleData);

  // Instantiate the UniversalRewardsDistributor contract.
  const contract = await hre.viem.getContractAt(
    "UniversalRewardsDistributor",
    contractAddress
  );

  // Get ERC20 token contracts for each token in the Merkle data.
  const tokenContracts = await Promise.all(
    tokenAddresses.map((token) =>
      hre.viem.getContractAt(
        "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
        token
      )
    )
  );

  // Get the Botmarket contract.
  const botmarketContract = await hre.viem.getContractAt(
    "Botmarket",
    BOTMARKET_ADDRESS
  );

  // Impersonate ALL_MIGHT so that we can call setRoot.
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [ALL_MIGHT_ADDRESS],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    ALL_MIGHT_ADDRESS,
    "0x56BC75E2D63100000",
  ]);

  // Impersonate GOVERNANCE to allow OWNER usage on Botmarket.
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [GOVERNANCE_ADDRESS],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    GOVERNANCE_ADDRESS,
    "0x56BC75E2D63100000",
  ]);
  await botmarketContract.write.allowAddress([OWNER_ADDRESS], {
    account: GOVERNANCE_ADDRESS,
  });

  // Impersonate OWNER.
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [OWNER_ADDRESS],
  });
  await hre.network.provider.send("hardhat_setBalance", [
    OWNER_ADDRESS,
    "0x56BC75E2D63100000",
  ]);

  // For the non‑delegators test, perform Botmarket withdrawal using the summed allocated amounts.
  if (!delegators) {
    for (let i = 0; i < tokenAddresses.length; i++) {
      const tokenAddress = tokenAddresses[i];
      const tokenContract = tokenContracts[i];
      const allocatedAmount = getAllocatedAmountForToken(
        tokenAddress,
        repartitionNonDelegators
      );
      console.log(
        `Total allocated (repartition) for token ${tokenAddress}: ${allocatedAmount} (${formatTokenAmount(
          allocatedAmount
        )} tokens)`
      );
      if (allocatedAmount > 0n) {
        const balanceBotmarket = await tokenContract.read.balanceOf([
          BOTMARKET_ADDRESS,
        ]);
        console.log(
          `Token ${tokenAddress} – Botmarket balance: ${balanceBotmarket}, allocated total: ${allocatedAmount}`
        );
        if (balanceBotmarket >= allocatedAmount) {
          await botmarketContract.write.withdraw(
            [[tokenAddress], [allocatedAmount], contractAddress],
            { account: OWNER_ADDRESS }
          );
          console.log(
            `Withdrew ${formatTokenAmount(
              allocatedAmount
            )} tokens for ${tokenAddress}`
          );
        } else {
          console.log(
            `Insufficient Botmarket balance for token ${tokenAddress}`
          );
        }
      }
    }
  }

  return {
    contract,
    botmarketContract,
    tokenContracts,
    tokenAddresses,
    merkleData,
  };
};

/**
 * Processes claims for a given token using the provided Merkle data.
 * For each claim, it reads the already claimed amount via contract.read.claimed([account, tokenAddress]),
 * computes the expected delta (merkleAmount - alreadyClaimed), and if not fully claimed,
 * calls the claim function. It then verifies that the delta in claimed amount matches expected.
 */
const processClaims = async (
  contract: any,
  tokenContract: any,
  merkleData: any,
  tokenAddress: string
) => {
  let totalDeltaClaimed = 0n;
  let totalExpectedDelta = 0n;
  let numberOfClaims = 0;
  for (const [userAddress, userData] of Object.entries(merkleData.claims)) {
    const tokenData = (userData as any).tokens[tokenAddress];
    if (tokenData && BigInt(tokenData.amount) > 0n) {
      numberOfClaims++;
      const totalAmount = BigInt(tokenData.amount);
      const alreadyClaimed = await contract.read.claimed([
        userAddress,
        tokenAddress,
      ]);
      if (alreadyClaimed >= totalAmount) {
        console.log(
          `User ${userAddress} already claimed full amount (${alreadyClaimed}). Skipping claim.`
        );
        continue;
      }
      const expectedDelta = totalAmount - alreadyClaimed;
      totalExpectedDelta += expectedDelta;

      // Read token balance of user BEFORE claiming.
      const balanceBefore = await tokenContract.read.balanceOf([userAddress]);

      // Call the claim function using the signature:
      // claim(address rewardToken, address account, uint256 totalAmount, bytes32[] merkleProof)
      await contract.write.claim(
        [userAddress, tokenAddress, totalAmount, tokenData.proof],
        { account: OWNER_ADDRESS }
      );

      // Read the updated claimed amount.
      const newClaimed = await contract.read.claimed([
        userAddress,
        tokenAddress,
      ]);
      const deltaClaimed = newClaimed - alreadyClaimed;
      expect(deltaClaimed).to.equal(
        expectedDelta,
        `Claim mismatch for ${userAddress}`
      );
      totalDeltaClaimed += deltaClaimed;
    }
  }
  console.log(
    `Processed ${numberOfClaims} claims for token ${tokenAddress}. Expected delta: ${totalExpectedDelta}, Actual delta: ${totalDeltaClaimed}`
  );
  return { totalDeltaClaimed, totalExpectedDelta };
};

// -----------------------
// Fixture functions
// -----------------------
async function nonDelegatorsFixture() {
  return setupTest(false);
}

async function delegatorsFixture() {
  return setupTest(true);
}

/* =======================================================================
   Test: Non‑Delegators (voters) – Botmarket withdrawal should occur (if allocated)
======================================================================= */
describe("AA", function () {
  it("should process new merkle roots for non delegators", async function () {
    const { contract, tokenContracts, tokenAddresses, merkleData } =
      await loadFixture(nonDelegatorsFixture);

    // Set the Merkle root using the value from the file.
    await contract.write.setRoot(
      [merkleData.merkleRoot, merkleData.merkleRoot],
      { account: ALL_MIGHT_ADDRESS }
    );

    for (let i = 0; i < tokenAddresses.length; i++) {
      const tokenAddress = tokenAddresses[i];
      const tokenContract = tokenContracts[i];

      console.log(`\n===== Testing token: ${tokenAddress} =====`);
      // Log the allocated amount (from repartition) for this token.
      const allocatedAmount = getAllocatedAmountForToken(
        tokenAddress,
        repartitionNonDelegators
      );
      console.log(
        `Total allocated (repartition) for token ${tokenAddress}: ${allocatedAmount} (${formatTokenAmount(
          allocatedAmount
        )} tokens)`
      );

      // Get Merkle contract's token balance BEFORE claims.
      const balanceBefore = await tokenContract.read.balanceOf([
        MERKLE_VOTERS_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance BEFORE claims: ${balanceBefore} (${formatTokenAmount(
          balanceBefore
        )} tokens)`
      );

      const { totalDeltaClaimed, totalExpectedDelta } = await processClaims(
        contract,
        tokenContract,
        merkleData,
        tokenAddress
      );

      const balanceAfter = await tokenContract.read.balanceOf([
        MERKLE_VOTERS_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance AFTER claims: ${balanceAfter} (${formatTokenAmount(
          balanceAfter
        )} tokens)`
      );

      const balanceDelta = balanceBefore - balanceAfter;
      console.log(
        `Total tokens withdrawn via claims: ${balanceDelta} (${formatTokenAmount(
          balanceDelta
        )} tokens)`
      );

      expect(totalDeltaClaimed).to.equal(
        totalExpectedDelta,
        "Total delta claimed does not match expected delta"
      );
      expect(balanceDelta).to.equal(
        totalDeltaClaimed,
        "Balance change does not equal total tokens claimed"
      );
    }
  }).timeout(5000000);
});

/* =======================================================================
    Test: Delegators – Processing claims======================================================================= */
describe("UUD - Delegators Test", function () {
  it("should process new merkle roots for delegators (with withdrawal)", async function () {
    const { contract, tokenContracts, tokenAddresses, merkleData } =
      await loadFixture(delegatorsFixture);

    // Set the Merkle root using the value from the file.
    await contract.write.setRoot(
      [merkleData.merkleRoot, merkleData.merkleRoot],
      { account: ALL_MIGHT_ADDRESS }
    );

    for (let i = 0; i < tokenAddresses.length; i++) {
      const tokenAddress = tokenAddresses[i];
      const tokenContract = tokenContracts[i];

      console.log(`\n===== Testing token: ${tokenAddress} =====`);
      // For delegators, we don't use repartition for token withdrawal (handled differently).
      // Get Merkle contract's token balance BEFORE claims.
      const balanceBefore = await tokenContract.read.balanceOf([
        MERKLE_DELEGATORS_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance BEFORE claims: ${balanceBefore} (${formatTokenAmount(
          balanceBefore
        )} tokens)`
      );

      const { totalDeltaClaimed, totalExpectedDelta } = await processClaims(
        contract,
        tokenContract,
        merkleData,
        tokenAddress
      );

      const balanceAfter = await tokenContract.read.balanceOf([
        MERKLE_DELEGATORS_CONTRACT_ADDRESS,
      ]);
      console.log(
        `Merkle contract balance AFTER claims: ${balanceAfter} (${formatTokenAmount(
          balanceAfter
        )} tokens)`
      );

      const balanceDelta = balanceBefore - balanceAfter;
      console.log(
        `Total tokens withdrawn via claims: ${balanceDelta} (${formatTokenAmount(
          balanceDelta
        )} tokens)`
      );

      expect(totalDeltaClaimed).to.equal(
        totalExpectedDelta,
        "Total delta claimed does not match expected delta"
      );
      expect(balanceDelta).to.equal(
        totalDeltaClaimed,
        "Balance change does not equal total tokens claimed"
      );
    }
  }).timeout(5000000);
});
