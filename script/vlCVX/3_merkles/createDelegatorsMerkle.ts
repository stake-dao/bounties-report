import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import * as moment from "moment";
dotenv.config();

import { type PublicClient, getAddress, pad } from "viem";
import { http, createPublicClient } from "viem";
import { mainnet } from "../../utils/chains";
import { getPrimaryRpcUrl } from "../../utils/rpcConfig";
import type { MerkleData } from "../../interfaces/MerkleData";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import {
	CRVUSD,
	CVX_SPACE,
	SCRVUSD,
	CVX_GAUGE_VOTE_PLATFORM_CURVE,
	VLCVX_DELEGATORS_MERKLE,
} from "../../utils/constants";
import {
	getOnChainProposal,
	getOnChainVoters,
} from "../../utils/gaugeVotePlatform";
import { getClient } from "../../utils/getClients";
import { distributionVerifier } from "../../utils/merkle/distributionVerifier";
import { createCombineDistribution } from "../../utils/merkle/merkle";
import { findPreviousMerkle } from "../../utils/merkle/findPreviousMerkle";
// Removed unused price utils imports
import { WETH_ADDRESS } from "../../utils/reportUtils";
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

	// If no FXN delegation, everything belongs to Curve — no split needed.
	if (!hasFxnDelegation) {
		return {
			curveCrvUsdAmount: totalScrvUsd,
			fxnCrvUsdAmount: 0n,
		};
	}

	// --- Attribute each deposit tx's minted sCRVUSD to Curve/FXN ---
	// Each swap tx moves reward tokens out of the VM/Votium source, swaps them
	// (the route varies: legacy ALL_MIGHT token→WETH→crvUSD hops, ALL_MIGHT_V2 +
	// aggregator since Aug 2026) and mints sCRVUSD to the distributor within the
	// same tx. Tracing individual swap legs is route-dependent and silently
	// breaks on executor migrations, so instead split each tx's minted sCRVUSD
	// by the protocol weights of the reward tokens moved in that tx. Swap
	// batches are built per protocol, so in practice a tx is 100% Curve or FXN.
	const TRANSFER_TOPIC =
		"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
	const PADDED_DISTRIBUTOR = pad(VLCVX_DELEGATORS_MERKLE as `0x${string}`, {
		size: 32,
	}).toLowerCase();
	const scrvUsdLower = SCRVUSD.toLowerCase();
	const excludedTokens = new Set([
		scrvUsdLower,
		CRVUSD.toLowerCase(),
		WETH_ADDRESS.toLowerCase(),
	]);

	let curveCrvUsdAmount = 0n;
	let fxnCrvUsdAmount = 0n;

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

		let mintedToDistributor = 0n;
		const inputTokens = new Set<string>();
		for (const log of receipt.logs) {
			if (
				!log.topics ||
				!log.topics[0] ||
				log.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
				log.topics.length < 3
			)
				continue;
			const token = log.address.toLowerCase();
			if (
				token === scrvUsdLower &&
				(log.topics[2] as string).toLowerCase() === PADDED_DISTRIBUTOR
			) {
				mintedToDistributor += BigInt(log.data);
			} else if (
				!excludedTokens.has(token) &&
				(totalCurveTokens[token] !== undefined ||
					totalFxnTokens[token] !== undefined)
			) {
				inputTokens.add(token);
			}
		}
		if (mintedToDistributor === 0n) continue;

		let curveWeight = 0n;
		let fxnWeight = 0n;
		for (const token of inputTokens) {
			curveWeight += totalCurveTokens[token] || 0n;
			fxnWeight += totalFxnTokens[token] || 0n;
		}
		const totalWeight = curveWeight + fxnWeight;
		// Unattributable deposit (e.g. a WETH-only leg): skip — the final
		// normalization spreads it pro-rata across both protocols.
		if (totalWeight === 0n) continue;

		const curvePart = (mintedToDistributor * curveWeight) / totalWeight;
		curveCrvUsdAmount += curvePart;
		fxnCrvUsdAmount += mintedToDistributor - curvePart;
	}

	// Never write a silent zero distribution while sCRVUSD actually arrived:
	// fail the run so the pipeline halts before set-root.
	if (totalScrvUsd > 0n && curveCrvUsdAmount + fxnCrvUsdAmount === 0n) {
		throw new Error(
			`Protocol split attributed 0 of ${totalScrvUsd} sCRVUSD across ${txHashes.length} deposit tx(s) — refusing to write an empty distribution. Did the swap route change?`,
		);
	}

	console.log(
		`Protocol split: curve=${curveCrvUsdAmount} fxn=${fxnCrvUsdAmount} (total on-chain: ${totalScrvUsd})`,
	);

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
	// Idempotency guard: abort if this period's merkle already exists, unless caller
	// explicitly forces a regeneration. Prevents re-running the merkle step after a
	// publish has happened — which would otherwise read a stale `latest/` (pre-fix)
	// or simply waste work and risk inconsistency.
	const outputPath = path.join(reportsDir, "merkle_data_delegators.json");
	if (fs.existsSync(outputPath) && process.env.FORCE_MERKLE !== "true") {
		console.log(
			`Delegators merkle already exists for period ${currentPeriodTimestamp}: ${outputPath}`,
		);
		console.log("Set FORCE_MERKLE=true to regenerate. Exiting.");
		return;
	}

	// Create a public viem client for mainnet (using an RPC URL from .env if provided)
	const publicClient = createPublicClient({
		chain: mainnet,
		transport: http(getPrimaryRpcUrl(1)),
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

	// Deduct fee from total BEFORE distribution. The fee derives from Llama
	// USD estimates while the pool is actual swap proceeds — they can cross:
	// a negative remainder would silently produce negative delegator shares.
	if (feeAmount > totalScrvUsd) {
		throw new Error(
			`Votium forwarders fee (${feeAmount} wei sCRVUSD) exceeds the sCRVUSD ` +
				`received this period (${totalScrvUsd} wei) — USD estimates diverge ` +
				`from realized proceeds, refusing to distribute`,
		);
	}
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

	// Load previous Merkle data for forwarders from the PREVIOUS PERIOD's archived file.
	// Do NOT read `bounties-reports/latest/` — it is overwritten by the publish step
	// within the current period, and reading it as "previous" on a re-run causes the
	// current period's delta to be added on top of an already-cumulative merkle (2×).
	const { data: previousMerkleData, foundAt } = findPreviousMerkle(
		currentPeriodTimestamp,
		"vlCVX/merkle_data_delegators.json",
	);
	if (foundAt) {
		console.log(`Loaded previous merkle data for delegators from ${foundAt}`);
	} else {
		console.log("No previous merkle data found for delegators (scanned 12 weeks)");
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

	// Integrity check: verify the cumulative delta across the new merkle vs the
	// previous merkle matches the sCRVUSD actually received on-chain this period.
	// A 2× delta indicates a stale `previousMerkleData` being re-accumulated.
	const sumScrvUsd = (data: MerkleData): bigint => {
		let total = 0n;
		for (const claim of Object.values(data.claims || {})) {
			const tok = (claim as any)?.tokens?.[SCRVUSD];
			if (tok?.amount) total += BigInt(tok.amount);
		}
		return total;
	};
	const newCumulative = sumScrvUsd(newMerkleData);
	const prevCumulative = sumScrvUsd(previousMerkleData);
	const delta = newCumulative - prevCumulative;
	const tolerance = BigInt(10 ** 15); // 0.001 sCRVUSD slack for rounding
	if (delta > totalScrvUsd + tolerance) {
		throw new Error(
			`Delegators merkle integrity check failed: cumulative delta ${delta} exceeds on-chain sCRVUSD received ${totalScrvUsd}. ` +
				"Likely cause: stale previousMerkleData reinjection (re-run after publish).",
		);
	}

	// Ensure output directory exists
	if (!fs.existsSync(reportsDir)) {
		fs.mkdirSync(reportsDir, { recursive: true });
	}

	// Write the newly generated Merkle data to a JSON file
	fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
	console.log(
		"Delegators Merkle tree generated and saved as merkle_data_delegators.json",
	);

	// Attempt to verify distribution on mainnet
	try {
		const client = await getClient(1);
		// Pin the proposal to the running period (started the previous Thursday):
		// the Tuesday delegators merkle distributes that Thursday's repartition,
		// and must not drift onto a round that finalized in between.
		const proposal = await getOnChainProposal(
			CVX_GAUGE_VOTE_PLATFORM_CURVE,
			CVX_SPACE,
			client,
			{ targetPeriod: currentPeriodTimestamp },
		);
		const votes = await getOnChainVoters(
			CVX_GAUGE_VOTE_PLATFORM_CURVE,
			Number(proposal.id),
			proposal,
			client,
		);
		console.log("Running verifier with on-chain proposalId:", proposal.id);

		distributionVerifier(
			CVX_SPACE,
			mainnet,
			"0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380", // Target contract
			newMerkleData,
			previousMerkleData,
			currentDistribution.distribution,
			proposal.id,
			"forwarders",
			{ proposal, votes },
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
