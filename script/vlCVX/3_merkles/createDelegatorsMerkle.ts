import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import * as moment from "moment";
dotenv.config();

import { type PublicClient, formatUnits, getAddress } from "viem";
import { http, createPublicClient } from "viem";
import { mainnet } from "../../utils/chains";
import { getPrimaryRpcUrl } from "../../utils/rpcConfig";
import type { MerkleData } from "../../interfaces/MerkleData";
import { getClosestBlockTimestamp } from "../../utils/chainUtils";
import {
	CVX_SPACE,
	SCRVUSD,
	CVX_GAUGE_VOTE_PLATFORM_CURVE,
} from "../../utils/constants";
import {
	getOnChainProposal,
	getOnChainVoters,
} from "../../utils/gaugeVotePlatform";
import { getClient } from "../../utils/getClients";
import { distributionVerifier } from "../../utils/merkle/distributionVerifier";
import { createCombineDistribution } from "../../utils/merkle/merkle";
import { findPreviousMerkle } from "../../utils/merkle/findPreviousMerkle";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { getSCRVUsdTransfer } from "../utils";
import {
	computeVotiumForwarderPayouts,
	hasClaimedVotiumBounties,
	type ForwarderPayoutResult,
} from "./votiumForwarderPayouts";
import {
	hasPerDelegateAttribution,
	getExactGroupAmounts,
} from "../../utils/delegationExact";
import {
	computeValueWeights,
	mergeEntitlements,
	usdToPico,
} from "./forwarderProceedsSplit";
import { splitAmountByWeights } from "../2_repartition/delegators";
import { getTokenPrices } from "../../utils/priceUtils";

