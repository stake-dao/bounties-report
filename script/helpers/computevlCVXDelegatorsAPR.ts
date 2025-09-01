import {
	createPublicClient,
	http,
	keccak256,
	encodePacked,
	pad,
	decodeAbiParameters,
	getAddress,
	erc20Abi,
} from "viem";
import { mainnet, base, arbitrum } from "viem/chains";
import * as moment from "moment";
import {
	getProposal,
	getVoters,
	associateGaugesPerId,
	fetchLastProposalsIds,
	getVotingPower,
} from "../utils/snapshot";
import { getAllCurveGauges } from "../utils/curveApi";
import {
	DELEGATION_ADDRESS,
	CVX_SPACE,
	WEEK,
	VLCVX_DELEGATORS_MERKLE,
	CRVUSD,
	CVX,
} from "../utils/constants";
import { extractCSV } from "../utils/utils";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { ALL_MIGHT, REWARDS_ALLOCATIONS_POOL } from "../utils/reportUtils";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { processAllDelegators } from "../utils/cacheUtils";
import { getAllRewardsForDelegators } from "./utils";

import { getCRVUsdTransfer } from "../vlCVX/utils";
import {
	getHistoricalTokenPrices,
	TokenIdentifier,
	LLAMA_NETWORK_MAPPING,
} from "../utils/priceUtils";
const REWARD_TOKENS = [CRVUSD];

interface USDPerCVXResult {
	totalVotingPower: number;
	delegationVotingPower: number;
	delegationShare: number;
	rewardValueUSD: number; // Total USD value of rewards
	usdPerCVX: number; // USD value per CVX (weekly)
	periodStartBlock: number;
	periodEndBlock: number;
	timestamp: number;
}

interface TokenPrice {
	address: string;
	price: number;
	decimals: number;
	chainId: number;
}

