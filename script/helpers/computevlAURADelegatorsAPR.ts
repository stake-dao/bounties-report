import {
	createPublicClient,
	http,
	getAddress,
	erc20Abi,
} from "viem";
import { mainnet, base, arbitrum, optimism, polygon } from "../utils/chains";
import * as moment from "moment";
import {
	getProposal,
	getVoters,
	associateAuraGaugesPerId,
	fetchLastProposalsIds,
	getVotingPower,
	fetchAuraGaugeChoices,
} from "../utils/snapshot";
import {
	DELEGATION_ADDRESS,
	VLAURA_SPACE,
	WEEK,
} from "../utils/constants";

// SDT token address (excluded from main APR, calculated separately)
const SDT_ADDRESS = "0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f";
import { extractCSV } from "../utils/utils";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { processAllDelegators } from "../utils/cacheUtils";
import {
	getHistoricalTokenPrices,
	getTokenPrices,
	TokenIdentifier,
	LLAMA_NETWORK_MAPPING,
} from "../utils/priceUtils";

interface USDPerAURAResult {
	totalVotingPower: number;
	delegationVotingPower: number;
	delegationShare: number;
	rewardValueUSD: number;
	usdPerAURA: number;
	timestamp: number;
	tokens: Record<string, {
		symbol?: string;
		amount: string;
		valueUSD: number;
		chainId: number;
	}>;
	sdtUsdPerAURA: number;
	sdtAmount: string;
}

type VlAuraCSVType = Record<
	string,
	{ rewardAddress: string; rewardAmount: bigint; chainId?: number }[]
>;

