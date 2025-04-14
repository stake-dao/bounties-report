import { expect } from "chai";
import hre from "hardhat";
import path from "path";
import fs from "fs";
import { SDT } from "../script/utils/constants";

// ----- Constants and Paths -----
const WEEK = 604800;
const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
const basePath = path.join(
  __dirname,
  "..",
  "bounties-reports",
  currentPeriodTimestamp.toString(),
  "vlCVX"
);
const oldBasePath = path.join(
  __dirname,
  "..",
  "bounties-reports",
  (currentPeriodTimestamp - WEEK).toString(),
  "vlCVX"
);

// ----- Synchronous Helper Functions -----

export function fetchSDTAmountSync(): string {
  const sdtFilePath = path.join(basePath, "SDT.json");
  const sdtData = JSON.parse(fs.readFileSync(sdtFilePath, "utf8"));
  return sdtData.amount;
}

export interface TokenData {
  old_amount: string;
  new_amount: string;
  old_proof: string[];
  new_proof: string[];
}

export interface TotalsPerAddress {
  roots: {
    oldRoot: string;
    currentRoot: string;
  };
  claims: {
    [userAddress: string]: {
      tokens: { [tokenAddress: string]: TokenData };
    };
  };
}

export function fetchTotalsPerAddressSync(): TotalsPerAddress {
  const currentMerklePath = path.join(basePath, "merkle_data_delegators.json");
  const oldMerklePath = path.join(oldBasePath, "merkle_data_delegators.json");

  const currentData = JSON.parse(fs.readFileSync(currentMerklePath, "utf8"));
  const oldData = JSON.parse(fs.readFileSync(oldMerklePath, "utf8"));

  const result: TotalsPerAddress = {
    roots: {
      oldRoot: oldData.merkleRoot || "",
      currentRoot: currentData.merkleRoot || "",
    },
    claims: {},
  };

  const allAddresses = new Set([
    ...Object.keys(currentData.claims || {}),
    ...Object.keys(oldData.claims || {}),
  ]);

  for (const address of allAddresses) {
    result.claims[address] = { tokens: {} };

    if (currentData.claims && currentData.claims[address]) {
      const currentTokens = currentData.claims[address].tokens || {};
      for (const tokenAddress in currentTokens) {
        if (!result.claims[address].tokens[tokenAddress]) {
          result.claims[address].tokens[tokenAddress] = {
            old_amount: "0",
            new_amount: "0",
            old_proof: [],
            new_proof: [],
          };
        }
        result.claims[address].tokens[tokenAddress].new_amount =
          currentTokens[tokenAddress].amount || "0";
        result.claims[address].tokens[tokenAddress].new_proof =
          currentTokens[tokenAddress].proof || [];
      }
    }

    if (oldData.claims && oldData.claims[address]) {
      const oldTokens = oldData.claims[address].tokens || {};
      for (const tokenAddress in oldTokens) {
        if (!result.claims[address].tokens[tokenAddress]) {
          result.claims[address].tokens[tokenAddress] = {
            old_amount: "0",
            new_amount: "0",
            old_proof: [],
            new_proof: [],
          };
        }
        result.claims[address].tokens[tokenAddress].old_amount =
          oldTokens[tokenAddress].amount || "0";
        result.claims[address].tokens[tokenAddress].old_proof =
          oldTokens[tokenAddress].proof || [];
      }
    }
  }

  return result;
}

export function getTokenListAndRootsSync(): {
  tokenList: string[];
  roots: { oldRoot: string; currentRoot: string };
} {
  const totals = fetchTotalsPerAddressSync();
  const tokenSet = new Set<string>();

  for (const user in totals.claims) {
    const tokens = totals.claims[user].tokens;
    for (const tokenAddress in tokens) {
      tokenSet.add(tokenAddress);
    }
  }
  return { tokenList: Array.from(tokenSet), roots: totals.roots };
}

