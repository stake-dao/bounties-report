import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import * as moment from "moment";
dotenv.config();

import { type PublicClient, getAddress } from "viem";
import { http, createPublicClient } from "viem";
import { mainnet } from "../../utils/chains";
import type { MerkleData } from "../../interfaces/MerkleData";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import { CRVUSD, CVX_SPACE, SCRVUSD } from "../../utils/constants";
import { distributionVerifier } from "../../utils/merkle/distributionVerifier";
import { createCombineDistribution } from "../../utils/merkle/merkle";
// Removed unused price utils imports
import {
	CRV_ADDRESS,
	WETH_ADDRESS,
	mapTokenSwapsToOutToken,
	mergeTokenMaps,
} from "../../utils/reportUtils";
import { fetchLastProposalsIds } from "../../utils/snapshot";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { getSCRVUsdTransfer } from "../utils";

// Number of seconds in one week
const WEEK = 604800;

// Round current UTC time down to the nearest week to get the current period timestamp
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// Fee recipient for Votium forwarders fee
const FEE_RECIPIENT = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";

// The directory to which we'll write the bounties reports for this period
const reportsDir = path.join(
	"bounties-reports",
	currentPeriodTimestamp.toString(),
	"vlCVX",
);

// Path to the JSON file holding delegation data for this period
const CURVE_DELEGATION_FILE = path.join(
	reportsDir,
	"curve",
	"repartition_delegation.json",
);
const FXN_DELEGATION_FILE = path.join(
	reportsDir,
	"fxn",
	"repartition_delegation.json",
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
	fs.readFileSync(CURVE_DELEGATION_FILE, "utf8"),
);
const curveDelegationSummary = curveDelegationData.distribution;

let fxnDelegationData = null;
let fxnDelegationSummary = null;
try {
	fxnDelegationData = JSON.parse(fs.readFileSync(FXN_DELEGATION_FILE, "utf8"));
	fxnDelegationSummary = fxnDelegationData.distribution;
} catch (_error) {
	console.log(
		"No FXN delegation data found, allocating all to Curve delegators",
	);
}

// Extract the total share of forwarders from the loaded delegation summary
const totalCurveForwardersShare = Number.parseFloat(
	curveDelegationSummary.totalForwardersShare,
);
const totalFxnForwardersShare = Number.parseFloat(
	fxnDelegationSummary?.totalForwardersShare || 0,
);

// If no forwarders are present, there's no need to do anything
if (totalCurveForwardersShare <= 0 && totalFxnForwardersShare <= 0) {
	console.warn("No forwarders found in delegation data.");
	process.exit(0);
}

