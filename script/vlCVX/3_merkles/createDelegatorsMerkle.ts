import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
dotenv.config();

import { getAddress, PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { createPublicClient, http } from "viem";
import { createCombineDistribution } from "../../utils/merkle";
import { generateMerkleTree } from "../utils";
import { MerkleData } from "../../interfaces/MerkleData";
import {
  CVX_SPACE,
  SDT,
  CRVUSD,
  CVX,
  DELEGATION_ADDRESS,
} from "../../utils/constants";
import { getCRVUsdTransfer } from "../utils";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { distributionVerifier } from "../../utils/distributionVerifier";
import {
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../../utils/snapshot";
import { getHistoricalTokenPrice } from "../../utils/utils";
import {
  CRV_ADDRESS,
  mapTokenSwapsToOutToken,
  mergeTokenMaps,
  WETH_ADDRESS,
} from "../../utils/reportUtils";

// Number of seconds in one week
const WEEK = 604800;

// Round current UTC time down to the nearest week to get the current period timestamp
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// The directory to which we'll write the bounties reports for this period
const reportsDir = path.join(
  "bounties-reports",
  currentPeriodTimestamp.toString(),
  "vlCVX"
);

// Path to the JSON file holding delegation data for this period
const CURVE_DELEGATION_FILE = path.join(
  reportsDir,
  "curve",
  "repartition_delegation.json"
);
const FXN_DELEGATION_FILE = path.join(
  reportsDir,
  "fxn",
  "repartition_delegation.json"
);

// Ensure the required file exists before proceeding
if (!fs.existsSync(CURVE_DELEGATION_FILE)) {
  console.error(`Curve delegation file not found: ${CURVE_DELEGATION_FILE}`);
}
if (!fs.existsSync(FXN_DELEGATION_FILE)) {
  console.error(`FXN delegation file not found: ${FXN_DELEGATION_FILE}`);
}

// Load the delegation data from disk
const curveDelegationData = JSON.parse(
  fs.readFileSync(CURVE_DELEGATION_FILE, "utf8")
);
const curveDelegationSummary = curveDelegationData.distribution;

const fxnDelegationData = JSON.parse(
  fs.readFileSync(FXN_DELEGATION_FILE, "utf8")
);
const fxnDelegationSummary = fxnDelegationData.distribution;

// Object where we'll accumulate final forwarder distributions
const curveCombined: {
  [address: string]: { tokens: { [token: string]: bigint } };
} = {};
const fxnCombined: {
  [address: string]: { tokens: { [token: string]: bigint } };
} = {};

// Extract the total share of forwarders from the loaded delegation summary
const totalCurveForwardersShare = parseFloat(
  curveDelegationSummary.totalForwardersShare
);
const totalFxnForwardersShare = parseFloat(
  fxnDelegationSummary.totalForwardersShare
);

// If no forwarders are present, there's no need to do anything
if (totalCurveForwardersShare <= 0 && totalFxnForwardersShare <= 0) {
  console.warn("No forwarders found in delegation data.");
  process.exit(0);
}

async function calculateSDTAmount(maxSDT: bigint): Promise<bigint> {
  const now = moment.utc().unix();
  const filter = "^(?!FXN ).*Gauge Weight for Week of";

  // Get proposal and votes
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [CVX_SPACE],
    now,
    filter
  );
  const proposalId = proposalIdPerSpace[CVX_SPACE];
  const proposal = await getProposal(proposalId);
  const votes = await getVoters(proposalId);

  let totalVotingPower = 0;
  let delegationVotingPower = 0;

  // Process votes for each gauge
  for (const vote of votes) {
    let vpChoiceSum = 0;
    let currentChoiceIndex = 0;

    for (const [choiceIndex, value] of Object.entries(vote.choice)) {
      vpChoiceSum += value;
    }

    if (vpChoiceSum > 0) {
      const effectiveVp = vote.vp;
      totalVotingPower += effectiveVp;
      if (vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
        delegationVotingPower += effectiveVp;
      }
    }
  }

  // Get CVX and SDT prices
  const cvxPrice = await getHistoricalTokenPrice(
    Number(proposal.start),
    "ethereum",
    CVX
  );
  const sdtPrice = await getHistoricalTokenPrice(now, "ethereum", SDT);

  // Calculate required SDT amount for 5% APR
  // Formula: (sdtAmount * sdtPrice * 52) / (cvxPrice * delegationVPSDT) * 100 = 5
  let requiredSDTAmount =
    (0.05 * (cvxPrice * delegationVotingPower)) / (52 * sdtPrice);

  // Cap at the provided maxSDT
  requiredSDTAmount = Math.min(requiredSDTAmount, maxSDT);

  console.log(`SDT Amount for 5% APR: ${requiredSDTAmount.toFixed(2)}`);
  const sdtValue = requiredSDTAmount * sdtPrice;
  const annualizedSDT = sdtValue * 52;
  const sdtAPR = (annualizedSDT / (cvxPrice * delegationVotingPower)) * 100;
  console.log(`Actual SDT APR: ${sdtAPR.toFixed(2)}%`);

  // Store SDT amount in a JSON file
  const sdtInfo = {
    amount: requiredSDTAmount,
    timestamp: now,
    period: currentPeriodTimestamp,
    sdtPrice,
    cvxPrice,
    delegationVotingPower,
    apr: sdtAPR,
  };

  // Ensure directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Write to SDT.json file
  fs.writeFileSync(
    path.join(reportsDir, "SDT.json"),
    JSON.stringify(sdtInfo, null, 2)
  );
  console.log(`SDT information saved to ${path.join(reportsDir, "SDT.json")}`);

  // Convert to BigInt with 18 decimals
  return BigInt(Math.floor(requiredSDTAmount * 1e18));
}

// There is FXN + Curve. We need to know shares of each (for the total CRVUSD); because delegators can be different
// One can be not present on one (voted by himself), but present on the other
async function getProtocolShares(
  publicClient: PublicClient,
  totalCrvUsd: bigint,
  txHashes: string[]
) {
  // --- File Paths & Data Loading ---
  const curveDelegationFilePath = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    "curve",
    "repartition_delegation.json"
  );
  const fxnDelegationFilePath = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    "fxn",
    "repartition_delegation.json"
  );

  let curveDelegationSummary: any = null;
  if (fs.existsSync(curveDelegationFilePath)) {
    const data = JSON.parse(fs.readFileSync(curveDelegationFilePath, "utf8"));
    curveDelegationSummary = data.distribution;
  } else {
    throw new Error("Curve delegation file not found");
  }

  let fxnDelegationSummary: any = null;
  if (fs.existsSync(fxnDelegationFilePath)) {
    const data = JSON.parse(fs.readFileSync(fxnDelegationFilePath, "utf8"));
    fxnDelegationSummary = data.distribution;
  } else {
    throw new Error("FXN delegation file not found");
  }

  // --- Helper for Normalizing Keys ---
  const normalizeMap = (
    map: Record<string, bigint>
  ): Record<string, bigint> => {
    const normalized: Record<string, bigint> = {};
    for (const [token, amt] of Object.entries(map)) {
      normalized[token.toLowerCase()] = amt;
    }
    return normalized;
  };

  // --- Initialize Delegation Maps (Normalize Keys) ---
  let totalCurveVM: { [token: string]: bigint } = {};
  let totalFxnVM: { [token: string]: bigint } = {};

  if (curveDelegationSummary.totalPerGroup) {
    for (const [token, amount] of Object.entries(
      curveDelegationSummary.totalPerGroup
    )) {
      if (amount.forwarders) {
        totalCurveVM[token.toLowerCase()] = BigInt(amount.forwarders);
      }
    }
  }

  if (fxnDelegationSummary.totalPerGroup) {
    for (const [token, amount] of Object.entries(
      fxnDelegationSummary.totalPerGroup
    )) {
      if (amount.forwarders) {
        totalFxnVM[token.toLowerCase()] = BigInt(amount.forwarders);
      }
    }
  }

  // --- Load Votium Data ---
  const votiumClaimedBountiesFilePath = path.join(
    "weekly-bounties",
    currentPeriodTimestamp.toString(),
    "votium",
    "claimed_bounties_convex.json"
  );

  let votiumClaimedBounties = { curve: {}, fxn: {} };
  let votiumForwarders = { tokenAllocations: {} };

  // Make Votium file optional
  if (fs.existsSync(votiumClaimedBountiesFilePath)) {
    votiumClaimedBounties = JSON.parse(
      fs.readFileSync(votiumClaimedBountiesFilePath, "utf8")
    );

    const votiumForwardPath = path.join(
      "weekly-bounties",
      currentPeriodTimestamp.toString(),
      "votium",
      "forwarders_voted_rewards.json"
    );

    if (fs.existsSync(votiumForwardPath)) {
      votiumForwarders = JSON.parse(fs.readFileSync(votiumForwardPath, "utf8"));
    } else {
      console.log("Votium forwarders file not found, using empty data");
    }
  } else {
    console.log("Votium claimed bounties file not found, using empty data");
  }

  let totalCurveVotium: { [token: string]: bigint } = {};
  let totalFxnVotium: { [token: string]: bigint } = {};

  for (const [_, data] of Object.entries(votiumClaimedBounties.curve)) {
    const token = (data.rewardToken as string).toLowerCase();
    totalCurveVotium[token] =
      (totalCurveVotium[token] || 0n) + BigInt(data.amount);
  }
  for (const [_, data] of Object.entries(votiumClaimedBounties.fxn)) {
    const token = (data.rewardToken as string).toLowerCase();
    totalFxnVotium[token] = (totalFxnVotium[token] || 0n) + BigInt(data.amount);
  }

  // Subtract forwarders amounts
  for (const [_, data] of Object.entries(votiumForwarders.tokenAllocations)) {
    for (const [token, amount] of Object.entries(
      data as Record<string, string>
    )) {
      const key = token.toLowerCase();
      if (totalCurveVotium[key]) totalCurveVotium[key] -= BigInt(amount);
      if (totalFxnVotium[key]) totalFxnVotium[key] -= BigInt(amount);
    }
  }

  // --- Merge Delegation & Votium Tokens ---
  let totalCurveTokens: { [token: string]: bigint } = { ...totalCurveVM };
  let totalFxnTokens: { [token: string]: bigint } = { ...totalFxnVM };

  for (const [token, amount] of Object.entries(totalCurveVotium)) {
    totalCurveTokens[token] = (totalCurveTokens[token] || 0n) + amount;
  }
  for (const [token, amount] of Object.entries(totalFxnVotium)) {
    totalFxnTokens[token] = (totalFxnTokens[token] || 0n) + amount;
  }

  // --- Separate Tx Hashes for Votium vs. VM ---
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const PADDED_VOTIUM_DELEGATION_ADDRESS =
    "0x000000000000000000000000ae86a3993d13c8d77ab77dbb8ccdb9b7bc18cd09";

  let votiumTxHashes: string[] = [];
  let vmTxHashes: string[] = [];

  // Skip this part if no txHashes
  if (txHashes.length > 0) {
    for (const txHash of txHashes) {
      const receipt = await publicClient.getTransactionReceipt({
        hash: txHash,
      });
      const isVotium = receipt.logs.some((log) => {
        if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase())
          return false;
        return (
          (log.topics[1] as string).toLowerCase() ===
          PADDED_VOTIUM_DELEGATION_ADDRESS
        );
      });
      if (isVotium) {
        votiumTxHashes.push(txHash);
      } else {
        vmTxHashes.push(txHash);
      }
    }
  }

  // --- Prepare Token Sets (Exclude CRV) ---
  const vmTokens = new Set([
    ...Object.keys(totalCurveVM),
    ...Object.keys(totalFxnVM),
  ]);
  const votiumTokens = new Set([
    ...Object.keys(totalCurveVotium),
    ...Object.keys(totalFxnVotium),
  ]);
  vmTokens.delete(CRV_ADDRESS.toLowerCase());
  votiumTokens.delete(CRV_ADDRESS.toLowerCase());

  // --- Map Tokens to WETH and CRVUSD ---
  let vmTokenToWeth: Record<string, bigint> = {};
  let votiumTokenToWeth: Record<string, bigint> = {};
  let vmTokenToCrvUSD: Record<string, bigint> = {};
  let votiumTokenToCrvUSD: Record<string, bigint> = {};

  if (vmTxHashes.length > 0) {
    const rawVmTokenToWeth = await mapTokenSwapsToOutToken(
      publicClient,
      vmTxHashes[0],
      vmTokens,
      WETH_ADDRESS,
      "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"
    );
    vmTokenToWeth = normalizeMap(rawVmTokenToWeth);

    const rawVmTokenToCrvUSD = await mapTokenSwapsToOutToken(
      publicClient,
      vmTxHashes[0],
      new Set([WETH_ADDRESS.toLowerCase(), CRV_ADDRESS.toLowerCase()]),
      CRVUSD,
      "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"
    );
    vmTokenToCrvUSD = normalizeMap(rawVmTokenToCrvUSD);
  }

  if (votiumTxHashes.length > 0) {
    const rawVotiumTokenToWeth = await mapTokenSwapsToOutToken(
      publicClient,
      votiumTxHashes[0],
      votiumTokens,
      WETH_ADDRESS,
      "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"
    );
    votiumTokenToWeth = normalizeMap(rawVotiumTokenToWeth);

    const rawVotiumTokenToCrvUSD = await mapTokenSwapsToOutToken(
      publicClient,
      votiumTxHashes[0],
      new Set([WETH_ADDRESS.toLowerCase(), CRV_ADDRESS.toLowerCase()]),
      CRVUSD,
      "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"
    );
    votiumTokenToCrvUSD = normalizeMap(rawVotiumTokenToCrvUSD);
  }

  const tokenToWeth = mergeTokenMaps(vmTokenToWeth, votiumTokenToWeth);
  const tokenToCrvUSD = mergeTokenMaps(vmTokenToCrvUSD, votiumTokenToCrvUSD);

  // --- Compute Totals for Non-CRV Tokens ---
  const totalWETH = Object.entries(tokenToWeth)
    .filter(([token]) => token.toLowerCase() !== CRV_ADDRESS.toLowerCase())
    .reduce((acc, [_, amt]) => acc + amt, 0n);
  const totalCrvUSDNonCRV = Object.entries(tokenToCrvUSD)
    .filter(([token]) => token.toLowerCase() !== CRV_ADDRESS.toLowerCase())
    .reduce((acc, [_, amt]) => acc + amt, 0n);

  // --- Build Final crvUSD Mapping ---
  const finalTokenCrvUSD: Record<string, bigint> = {};
  const allTokens = new Set([
    ...Object.keys(tokenToWeth),
    ...Object.keys(tokenToCrvUSD),
  ]);
  for (const token of allTokens) {
    const tokenLower = token.toLowerCase();
    if (tokenLower === CRV_ADDRESS.toLowerCase()) {
      finalTokenCrvUSD[tokenLower] = tokenToCrvUSD[tokenLower] || 0n;
    } else {
      const wethAmt = tokenToWeth[tokenLower] || 0n;
      const directCrvUSD = tokenToCrvUSD[tokenLower] || 0n;
      const proportion =
        totalWETH > 0n ? (wethAmt * totalCrvUSDNonCRV) / totalWETH : 0n;
      finalTokenCrvUSD[tokenLower] = directCrvUSD + proportion;
    }
  }
  delete finalTokenCrvUSD[WETH_ADDRESS.toLowerCase()];
  console.log("Final crvUSD per token:", finalTokenCrvUSD);

  // --- Calculate Protocol-Specific crvUSD Amounts ---
  let curveCrvUsdAmount = 0n;
  let fxnCrvUsdAmount = 0n;
  for (const [token, crvUsdAmount] of Object.entries(finalTokenCrvUSD)) {
    const curveAmount = totalCurveTokens[token] || 0n;
    const fxnAmount = totalFxnTokens[token] || 0n;
    const totalAmount = curveAmount + fxnAmount;
    if (totalAmount > 0n) {
      curveCrvUsdAmount += (curveAmount * crvUsdAmount) / totalAmount;
      fxnCrvUsdAmount += (fxnAmount * crvUsdAmount) / totalAmount;
    }
  }

  // Normalize with totalCrvUsd
  const computedTotal = curveCrvUsdAmount + fxnCrvUsdAmount;
  if (computedTotal > 0n) {
    curveCrvUsdAmount = (curveCrvUsdAmount * totalCrvUsd) / computedTotal;
    fxnCrvUsdAmount = (fxnCrvUsdAmount * totalCrvUsd) / computedTotal;
  }
  return { curveCrvUsdAmount, fxnCrvUsdAmount };
}