// Chain configurations
const CHAIN_CONFIGS: Record<number, { chain: any; name: string; rpcUrl: string }> = {
	1: { chain: mainnet, name: "ethereum", rpcUrl: process.env.WEB3_ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}` : "https://ethereum-rpc.publicnode.com" },
	8453: { chain: base, name: "base", rpcUrl: "https://base.publicnode.com" },
	42161: { chain: arbitrum, name: "arbitrum", rpcUrl: "https://arbitrum-one.publicnode.com" },
	10: { chain: optimism, name: "optimism", rpcUrl: "https://optimism.publicnode.com" },
	137: { chain: polygon, name: "polygon", rpcUrl: "https://polygon-bor.publicnode.com" },
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
			transport: http(chainConfig.rpcUrl),
		});

		// Prepare multicall
		const calls = addresses.map((address) => ({
			address: address as `0x${string}`,
			abi: erc20Abi,
			functionName: "decimals" as const,
		}));

		try {
			const results = await (client as any).multicall({ contracts: calls });
			results.forEach((result: any, index: number) => {
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

/**
 * Read delegation rewards from repartition files
 * Returns total tokens for the delegation and chain mapping
 */
function readDelegationRewards(timestamp: number): {
	totalTokens: Record<string, bigint>;
	tokenChainIds: Record<string, number>;
} | null {
	const dirPath = join(
		process.cwd(),
		"bounties-reports",
		timestamp.toString(),
		"vlAURA"
	);

	const totalTokens: Record<string, bigint> = {};
	const tokenChainIds: Record<string, number> = {};

	// Supported chain IDs
	const chainIds = [1, 42161, 10, 8453, 137];

	for (const chainId of chainIds) {
		const suffix = chainId === 1 ? "" : `_${chainId}`;
		const delegationFile = join(dirPath, `repartition_delegation${suffix}.json`);
		const repartitionFile = join(dirPath, `repartition${suffix}.json`);

		// Try delegation file first
		if (existsSync(delegationFile)) {
			const data = JSON.parse(readFileSync(delegationFile, "utf8"));
			const { totalTokens: chainTotalTokens } = data.distribution || {};

			if (chainTotalTokens) {
				for (const [token, amount] of Object.entries(chainTotalTokens)) {
					const normalizedToken = token.toLowerCase();
					totalTokens[normalizedToken] = (totalTokens[normalizedToken] || 0n) + BigInt(amount as string);
					tokenChainIds[normalizedToken] = chainId;
				}
				console.log(`Loaded delegation rewards from chain ${chainId}`);
			}
		}
		// Fallback: check repartition file for DELEGATION_ADDRESS
		else if (existsSync(repartitionFile)) {
			const data = JSON.parse(readFileSync(repartitionFile, "utf8"));
			const distribution = data.distribution || {};

			// Look for delegation address entry
			for (const [address, addrData] of Object.entries(distribution)) {
				if (address.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()) {
					const tokens = (addrData as any).tokens || {};
					for (const [token, amount] of Object.entries(tokens)) {
						const normalizedToken = token.toLowerCase();
						totalTokens[normalizedToken] = (totalTokens[normalizedToken] || 0n) + BigInt(amount as string);
						tokenChainIds[normalizedToken] = chainId;
					}
					console.log(`Found delegation in repartition for chain ${chainId}`);
					break;
				}
			}
		}
	}

	if (Object.keys(totalTokens).length === 0) {
		return null;
	}

	return { totalTokens, tokenChainIds };
}

async function computeVlAURADelegatorsAPR(overrideTimestamp?: number): Promise<USDPerAURAResult> {
	const now = moment.utc().unix();
	const currentPeriodTimestamp = overrideTimestamp || Math.floor(now / WEEK) * WEEK;

	console.log(`Computing vlAURA APR for period ${currentPeriodTimestamp}`);

	// Get vlAURA report to identify relevant gauges
	console.log("Extracting CSV report...");
	const csvResult = (await extractCSV(
		currentPeriodTimestamp,
		VLAURA_SPACE,
	)) as VlAuraCSVType;
	if (!csvResult) throw new Error("No CSV report found");

	// Get relevant gauges from CSV
	const gauges = Object.keys(csvResult);
	console.log(`Found ${gauges.length} gauges in report`);

	// Fetch last proposal
	console.log("Fetching latest proposal...");
	const filter = "Gauge Weight for Week of";
	const proposalIdPerSpace = await fetchLastProposalsIds(
		[VLAURA_SPACE],
		now,
		filter,
	);
	const proposalId = proposalIdPerSpace[VLAURA_SPACE];
	if (!proposalId) throw new Error("No vlAURA proposal found");
	console.log("Using proposal:", proposalId);

	// Fetch proposal data and votes
	const proposal = await getProposal(proposalId);
	const votes = await getVoters(proposalId);

	// Fetch Aura gauge choices mapping
	console.log("Fetching Aura gauge choices mapping...");
	const auraGaugeChoices = await fetchAuraGaugeChoices();
	const gaugePerChoiceId = associateAuraGaugesPerId(proposal, gauges, auraGaugeChoices);

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
					currentChoiceIndex = value as number;
				}
				vpChoiceSum += value as number;
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

	console.log(`Total voting power: ${totalVotingPower.toFixed(2)}`);
	console.log(`Delegation voting power: ${delegationVotingPower.toFixed(2)}`);

	// If no delegation VP from votes, try to get from delegators directly
	if (delegationVotingPower === 0) {
		console.log("No delegation VP from votes, trying to fetch delegator data...");
		try {
			const delegators = await processAllDelegators(
				VLAURA_SPACE,
				proposal.created,
				DELEGATION_ADDRESS,
			);
			if (delegators.length > 0) {
				const delegatorVotingPowers = await getVotingPower(proposal, delegators);
				delegationVotingPower = Object.values(delegatorVotingPowers).reduce((acc, vp) => acc + vp, 0);
				console.log(`Delegation VP from delegators: ${delegationVotingPower.toFixed(2)}`);
			}
		} catch (error) {
			console.warn("Failed to fetch delegator voting powers:", (error as Error).message);
		}
	}

	// Read delegation rewards from repartition files
	console.log("Reading delegation rewards...");
	const delegationRewards = readDelegationRewards(currentPeriodTimestamp);

	if (!delegationRewards) {
		console.warn("No delegation rewards found, returning zero APR");
		return {
			totalVotingPower,
			delegationVotingPower,
			delegationShare: delegationVotingPower / (totalVotingPower || 1),
			rewardValueUSD: 0,
			usdPerAURA: 0,
			timestamp: currentPeriodTimestamp,
			tokens: {},
			sdtUsdPerAURA: 0,
			sdtAmount: "0",
		};
	}

	const { totalTokens, tokenChainIds } = delegationRewards;

	// Prepare token identifiers for price fetching
	const tokenIdentifiers: TokenIdentifier[] = [];
	const seenTokens = new Set<string>();

	for (const [token, amount] of Object.entries(totalTokens)) {
		if (amount === 0n) continue;
		const chainId = tokenChainIds[token] || 1;
		const key = `${chainId}:${token}`;
		if (!seenTokens.has(key)) {
			seenTokens.add(key);
			tokenIdentifiers.push({
				chainId,
				address: getAddress(token),
			});
		}
	}

	// Fetch token decimals
	console.log("Fetching token decimals...");
	const tokensNeedingDecimals = tokenIdentifiers.map(t => ({
		chainId: t.chainId,
		address: t.address,
	}));
	const tokenDecimals = await getTokenDecimals(tokensNeedingDecimals);

	// Fetch prices
	console.log("Fetching token prices...");
	let prices: Record<string, number> = {};
	try {
		// Try historical prices first
		const currentTimestamp = Math.floor(Date.now() / 1000);
		prices = await getHistoricalTokenPrices(tokenIdentifiers, currentTimestamp);
	} catch (error) {
		console.warn("Historical prices failed, trying current prices...");
		prices = await getTokenPrices(tokenIdentifiers);
	}
	console.log("Prices:", prices);

	// Calculate USD value
	let rewardValueUSD = 0;
	let sdtValueUSD = 0;
	let sdtAmount = 0n;
	const tokensData: Record<string, { symbol?: string; amount: string; valueUSD: number; chainId: number }> = {};

	for (const [token, amount] of Object.entries(totalTokens)) {
		if (amount === 0n) continue;

		const chainId = tokenChainIds[token] || 1;
		const normalizedAddress = getAddress(token);
		const llamaNetwork = LLAMA_NETWORK_MAPPING[chainId];
		const isSDT = token.toLowerCase() === SDT_ADDRESS.toLowerCase();

		if (!llamaNetwork) {
			console.warn(`No Llama network mapping for chain ${chainId}`);
			continue;
		}

		const priceKey = `${llamaNetwork}:${normalizedAddress.toLowerCase()}`;
		const tokenPriceUSD = prices[priceKey];

		if (tokenPriceUSD) {
			const decimals = tokenDecimals[normalizedAddress] || 18;
			const amountInUnits = Number(amount) / Math.pow(10, decimals);
			const valueUSD = amountInUnits * tokenPriceUSD;

			// SDT is tracked separately, not included in main rewardValueUSD
			if (isSDT) {
				sdtValueUSD = valueUSD;
				sdtAmount = amount;
				console.log(`SDT Token (excluded from main APR):`);
			} else {
				rewardValueUSD += valueUSD;
				tokensData[normalizedAddress] = {
					amount: amount.toString(),
					valueUSD,
					chainId,
				};
				console.log(`Token ${normalizedAddress} on chain ${chainId}:`);
			}
			console.log(`  Amount: ${amountInUnits.toFixed(6)}`);
			console.log(`  Price: $${tokenPriceUSD.toFixed(4)}`);
			console.log(`  Value: $${valueUSD.toFixed(2)}`);
		} else {
			console.warn(`No price found for ${normalizedAddress} on chain ${chainId}`);
			if (!isSDT) {
				tokensData[normalizedAddress] = {
					amount: amount.toString(),
					valueUSD: 0,
					chainId,
				};
			} else {
				sdtAmount = amount;
			}
		}
	}

	// Calculate USD per AURA (weekly) - excluding SDT
	const usdPerAURA = delegationVotingPower > 0 ? rewardValueUSD / delegationVotingPower : 0;
	const delegationShare = totalVotingPower > 0 ? delegationVotingPower / totalVotingPower : 0;

	// Calculate SDT APR separately
	const sdtUsdPerAURA = delegationVotingPower > 0 ? sdtValueUSD / delegationVotingPower : 0;

	console.log("\n=== vlAURA APR Calculation Results ===");
	console.log(`Total Reward Value USD (excl. SDT): $${rewardValueUSD.toFixed(2)}`);
	console.log(`SDT Value USD: $${sdtValueUSD.toFixed(2)}`);
	console.log(`Delegation VP: ${delegationVotingPower.toFixed(2)}`);
	console.log(`USD per AURA (weekly, excl. SDT): $${usdPerAURA.toFixed(6)}`);
	console.log(`SDT USD per AURA (weekly): $${sdtUsdPerAURA.toFixed(6)}`);

	return {
		totalVotingPower,
		delegationVotingPower,
		delegationShare,
		rewardValueUSD,
		usdPerAURA,
		timestamp: currentPeriodTimestamp,
		tokens: tokensData,
		sdtUsdPerAURA,
		sdtAmount: sdtAmount.toString(),
	};
}

async function main() {
	try {
		// Allow passing timestamp as command line argument
		const args = process.argv.slice(2);
		const overrideTimestamp = args[0] ? parseInt(args[0]) : undefined;

		const result = await computeVlAURADelegatorsAPR(overrideTimestamp);

		// Save to current week folder
		const outputDir = join(
			process.cwd(),
			"bounties-reports",
			result.timestamp.toString(),
			"vlAURA"
		);

		// Ensure directory exists
		const fs = await import("fs");
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		const outputPath = join(outputDir, "APRs.json");

		// Create output data
		const outputData = {
			rewardValueUSD: result.rewardValueUSD,
			usdPerAURA: result.usdPerAURA,
			totalVotingPower: result.totalVotingPower,
			delegationVotingPower: result.delegationVotingPower,
			delegationShare: result.delegationShare,
			timestamp: result.timestamp,
			tokens: result.tokens,
			sdtUsdPerAURA: result.sdtUsdPerAURA,
			sdtAmount: result.sdtAmount,
		};

		writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

		console.log("\n=== vlAURA Delegators APR Calculation ===");
		console.log(`Period Timestamp: ${result.timestamp}`);
		console.log(`Total Voting Power: ${result.totalVotingPower.toFixed(2)}`);
		console.log(`Delegation Voting Power: ${result.delegationVotingPower.toFixed(2)}`);
		console.log(`Delegation Share: ${(result.delegationShare * 100).toFixed(2)}%`);
		console.log(`Total Reward Value (excl. SDT): $${result.rewardValueUSD.toFixed(2)}`);
		console.log(`USD per AURA (weekly, excl. SDT): $${result.usdPerAURA.toFixed(6)}`);
		console.log(`SDT Amount: ${result.sdtAmount}`);
		console.log(`SDT USD per AURA (weekly): $${result.sdtUsdPerAURA.toFixed(6)}`);
		console.log(`Data saved to: ${outputPath}`);
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

export { computeVlAURADelegatorsAPR };