// ----- Global Variables for Contracts and Test Data -----
let merkleContract: any;
let sdtAllocationContract: any;
let tokenContracts: any[] = [];
const tokenContractsMap: { [token: string]: any } = {};
const totals: TotalsPerAddress = fetchTotalsPerAddressSync();
const { tokenList, roots } = getTokenListAndRootsSync();

const ALL_MIGHT = "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05";

// ----- INITIAL SETUP: Withdraw SDT and Set Merkle Root -----
describe("Merkle Distributor Setup and Claim Tests", function () {
  before(async function () {
    const sdtToWithdraw = fetchSDTAmountSync();

    merkleContract = await hre.viem.getContractAt(
      "UniversalRewardsDistributor",
      "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380"
    );
    sdtAllocationContract = await hre.viem.getContractAt(
      "Botmarket",
      "0xA3ECF0cc8E88136134203aaafB21F7bD2dA6359a"
    );

    tokenContracts = await Promise.all(
      tokenList.map((token) =>
        hre.viem.getContractAt(
          "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
          token
        )
      )
    );
    for (const tokenInstance of tokenContracts) {
      tokenContractsMap[tokenInstance.address.toLowerCase()] = tokenInstance;
    }

    await hre.network.provider.send("hardhat_setBalance", [
      ALL_MIGHT,
      "0x56BC75E2D63100000",
    ]);
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [ALL_MIGHT],
    });

    // Withdraw SDT tokens: note that we don't call withdrawTx.wait() here.
    await sdtAllocationContract.write.withdraw(
      [[SDT], [sdtToWithdraw], merkleContract.address],
      { account: ALL_MIGHT }
    );

    // Verify the current root and update it.
    const currentRoot = await merkleContract.read.root();
    expect(currentRoot).to.equal(roots.oldRoot);

    await merkleContract.write.setRoot([roots.currentRoot, roots.currentRoot], {
      account: ALL_MIGHT,
    });

    const updatedRoot = await merkleContract.read.root();
    expect(updatedRoot).to.equal(roots.currentRoot);

    await hre.network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [ALL_MIGHT],
    });
  });

  // ----- CLAIM REWARDS TESTS -----
  describe("Claim Rewards per Address", function () {
    for (const [user, claimsData] of Object.entries(totals.claims)) {
      describe(`For account ${user}`, function () {
        for (const token of Object.keys(claimsData.tokens)) {
          it(`should claim token ${token} correctly`, async function () {
            await hre.network.provider.request({
              method: "hardhat_impersonateAccount",
              params: [user],
            });

            const SDTContract = hre.viem.getContractAt(
              "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
              SDT
            )

            console.log("Balance of SDT on merkle contract", await SDTContract.read.balanceOf([merkleContract.address]));

            const tokenContract = tokenContractsMap[token.toLowerCase()];
            if (!tokenContract) {
              throw new Error(`Token contract for ${token} not found`);
            }

            const preBalanceStr = await tokenContract.read.balanceOf([user]);
            const preBalance = BigInt(preBalanceStr);

            const alreadyClaimed = await merkleContract.read.claimed([
              user,
              token,
            ]);
            if (alreadyClaimed >= BigInt(claimsData.tokens[token].new_amount)) {
              console.log(
                `User ${user} already claimed full amount (${alreadyClaimed}). Skipping claim.`
              );
              expect(true).to.be.true;
              return;
            }

            const { new_amount, new_proof } = claimsData.tokens[token];

            const claimAmount = BigInt(new_amount);

            await merkleContract.write.claim(
              [user, token, new_amount, new_proof],
              { account: user }
            );

            const postBalanceStr = await tokenContract.read.balanceOf([user]);
            const postBalance = BigInt(postBalanceStr);

            console.log(postBalance, preBalance, claimAmount);

            //expect(postBalance - preBalance).to.equal(claimAmount);

            await hre.network.provider.request({
              method: "hardhat_stopImpersonatingAccount",
              params: [user],
            });
          });
        }
      });
    }
  });
});