async function computeShares(
  totalCrvUsd: bigint,
  totalSDT: bigint,
  delegationSummary: any,
  skippedUsers: Set<string>
) {
  let totalValidShares = 0;
  let combined: { [address: string]: { tokens: { [token: string]: bigint } } } =
    {};
  // If SDT : Curve (SDT)
  if (totalSDT > 0n) {
    for (const [address, shareStr] of Object.entries(
      delegationSummary.forwarders
    )) {
      const share = parseFloat(shareStr);
      if (share <= 0) continue;

      const addr = getAddress(address);
      if (!skippedUsers.has(addr)) {
        totalValidShares += share;
      }
    }
  } else {
    totalValidShares = Object.values(delegationSummary.forwarders).reduce(
      (acc, shareStr) => acc + parseFloat(shareStr),
      0
    );
  }

  // Iterate over each forwarder from the delegation summary
  // Calculate their portion of both crvUSD and SDT
  for (const [address, shareStr] of Object.entries(
    delegationSummary.forwarders
  )) {
    const share = parseFloat(shareStr);
    if (share <= 0) continue; // Skip any zero or negative shares

    // Convert the address to EIP-55 format
    const addr = getAddress(address);

    // Calculate crvUSD amount for everyone
    const crvUsdAmount =
      (totalCrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

    // Calculate SDT amount only for non-skipped users
    let sdtAmount = 0n;
    if (!skippedUsers.has(addr)) {
      // Adjust share relative to total valid shares for SDT distribution
      const adjustedShare = share / totalValidShares;
      sdtAmount =
        (totalSDT * BigInt(Math.floor(adjustedShare * 1e18))) / BigInt(1e18);
    }

    // Only add if the user gets a non-zero allocation
    if (crvUsdAmount > 0n || sdtAmount > 0n) {
      combined[addr] = { tokens: {} };
      if (crvUsdAmount > 0n) {
        combined[addr].tokens[CRVUSD] = crvUsdAmount;
      }
      if (sdtAmount > 0n) {
        combined[addr].tokens[SDT] = sdtAmount;
      }
    }
  }

  return combined;
}

/**
 * Main function to compute forwarder rewards, build a Merkle tree,
 * and run the distribution verifier.
 */
async function processForwarders() {
  // Create a public viem client for mainnet (using an RPC URL from .env if provided)
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL || "https://rpc.flashbots.net"),
  });

  // Fetch the current block number
  const currentBlock = Number(await publicClient.getBlockNumber());

  // We'll look for transfers since the start of the current period,
  // i.e., the block near `currentPeriodTimestamp`
  const minBlock = await getClosestBlockTimestamp(
    "ethereum",
    currentPeriodTimestamp
  );

  // Query the CRVUSD transfer data within the specified block range
  const crvUsdTransfer = await getCRVUsdTransfer(minBlock, currentBlock);

  // We store the total amount of crvUSD found during this time frame
  let totalCrvUsd = crvUsdTransfer.amount;

  // Subtract a small buffer to avoid minor rounding issues
  totalCrvUsd -= BigInt(10 ** 14);
  console.log("Total crvUSD for distribution:", totalCrvUsd.toString());

  // Calculate SDT amount based on 5% APR
  const totalSDT = await calculateSDTAmount(3750); // Max SDT cap
  console.log("Total SDT for distribution:", totalSDT.toString());

  const skippedUsers = new Set([
    getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"), // Bent
  ]);

  const protocolShares = await getProtocolShares(
    publicClient,
    totalCrvUsd,
    crvUsdTransfer.txHashes
  );

  // Split : Curve & FXN
  const curveCombined = await computeShares(
    protocolShares.curveCrvUsdAmount,
    totalSDT,
    curveDelegationSummary,
    skippedUsers
  );

  const fxnCombined = await computeShares(
    protocolShares.fxnCrvUsdAmount,
    0n,
    fxnDelegationSummary,
    skippedUsers
  );

  // Merge the two distributions (sum token amounts if same address)
  const combined: {
    [address: string]: { tokens: { [token: string]: bigint } };
  } = {};

  // Helper function to merge token distributions
  const mergeDistributions = (
    source: { [address: string]: { tokens: { [token: string]: bigint } } },
    target: { [address: string]: { tokens: { [token: string]: bigint } } }
  ) => {
    for (const [address, data] of Object.entries(source)) {
      if (!target[address]) {
        // If address doesn't exist in target, add it
        target[address] = { tokens: { ...data.tokens } };
      } else {
        // If address exists, sum token amounts
        for (const [token, amount] of Object.entries(data.tokens)) {
          target[address].tokens[token] =
            (target[address].tokens[token] || 0n) + amount;
        }
      }
    }
  };

  // First add all curve distributions
  mergeDistributions(curveCombined, combined);

  // Then add all fxn distributions (summing where needed)
  mergeDistributions(fxnCombined, combined);

  // Load previous Merkle data for forwarders (if any)
  // This file is used to ensure continuity of claims across periods
  const previousMerkleDataPath = path.join(
    "bounties-reports",
    "latest",
    "vlCVX",
    "vlcvx_merkle_delegators.json"
  );

  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleDataPath, "utf8")
    );
    console.log(
      "Loaded previous merkle data for delegators from latest directory"
    );
  } else {
    console.log(
      "No previous merkle data found for delegators in latest directory"
    );
  }

  // Combine the current distribution with the previous claims
  // so that any leftover / carry-over amounts remain claimable
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);

  console.log("Delegators Merkle Root:", newMerkleData.merkleRoot);

  // Ensure output directory exists
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Write the newly generated Merkle data to a JSON file
  const outputPath = path.join(reportsDir, "merkle_data_delegators.json");
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(
    "Delegators Merkle tree generated and saved as merkle_data_delegators.json"
  );

  // Attempt to verify distribution on mainnet
  const filter = "^(?!FXN ).*Gauge Weight for Week of";
  const now = Math.floor(Date.now() / 1000);
  try {
    // Find the proposal ID used for verifying distribution
    const proposalIdPerSpace = await fetchLastProposalsIds(
      [CVX_SPACE],
      now,
      filter
    );
    const proposalId = proposalIdPerSpace[CVX_SPACE];
    console.log("Running verifier with proposalId:", proposalId);

    distributionVerifier(
      CVX_SPACE,
      mainnet,
      "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380", // Target contract
      newMerkleData,
      previousMerkleData,
      currentDistribution.distribution,
      proposalId
    );
  } catch (error) {
    console.error("Error running distribution verifier:", error);
  }
}

// Run the forwarders processing flow
processForwarders().catch(console.error);