type CvxCSVType = Record<
	string,
	{ rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

interface ChainDelegationData {
	totalTokens: Record<string, string>;
	totalPerGroup: Record<
		string,
		{
			forwarders: string;
			nonForwarders: string;
		}
	>;
}

const publicClient = createPublicClient({
	chain: mainnet,
	transport: http("https://rpc.flashbots.net"),
});

const skippedUsers = new Set([
	getAddress("0xe001452BeC9e7AC34CA4ecaC56e7e95eD9C9aa3b"), // Bent
]);

// Chain configurations
const CHAIN_CONFIGS = {
	1: { chain: mainnet, name: "ethereum" },
	8453: { chain: base, name: "base" },
	42161: { chain: arbitrum, name: "arbitrum" },
};

async function getTokenDecimals(
	tokens: { chainId: number; address: string }[],
): Promise<Record<string, number>> {
	const decimalsMap: Record<string, number> = {};

	// Group tokens by chain
	const tokensByChain: Record<number, string[]> = {};
	for (const token of tokens) {
		if (!tokensByChain[token.chainId]) {
			tokensByChain[token.chainId] = [];
		}
		tokensByChain[token.chainId].push(token.address);
	}

	// Fetch decimals for each chain
	for (const [chainId, addresses] of Object.entries(tokensByChain)) {
		const chainConfig = CHAIN_CONFIGS[Number(chainId)];
		if (!chainConfig) {
			console.warn(`Unsupported chain ID: ${chainId}`);
			continue;
		}

		const client = createPublicClient({
			chain: chainConfig.chain,
			transport: http(),
		});

		// Prepare multicall
		const calls = addresses.map((address) => ({
			address: address as `0x${string}`,
			abi: erc20Abi,
			functionName: "decimals" as const,
		}));

		try {
			const results = await client.multicall({ contracts: calls });

			results.forEach((result, index) => {
				const address = addresses[index];
				if (result.status === "success") {
					decimalsMap[address] = Number(result.result);
				} else {
					console.warn(
						`Failed to fetch decimals for ${address} on chain ${chainId}, defaulting to 18`,
					);
					decimalsMap[address] = 18;
				}
			});
		} catch (error) {
			console.error(`Error fetching decimals for chain ${chainId}:`, error);
			// Default all tokens on this chain to 18 decimals
			addresses.forEach((address) => {
				decimalsMap[address] = 18;
			});
		}
	}

	return decimalsMap;
}

async function computeUSDPerCVX(): Promise<USDPerCVXResult> {
	const now = moment.utc().unix();
	const currentPeriodTimestamp = Math.floor(now / WEEK) * WEEK;

	// Get CVX report to identify relevant gauges
	console.log("Extracting CSV report...");
	const csvResult = (await extractCSV(
		currentPeriodTimestamp,
		CVX_SPACE,
	)) as CvxCSVType;
	if (!csvResult) throw new Error("No CSV report found");

	// Get relevant gauges from CSV
	const gauges = Object.keys(csvResult);
	console.log(`Found ${gauges.length} gauges in report`);

	// Fetch last proposal
	console.log("Fetching latest proposal...");
	const filter: string = "^(?!FXN ).*Gauge Weight for Week of";
	const proposalIdPerSpace = await fetchLastProposalsIds(
		[CVX_SPACE],
		now,
		filter,
	);
	const proposalId = proposalIdPerSpace[CVX_SPACE];
	console.log("Using proposal:", proposalId);

	// Fetch proposal data and votes
	const proposal = await getProposal(proposalId);
	const votes = await getVoters(proposalId);
	const curveGauges = await getAllCurveGauges();
	const gaugePerChoiceId = associateGaugesPerId(proposal, curveGauges);

	let totalVotingPower = 0;
	let delegationVotingPower = 0;

	// Process votes for each gauge
	for (const gauge of gauges) {
		const gaugeInfo = gaugePerChoiceId[gauge.toLowerCase()];
		if (!gaugeInfo) {
			console.warn(`Warning: No gauge info found for ${gauge}`);
			continue;
		}

		const votesForGauge = votes.filter(
			(vote) => vote.choice[gaugeInfo.choiceId] !== undefined,
		);

		for (const vote of votesForGauge) {
			let vpChoiceSum = 0;
			let currentChoiceIndex = 0;

			for (const [choiceIndex, value] of Object.entries(vote.choice)) {
				if (gaugeInfo.choiceId === parseInt(choiceIndex)) {
					currentChoiceIndex = value;
				}
				vpChoiceSum += value;
			}

			if (currentChoiceIndex > 0) {
				const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
				const effectiveVp = (vote.vp * ratio) / 100;

				totalVotingPower += effectiveVp;
				if (vote.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
					delegationVotingPower += effectiveVp;
				}
			}
		}
	}

	// Get delegators and their voting powers
	console.log("Fetching delegator data...");
	const delegators = await processAllDelegators(
		CVX_SPACE,
		proposal.created,
		DELEGATION_ADDRESS,
	);
	const delegatorVotingPowers = await getVotingPower(proposal, delegators);

	// Get Thursday rewards (from getAllRewardsForDelegators)
	const thursdayRewards = getAllRewardsForDelegators(currentPeriodTimestamp);
	console.log("Thursday rewards:", thursdayRewards.chainRewards);

	// Get ALL CRVUSD transfers to delegators merkle during the period
	const currentBlock = Number(await publicClient.getBlockNumber());
	const minBlock = await getClosestBlockTimestamp(
		"ethereum",
		currentPeriodTimestamp,
	);

	// Use the same method as createDelegatorsMerkle.ts
	const crvUsdTransfer = await getCRVUsdTransfer(minBlock, currentBlock);
	console.log(
		"Total CRVUSD transferred to delegators merkle:",
		crvUsdTransfer.amount.toString(),
	);

	// Calculate total delegator rewards by combining Thursday rewards and CRVUSD transfers
	const totalDelegatorsRewards = { ...thursdayRewards };

	// Add CRVUSD transfers to forwarders on Ethereum chain
	if (crvUsdTransfer.amount > 0n) {
		if (!totalDelegatorsRewards.chainRewards[1]) {
			totalDelegatorsRewards.chainRewards[1] = {
				rewards: {},
				rewardsPerGroup: { forwarders: {}, nonForwarders: {} },
			};
		}
		// All CRVUSD sent to delegators merkle goes to forwarders
		totalDelegatorsRewards.chainRewards[1].rewardsPerGroup.forwarders[CRVUSD] =
			(totalDelegatorsRewards.chainRewards[1].rewardsPerGroup.forwarders[
				CRVUSD
			] || 0n) + crvUsdTransfer.amount;
	}

	console.log("Total delegators rewards (Ethereum):", {
		forwarders:
			totalDelegatorsRewards.chainRewards[1]?.rewardsPerGroup.forwarders,
		nonForwarders:
			totalDelegatorsRewards.chainRewards[1]?.rewardsPerGroup.nonForwarders,
	});

	// Create a Set of forwarder addresses for efficient lookup
	const forwardersSet = new Set(
		thursdayRewards.forwarders.map((addr) => addr.toLowerCase()),
	);

	// Calculate delegationVPForwarders by only including voting power from forwarders
	let delegationVPForwarders = 0;
	for (const [address, votingPower] of Object.entries(delegatorVotingPowers)) {
		if (forwardersSet.has(address.toLowerCase())) {
			delegationVPForwarders += votingPower;
			console.log(
				`Including forwarder ${address} with VP: ${votingPower.toFixed(2)}`,
			);
		}
	}

	console.log(`Total forwarders VP: ${delegationVPForwarders.toFixed(2)}`);

	// Prepare token identifiers for price fetching
	const thursdayTokens: TokenIdentifier[] = [];
	const crvusdTokens: TokenIdentifier[] = [];
	const seenTokens = new Set<string>();

	// Collect tokens for price fetching
	for (const [chainId, chainData] of Object.entries(
		totalDelegatorsRewards.chainRewards,
	)) {
		// All non-forwarder tokens need Thursday prices
		Object.keys(chainData.rewardsPerGroup.nonForwarders || {}).forEach(
			(address) => {
				const key = `${chainId}:${address.toLowerCase()}`;
				if (!seenTokens.has(key)) {
					seenTokens.add(key);
					thursdayTokens.push({
						chainId: Number(chainId),
						address: getAddress(address),
					});
				}
			},
		);

		// Only CRVUSD from forwarders needs pricing (current price)
		if (chainData.rewardsPerGroup.forwarders?.[CRVUSD]) {
			crvusdTokens.push({
				chainId: Number(chainId),
				address: getAddress(CRVUSD),
			});
		}
	}

	// Fetch prices at different timestamps
	// Most tokens use Thursday prices (currentPeriodTimestamp)
	const thursdayPrices = await getHistoricalTokenPrices(
		thursdayTokens,
		currentPeriodTimestamp,
	);

	// CRVUSD: use current prices
	const currentTimestamp = Math.floor(Date.now() / 1000);
	const crvusdPrices = await getHistoricalTokenPrices(
		crvusdTokens,
		currentTimestamp,
	);

	// Merge all prices
	const prices = { ...thursdayPrices, ...crvusdPrices };
	console.log("Thursday prices:", thursdayPrices);
	console.log("Current prices for CRVUSD:", crvusdPrices);

	// Collect all unique tokens that need decimals
	const tokensNeedingDecimals: { chainId: number; address: string }[] = [];
	const seenTokensForDecimals = new Set<string>();

	for (const [chainId, chainData] of Object.entries(
		totalDelegatorsRewards.chainRewards,
	)) {
		const allTokens = [
			...Object.keys(chainData.rewardsPerGroup.nonForwarders || {}),
			...Object.keys(chainData.rewardsPerGroup.forwarders || {}),
		];

		allTokens.forEach((address) => {
			const key = `${chainId}:${address.toLowerCase()}`;
			if (!seenTokensForDecimals.has(key)) {
				seenTokensForDecimals.add(key);
				tokensNeedingDecimals.push({
					chainId: Number(chainId),
					address: getAddress(address),
				});
			}
		});
	}

	// Fetch decimals for all tokens
	console.log("Fetching token decimals...");
	const tokenDecimals = await getTokenDecimals(tokensNeedingDecimals);

	// Calculate USD value for each reward token
	let rewardValueUSD = 0;

	// Process non-forwarder rewards with Thursday prices
	for (const [chainId, chainData] of Object.entries(
		totalDelegatorsRewards.chainRewards,
	)) {
		const nonForwarderRewards = chainData.rewardsPerGroup.nonForwarders || {};

		for (const [tokenAddress, amount] of Object.entries(nonForwarderRewards)) {
			const normalizedAddress = getAddress(tokenAddress);
			const priceKey = `${LLAMA_NETWORK_MAPPING[Number(chainId)]}:${normalizedAddress.toLowerCase()}`;
			const tokenPriceUSD = prices[priceKey];

			if (tokenPriceUSD && amount > 0n) {
				// Get decimals from fetched data
				const decimals = tokenDecimals[normalizedAddress] || 18;
				const amountInUnits = Number(amount) / Math.pow(10, decimals);
				const valueUSD = amountInUnits * tokenPriceUSD;

				rewardValueUSD += valueUSD;

				console.log(
					`Token ${normalizedAddress} on chain ${chainId} (nonForwarders):`,
				);
				console.log(`  Amount: ${amountInUnits.toFixed(6)}`);
				console.log(`  Price: $${tokenPriceUSD.toFixed(4)}`);
				console.log(`  Value: $${valueUSD.toFixed(2)}`);
			} else if (amount > 0n) {
				console.warn(
					`No price found for token ${normalizedAddress} on chain ${chainId}`,
				);
			}
		}
	}

	// Process ONLY CRVUSD from forwarders (other tokens are swapped to CRVUSD)
	for (const [chainId, chainData] of Object.entries(
		totalDelegatorsRewards.chainRewards,
	)) {
		const forwarderRewards = chainData.rewardsPerGroup.forwarders || {};

		// Only process CRVUSD for forwarders
		const crvusdAmount = forwarderRewards[CRVUSD] || 0n;
		if (crvusdAmount > 0n) {
			const normalizedAddress = getAddress(CRVUSD);
			const priceKey = `${LLAMA_NETWORK_MAPPING[Number(chainId)]}:${normalizedAddress.toLowerCase()}`;
			const tokenPriceUSD = prices[priceKey];

			if (tokenPriceUSD) {
				const decimals = tokenDecimals[normalizedAddress] || 18;
				const amountInUnits = Number(crvusdAmount) / Math.pow(10, decimals);
				const valueUSD = amountInUnits * tokenPriceUSD;

				rewardValueUSD += valueUSD;

				console.log(`CRVUSD on chain ${chainId} (forwarders):`);
				console.log(`  Amount: ${amountInUnits.toFixed(6)}`);
				console.log(`  Price: $${tokenPriceUSD.toFixed(4)} (current)`);
				console.log(`  Value: $${valueUSD.toFixed(2)}`);
			}
		}
	}

	// Calculate USD per CVX (weekly rewards)
	const usdPerCVX = rewardValueUSD / delegationVPForwarders;

	console.log("Total rewardValueUSD:", rewardValueUSD);
	console.log("USD per CVX (weekly):", usdPerCVX.toFixed(4));

	return {
		totalVotingPower,
		delegationVotingPower,
		delegationShare: delegationVotingPower / totalVotingPower,
		rewardValueUSD,
		usdPerCVX,
		periodStartBlock: Number(proposal.snapshot),
		periodEndBlock: Number(proposal.end),
		timestamp: currentPeriodTimestamp,
	};
}

async function main() {
	try {
		const result = await computeUSDPerCVX();
		// Save to current week folder first
		const currentWeekPath = join(
			__dirname,
			`../../bounties-reports/${result.timestamp}/vlCVX/APRs.json`,
		);

		// Create updated data structure with USD per CVX
		const updatedData = {
			rewardValueUSD: result.rewardValueUSD,
			usdPerCVX: result.usdPerCVX,
			totalVotingPower: result.totalVotingPower,
			delegationVotingPower: result.delegationVotingPower,
			delegationShare: result.delegationShare,
			timestamp: result.timestamp,
			periodStartBlock: result.periodStartBlock,
			periodEndBlock: result.periodEndBlock,
		};

		writeFileSync(currentWeekPath, JSON.stringify(updatedData, null, 2));

		console.log("\n=== Delegation USD per CVX Calculation ===");
		console.log(`Period Timestamp: ${result.timestamp}`);
		console.log(`Total Voting Power: ${result.totalVotingPower.toFixed(2)}`);
		console.log(
			`Delegation Voting Power: ${result.delegationVotingPower.toFixed(2)}`,
		);
		console.log(
			`Delegation Share: ${(result.delegationShare * 100).toFixed(2)}%`,
		);
		console.log(
			`Period: ${result.periodStartBlock} - ${result.periodEndBlock}`,
		);
		console.log(`Total Reward Value: $${result.rewardValueUSD.toFixed(2)}`);
		console.log(`USD per CVX (weekly): $${result.usdPerCVX.toFixed(4)}`);
		console.log(`Data saved to: ${currentWeekPath}`);
	} catch (error) {
		console.error("Error:", error);
		process.exit(1);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("Error:", error);
		process.exit(1);
	});
}

export { computeUSDPerCVX };