// Strict ERC-20 decimals read: tokenService.getTokenDecimals silently
// defaults to 18 on lookup failure (and for legitimate 0-decimal tokens),
// which would misvalue an entitlement by powers of ten — fail instead.
const ERC20_DECIMALS_ABI = [
	{
		inputs: [],
		name: "decimals",
		outputs: [{ name: "", type: "uint8" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

async function getStrictDecimals(
	publicClient: PublicClient,
	token: string,
): Promise<number> {
	const decimals = await publicClient.readContract({
		address: token as `0x${string}`,
		abi: ERC20_DECIMALS_ABI,
		functionName: "decimals",
	});
	return Number(decimals);
}

// Number of seconds in one week
const WEEK = 604800;

// Round current UTC time down to the nearest week to get the current period timestamp
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

// Forwarders whose attributed value is below this USD amount are not paid
// individually; their value stays in the delegators pool.
const MIN_FORWARDER_PAYOUT_USD = 1;

const PRICE_PER_SHARE_ABI = [
	{
		inputs: [],
		name: "pricePerShare",
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

const VOTIUM_DIR = path.join(
	"weekly-bounties",
	currentPeriodTimestamp.toString(),
	"votium",
);
const VOTIUM_CLAIMS_FILE = path.join(
	VOTIUM_DIR,
	"claimed_bounties_convex.json",
);
const VOTIUM_FORWARDERS_FILE = path.join(
	VOTIUM_DIR,
	"forwarders_voted_rewards.json",
);

// The directory to which we'll write the bounties reports for this period
const reportsDir = path.join(
	"bounties-reports",
	currentPeriodTimestamp.toString(),
	"vlCVX",
);

// Applied Votium payouts (with the pricePerShare used) are recorded here so
// verifyForwardersMerkle can check exact per-address deltas after the fact.
const VOTIUM_PAYOUTS_ARTIFACT = path.join(
	reportsDir,
	"votium_forwarder_payouts.json",
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

let fxnDelegationData: any = null;
let fxnDelegationSummary: any = null;
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

/**
 * Main function to compute forwarder rewards, build a Merkle tree,
 * and run the distribution verifier.
 */
const emptyForwarderPayouts = (): ForwarderPayoutResult => ({
	capped: false,
	payouts: {},
	requestedTotal: 0n,
	totalPayout: 0n,
});

async function getVotiumForwarderPayouts(
	publicClient: PublicClient,
	maxTotal: bigint,
): Promise<ForwarderPayoutResult> {
	if (!fs.existsSync(VOTIUM_FORWARDERS_FILE)) {
		// generateConvexVotium deletes the attribution file before rewriting it.
		// If it crashed in between, real claims would silently fold into the
		// delegators pool — refuse instead.
		if (fs.existsSync(VOTIUM_CLAIMS_FILE)) {
			const claimedBounties: unknown = JSON.parse(
				fs.readFileSync(VOTIUM_CLAIMS_FILE, "utf8"),
			);
			if (hasClaimedVotiumBounties(claimedBounties)) {
				throw new Error(
					`Votium bounties were claimed this period but the forwarder ` +
						`attribution file is missing: ${VOTIUM_FORWARDERS_FILE}. ` +
						`Refusing to fold forwarder value into the delegators pool.`,
				);
			}
		}
		return emptyForwarderPayouts();
	}
	if (!fs.existsSync(VOTIUM_CLAIMS_FILE)) {
		throw new Error(
			`Votium forwarder attribution exists without claimed bounties: ` +
				`${VOTIUM_FORWARDERS_FILE}. Refusing to pay it from the shared pool.`,
		);
	}

	const forwardersData = JSON.parse(
		fs.readFileSync(VOTIUM_FORWARDERS_FILE, "utf8"),
	) as { tokenAllocations?: unknown };
	const tokenAllocations = forwardersData.tokenAllocations ?? {};
	if (
		typeof tokenAllocations === "object" &&
		!Array.isArray(tokenAllocations) &&
		Object.keys(tokenAllocations).length === 0
	) {
		return emptyForwarderPayouts();
	}

	const claimedBounties: unknown = JSON.parse(
		fs.readFileSync(VOTIUM_CLAIMS_FILE, "utf8"),
	);
	const pricePerShare = await publicClient.readContract({
		address: SCRVUSD as `0x${string}`,
		abi: PRICE_PER_SHARE_ABI,
		functionName: "pricePerShare",
	});

	const result = computeVotiumForwarderPayouts({
		claimedBounties,
		maxTotal,
		minimumPayoutUsd: MIN_FORWARDER_PAYOUT_USD,
		pricePerShare,
		tokenAllocations,
	});

	console.log(
		`sCRVUSD price per share: ${formatUnits(pricePerShare, 18)} crvUSD`,
	);
	console.log(
		`Votium forwarder payouts: ${Object.keys(result.payouts).length} address(es), ` +
			`${formatUnits(result.totalPayout, 18)} sCRVUSD`,
	);
	if (result.capped) {
		console.warn(
			`Votium forwarder payouts capped from ` +
				`${formatUnits(result.requestedTotal, 18)} to ` +
				`${formatUnits(result.totalPayout, 18)} sCRVUSD`,
		);
	}

	fs.mkdirSync(reportsDir, { recursive: true });
	fs.writeFileSync(
		VOTIUM_PAYOUTS_ARTIFACT,
		JSON.stringify(
			{
				period: currentPeriodTimestamp,
				pricePerShare: pricePerShare.toString(),
				minimumPayoutUsd: MIN_FORWARDER_PAYOUT_USD,
				capped: result.capped,
				requestedTotal: result.requestedTotal.toString(),
				totalPayout: result.totalPayout.toString(),
				payouts: Object.fromEntries(
					Object.entries(result.payouts).map(([address, amount]) => [
						address,
						amount.toString(),
					]),
				),
			},
			null,
			2,
		),
	);

	return result;
}

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

	// Invalidate the previous run's audit artifacts BEFORE recomputing: the
	// verifiers key on these files, so a FORCE_MERKLE re-run must not leave a
	// stale split breakdown (or stale Votium payouts) describing a merkle
	// that no longer exists. Both are rewritten by the steps that produce
	// them.
	fs.rmSync(path.join(reportsDir, "delegators_split_breakdown.json"), {
		force: true,
	});
	fs.rmSync(VOTIUM_PAYOUTS_ARTIFACT, { force: true });

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
	if (totalScrvUsd <= 0n) {
		throw new Error(
			`No distributable sCRVUSD remains after the rounding buffer: ${totalScrvUsd}`,
		);
	}
	console.log("Total sCRVUSD received:", totalScrvUsd.toString());

	// Pay Votium users their own forwarded voted rewards before splitting the
	// remaining shared pool among Stake DAO delegators.
	const forwarderPayouts = await getVotiumForwarderPayouts(
		publicClient,
		totalScrvUsd,
	);

	const availableForDistribution = totalScrvUsd - forwarderPayouts.totalPayout;
	if (availableForDistribution < 0n) {
		throw new Error(
			`Votium forwarder payouts ${forwarderPayouts.totalPayout} exceed ` +
				`the sCRVUSD received ${totalScrvUsd}`,
		);
	}
	console.log(
		"Total sCRVUSD for delegators distribution (after forwarders):",
		availableForDistribution.toString(),
	);

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

	// --- Split the pool among delegator-forwarders ---
	// The pool is split by each wallet's USD-VALUED exact entitlement
	// (Σ token amount × price, from the per-delegate attribution — a wallet
	// weighs only the tokens its own delegate earned). Real deposit txs batch
	// many tokens into ONE sCRVUSD mint, so receipt-level per-token proceeds
	// are not readable without fragile route tracing; value weighting keeps
	// the split exact per entitlement while socializing swap slippage across
	// the pool. Votium-leftover value (below-floor wallets, cap overflow) is
	// pooled by design and follows the same weights.
	for (const [label, summary] of [
		["curve", curveDelegationSummary],
		["fxn", fxnDelegationSummary],
	] as const) {
		if (summary && !hasPerDelegateAttribution(summary)) {
			throw new Error(
				`${label} delegation file has no perDelegate attribution ` +
					`(pre-cutover format?) — regenerate the repartition before ` +
					`building the delegators merkle`,
			);
		}
	}

	if (availableForDistribution > 0n) {
		const curveFwdExact = getExactGroupAmounts(
			curveDelegationSummary,
			"forwarders",
		);
		const fxnFwdExact = fxnDelegationSummary
			? getExactGroupAmounts(fxnDelegationSummary, "forwarders")
			: {};
		const entitlements = mergeEntitlements(curveFwdExact, fxnFwdExact);
		const vmTokens = new Set<string>();
		for (const tokens of Object.values(entitlements)) {
			for (const [token, amount] of Object.entries(tokens)) {
				if (amount > 0n) vmTokens.add(token);
			}
		}
		if (vmTokens.size === 0) {
			// Never observed: sCRVUSD arrived while no forwarder holds any
			// VotemarketV2 entitlement (pure Votium leftover). There is no
			// entitlement basis to split on — stop instead of inventing one.
			throw new Error(
				"sCRVUSD to distribute but no VotemarketV2 forwarder entitlement " +
					"this period — no basis to split the pool, aborting",
			);
		}

		// Prices (same source as the Votium USD attribution) + strict
		// on-chain decimals. computeValueWeights hard-fails on a missing
		// price/decimals: a zero-weighted token would silently move its
		// holders' money.
		const tokenList = [...vmTokens];
		const prices = await getTokenPrices(
			tokenList.map((address) => ({ chainId: 1, address })),
			"4h",
		);
		const pricePicoByToken: Record<string, bigint> = {};
		const priceUsdByToken: Record<string, number> = {};
		const decimalsByToken: Record<string, number> = {};
		for (const token of tokenList) {
			const usd = prices[`ethereum:${token}`] ?? 0;
			priceUsdByToken[token] = usd;
			pricePicoByToken[token] = usdToPico(usd, `price of ${token}`);
			decimalsByToken[token] = await getStrictDecimals(publicClient, token);
		}

		const valueWeights = computeValueWeights(
			entitlements,
			pricePicoByToken,
			decimalsByToken,
		);
		const totalValuePico = Object.values(valueWeights).reduce(
			(a, b) => a + b,
			0n,
		);
		const walletScrvUsd = splitAmountByWeights(
			availableForDistribution,
			valueWeights,
		);

		const perWalletBreakdown: Record<
			string,
			{ valuePico: string; total: string }
		> = {};
		const delegatorDistribution: {
			[address: string]: { tokens: { [token: string]: bigint } };
		} = {};
		for (const [wallet, amount] of Object.entries(walletScrvUsd)) {
			if (amount <= 0n) continue;
			const addr = getAddress(wallet);
			delegatorDistribution[addr] = { tokens: { [SCRVUSD]: amount } };
			perWalletBreakdown[addr] = {
				valuePico: (valueWeights[wallet] ?? 0n).toString(),
				total: amount.toString(),
			};
		}
		mergeDistributions(delegatorDistribution, combined);

		// Audit artifact: records the price vector used and lets
		// verifyForwardersMerkle / the inline verifier check exact
		// per-address deltas.
		const breakdownPath = path.join(
			reportsDir,
			"delegators_split_breakdown.json",
		);
		fs.mkdirSync(reportsDir, { recursive: true });
		fs.writeFileSync(
			breakdownPath,
			JSON.stringify(
				{
					period: currentPeriodTimestamp,
					mode: "value-weighted-exact-entitlements",
					availableForDistribution: availableForDistribution.toString(),
					totalValuePico: totalValuePico.toString(),
					pricesUsd: priceUsdByToken,
					decimals: decimalsByToken,
					perWallet: perWalletBreakdown,
				},
				null,
				2,
			),
		);
		console.log(
			`${Object.keys(perWalletBreakdown).length} forwarder(s) paid by ` +
				`value-weighted exact entitlements ` +
				`(${(Number(totalValuePico) / 1e12).toFixed(2)} USD of VM value); ` +
				`breakdown saved to ${breakdownPath}`,
		);
	} else {
		console.log(
			"No sCRVUSD left for the delegator split after the Votium payouts.",
		);
	}

	// Pay each direct-voter forwarder individually (replaces the old aggregate
	// governance claim). Keys on both sides are EIP-55 checksummed, so a mixed
	// address — delegation forwarder on one platform, direct voter on the
	// other — is summed into a single entry here. generateMerkleTree overwrites
	// amounts on key collisions, so collisions must not survive past this merge.
	const forwarderDistribution = Object.fromEntries(
		Object.entries(forwarderPayouts.payouts).map(([address, amount]) => [
			address,
			{ tokens: { [SCRVUSD]: amount } },
		]),
	);
	mergeDistributions(forwarderDistribution, combined);

	if (forwarderPayouts.totalPayout > 0n) {
		console.log(
			`\nAdded ${Object.keys(forwarderPayouts.payouts).length} Votium forwarder payout(s): ` +
				`${formatUnits(forwarderPayouts.totalPayout, 18)} sCRVUSD`,
		);
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