// There is FXN + Curve. We need to know shares of each (for the total CRVUSD); because delegators can be different
// One can be not present on one (voted by himself), but present on the other
async function getProtocolShares(
	publicClient: PublicClient,
	totalScrvUsd: bigint,
	txHashes: string[],
) {
	// --- File Paths & Data Loading ---
	const curveDelegationFilePath = path.join(
		"bounties-reports",
		currentPeriodTimestamp.toString(),
		"vlCVX",
		"curve",
		"repartition_delegation.json",
	);
	const fxnDelegationFilePath = path.join(
		"bounties-reports",
		currentPeriodTimestamp.toString(),
		"vlCVX",
		"fxn",
		"repartition_delegation.json",
	);

	let curveDelegationSummary: any = null;
	if (fs.existsSync(curveDelegationFilePath)) {
		const data = JSON.parse(fs.readFileSync(curveDelegationFilePath, "utf8"));
		curveDelegationSummary = data.distribution;
	} else {
		throw new Error("Curve delegation file not found");
	}

	let fxnDelegationSummary: any = null;
	let hasFxnDelegation = false;
	try {
		const data = JSON.parse(fs.readFileSync(fxnDelegationFilePath, "utf8"));
		fxnDelegationSummary = data.distribution;
		hasFxnDelegation = true;
	} catch (_error) {
		console.log("No FXN delegation file found, allocating all to Curve");
	}

	// --- Helper for Normalizing Keys ---
	const normalizeMap = (
		map: Record<string, bigint>,
	): Record<string, bigint> => {
		const normalized: Record<string, bigint> = {};
		for (const [token, amt] of Object.entries(map)) {
			normalized[token.toLowerCase()] = amt;
		}
		return normalized;
	};

	// --- Initialize Delegation Maps (Normalize Keys) ---
	const totalCurveVM: { [token: string]: bigint } = {};
	const totalFxnVM: { [token: string]: bigint } = {};

	if (curveDelegationSummary.totalPerGroup) {
		for (const [token, amount] of Object.entries(
			curveDelegationSummary.totalPerGroup,
		)) {
			if (amount.forwarders) {
				totalCurveVM[token.toLowerCase()] = BigInt(amount.forwarders);
			}
		}
	}

	if (fxnDelegationSummary?.totalPerGroup) {
		for (const [token, amount] of Object.entries(
			fxnDelegationSummary.totalPerGroup,
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
		"claimed_bounties_convex.json",
	);

	let votiumClaimedBounties = { curve: {}, fxn: {} };
	let votiumForwarders = { tokenAllocations: {} };

	// Make Votium file optional
	if (fs.existsSync(votiumClaimedBountiesFilePath)) {
		votiumClaimedBounties = JSON.parse(
			fs.readFileSync(votiumClaimedBountiesFilePath, "utf8"),
		);

		const votiumForwardPath = path.join(
			"weekly-bounties",
			currentPeriodTimestamp.toString(),
			"votium",
			"forwarders_voted_rewards.json",
		);

		if (fs.existsSync(votiumForwardPath)) {
			votiumForwarders = JSON.parse(fs.readFileSync(votiumForwardPath, "utf8"));

			// Only process forwarders if we have valid data
			if (votiumForwarders.tokenAllocations) {
				// Subtract forwarders amounts
				for (const [_, data] of Object.entries(
					votiumForwarders.tokenAllocations,
				)) {
					for (const [token, values] of Object.entries(
						data as Record<string, string>,
					)) {
						const key = token.toLowerCase();
						if (totalCurveVM[key])
							totalCurveVM[key] -= BigInt(values.amountWei);
						if (totalFxnVM[key]) totalFxnVM[key] -= BigInt(values.amountWei);
					}
				}
			}
		} else {
			console.log(
				"Votium forwarders file not found, skipping forwarders processing",
			);
		}
	} else {
		console.log("Votium claimed bounties file not found, using empty data");
	}

	const totalCurveVotium: { [token: string]: bigint } = {};
	const totalFxnVotium: { [token: string]: bigint } = {};

	for (const [_, data] of Object.entries(votiumClaimedBounties.curve)) {
		const token = (data.rewardToken as string).toLowerCase();
		totalCurveVotium[token] =
			(totalCurveVotium[token] || 0n) + BigInt(data.amount);
	}
	for (const [_, data] of Object.entries(votiumClaimedBounties.fxn)) {
		const token = (data.rewardToken as string).toLowerCase();
		totalFxnVotium[token] = (totalFxnVotium[token] || 0n) + BigInt(data.amount);
	}

	// --- Merge Delegation & Votium Tokens ---
	const totalCurveTokens: { [token: string]: bigint } = { ...totalCurveVM };
	const totalFxnTokens: { [token: string]: bigint } = { ...totalFxnVM };

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

	const votiumTxHashes: string[] = [];
	const vmTxHashes: string[] = [];

	// Skip this part if no txHashes
	if (txHashes.length > 0) {
		for (const txHash of txHashes) {
			let receipt;
			let retries = 0;
			const maxRetries = 10;

			while (retries < maxRetries) {
				try {
					receipt = await publicClient.getTransactionReceipt({
						hash: txHash as `0x${string}`,
					});
					break;
				} catch (error: any) {
					if (retries === maxRetries - 1) throw error;

					// Check if it's a receipt not found error
					if (error.name === 'TransactionReceiptNotFoundError' ||
						(error.message && error.message.includes('could not be found'))) {
						console.warn(`Receipt not found for ${txHash}, retrying (${retries + 1}/${maxRetries})...`);
						await new Promise(resolve => setTimeout(resolve, 2000 * (retries + 1)));
						retries++;
					} else {
						throw error;
					}
				}
			}

			if (!receipt) {
				throw new Error(`Failed to fetch receipt for ${txHash}`);
			}

			const isVotium = receipt.logs.some((log) => {
				if (
					!log.topics ||
					!log.topics[0] ||
					log.topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase()
				)
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
			"0x0000000a3Fc396B89e4c11841B39D9dff85a5D05",
		);
		vmTokenToWeth = normalizeMap(rawVmTokenToWeth);

		const rawVmTokenToCrvUSD = await mapTokenSwapsToOutToken(
			publicClient,
			vmTxHashes[0],
			new Set([WETH_ADDRESS.toLowerCase(), CRV_ADDRESS.toLowerCase()]),
			CRVUSD,
			"0x0000000a3Fc396B89e4c11841B39D9dff85a5D05",
		);
		vmTokenToCrvUSD = normalizeMap(rawVmTokenToCrvUSD);
	}

	if (votiumTxHashes.length > 0) {
		const rawVotiumTokenToWeth = await mapTokenSwapsToOutToken(
			publicClient,
			votiumTxHashes[0],
			votiumTokens,
			WETH_ADDRESS,
			"0x0000000a3Fc396B89e4c11841B39D9dff85a5D05",
		);
		votiumTokenToWeth = normalizeMap(rawVotiumTokenToWeth);

		const rawVotiumTokenToCrvUSD = await mapTokenSwapsToOutToken(
			publicClient,
			votiumTxHashes[0],
			new Set([WETH_ADDRESS.toLowerCase(), CRV_ADDRESS.toLowerCase()]),
			CRVUSD,
			"0x0000000a3Fc396B89e4c11841B39D9dff85a5D05",
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

	// If no FXN delegation, return all to Curve
	if (!hasFxnDelegation) {
		return {
			curveCrvUsdAmount: totalScrvUsd,
			fxnCrvUsdAmount: 0n,
		};
	}

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

	// Normalize with totalScrvUsd
	const computedTotal = curveCrvUsdAmount + fxnCrvUsdAmount;
	if (computedTotal > 0n) {
		curveCrvUsdAmount = (curveCrvUsdAmount * totalScrvUsd) / computedTotal;
		fxnCrvUsdAmount = (fxnCrvUsdAmount * totalScrvUsd) / computedTotal;
	}
	return { curveCrvUsdAmount, fxnCrvUsdAmount };
}

async function computeShares(totalScrvUsd: bigint, delegationSummary: any) {
	// Return empty distribution if no delegation summary
	if (!delegationSummary || !delegationSummary.forwarders) {
		return {};
	}

	const combined: {
		[address: string]: { tokens: { [token: string]: bigint } };
	} = {};

	// Iterate over each forwarder from the delegation summary
	// Calculate their portion of crvUSD
	for (const [address, shareStr] of Object.entries(
		delegationSummary.forwarders,
	)) {
		const share = Number.parseFloat(shareStr);
		if (share <= 0) continue; // Skip any zero or negative shares

		// Convert the address to EIP-55 format
		const addr = getAddress(address);

		// Calculate sCRVUSD amount for everyone
		const scrvUsdAmount =
			(totalScrvUsd * BigInt(Math.floor(share * 1e18))) / BigInt(1e18);

		// Only add if the user gets a non-zero allocation
		if (scrvUsdAmount > 0n) {
			combined[addr] = { tokens: {} };
			combined[addr].tokens[SCRVUSD] = scrvUsdAmount;
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
		transport: http(process.env.WEB3_ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}` : "https://rpc.flashbots.net"),
	});

	// Fetch the current block number
	const currentBlock = Number(await publicClient.getBlockNumber());

	// We'll look for transfers since the start of the current period,
	// i.e., the block near `currentPeriodTimestamp`
	const minBlock = await getClosestBlockTimestamp(
		"ethereum",
		currentPeriodTimestamp,
	);

	// Query the sCRVUSD transfer data within the specified block range
	const scrvUsdTransfer = await getSCRVUsdTransfer(minBlock, currentBlock);

	// We store the total amount of sCRVUSD found during this time frame
	let totalScrvUsd = scrvUsdTransfer.amount;

	// Subtract a small buffer to avoid minor rounding issues
	totalScrvUsd -= BigInt(10 ** 14);
	console.log("Total sCRVUSD received:", totalScrvUsd.toString());

	// Calculate fee amount FIRST before any distribution
	let feeAmount = 0n;
	const forwardersRewardsPath = path.join(
		"weekly-bounties",
		currentPeriodTimestamp.toString(),
		"votium",
		"forwarders_voted_rewards.json",
	);

	if (fs.existsSync(forwardersRewardsPath)) {
		console.log("Calculating Votium forwarders fee...");
		const forwardersData = JSON.parse(fs.readFileSync(forwardersRewardsPath, "utf8"));

		let totalForwardersUSD = 0;

		// Calculate total USD from all tokenAllocations
		if (forwardersData.tokenAllocations) {
			for (const [forwarder, tokens] of Object.entries(forwardersData.tokenAllocations)) {
				for (const [token, values] of Object.entries(tokens as Record<string, any>)) {
					if (values.usd) {
						totalForwardersUSD += values.usd;
					}
				}
			}
		}

		if (totalForwardersUSD > 0) {
			// Get the actual scrvUSD/crvUSD exchange rate from the contract
			const scrvUsdContract = "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367";
			const pricePerShareAbi = [
				{
					inputs: [],
					name: "pricePerShare",
					outputs: [{ name: "", type: "uint256" }],
					stateMutability: "view",
					type: "function",
				},
			] as const;

			// Fetch the current price per share (crvUSD per scrvUSD)
			const pricePerShare = await publicClient.readContract({
				address: scrvUsdContract as `0x${string}`,
				abi: pricePerShareAbi,
				functionName: "pricePerShare",
			});

			console.log(`Total Votium forwarders USD value: $${totalForwardersUSD.toFixed(2)}`);
			console.log(`scrvUSD price per share: ${(Number(pricePerShare) / 1e18).toFixed(6)} crvUSD per scrvUSD`);

			// Convert USD to crvUSD (1:1), then to scrvUSD using the price per share
			// scrvUSD amount = crvUSD amount / pricePerShare
			const crvUsdAmount = BigInt(Math.floor(totalForwardersUSD * 1e18));
			feeAmount = (crvUsdAmount * BigInt(1e18)) / pricePerShare;

			console.log(`Fee amount: ${(Number(feeAmount) / 1e18).toFixed(6)} scrvUSD`);
		}
	}

	// Deduct fee from total BEFORE distribution
	const availableForDistribution = totalScrvUsd - feeAmount;
	console.log("Total sCRVUSD for delegators distribution (after fee):", availableForDistribution.toString());

	const protocolShares = await getProtocolShares(
		publicClient,
		availableForDistribution, // Use the amount after fee deduction
		scrvUsdTransfer.txHashes,
	);

	// Split : Curve & FXN
	const curveCombined = await computeShares(
		protocolShares.curveCrvUsdAmount,
		curveDelegationSummary,
	);

	const fxnCombined = fxnDelegationSummary
		? await computeShares(protocolShares.fxnCrvUsdAmount, fxnDelegationSummary)
		: {};

	// Merge the two distributions (sum token amounts if same address)
	const combined: {
		[address: string]: { tokens: { [token: string]: bigint } };
	} = {};

	// Helper function to merge token distributions
	const mergeDistributions = (
		source: { [address: string]: { tokens: { [token: string]: bigint } } },
		target: { [address: string]: { tokens: { [token: string]: bigint } } },
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

	// Add the pre-calculated fee allocation to the fee recipient
	if (feeAmount > 0n) {
		const feeRecipient = getAddress(FEE_RECIPIENT);

		// Add or update the fee recipient's allocation
		if (!combined[feeRecipient]) {
			combined[feeRecipient] = { tokens: {} };
		}

		// Add scrvUSD allocation
		combined[feeRecipient].tokens[SCRVUSD] =
			(combined[feeRecipient].tokens[SCRVUSD] || 0n) + feeAmount;

		console.log(`\nAdding fee allocation: ${(Number(feeAmount) / 1e18).toFixed(6)} scrvUSD to ${feeRecipient}`);
	}

	// Load previous Merkle data for forwarders (if any)
	// This file is used to ensure continuity of claims across periods
	const previousMerkleDataPath = path.join(
		"bounties-reports",
		"latest",
		"vlCVX",
		"vlcvx_merkle_delegators.json",
	);

	let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
	if (fs.existsSync(previousMerkleDataPath)) {
		previousMerkleData = JSON.parse(
			fs.readFileSync(previousMerkleDataPath, "utf8"),
		);
		console.log(
			"Loaded previous merkle data for delegators from latest directory",
		);
	} else {
		console.log(
			"No previous merkle data found for delegators in latest directory",
		);
	}

	// Combine the current distribution with the previous claims
	// so that any leftover / carry-over amounts remain claimable
	const currentDistribution = { distribution: combined };
	const universalMerkle = createCombineDistribution(
		currentDistribution,
		previousMerkleData,
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
		"Delegators Merkle tree generated and saved as merkle_data_delegators.json",
	);

	// Attempt to verify distribution on mainnet
	const filter = "^(?!FXN ).*Gauge Weight for Week of";
	const now = Math.floor(Date.now() / 1000);
	try {
		// Find the proposal ID used for verifying distribution
		const proposalIdPerSpace = await fetchLastProposalsIds(
			[CVX_SPACE],
			now,
			filter,
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
			proposalId,
			"1",
			"forwarders",
		);
	} catch (error) {
		console.error("Error running distribution verifier:", error);
	}
}

// Run the forwarders processing flow
processForwarders().catch((error) => {
  console.error(error);
  process.exit(1);
});
