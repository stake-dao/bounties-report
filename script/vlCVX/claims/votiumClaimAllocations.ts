import { formatUnits, getAddress } from "viem";

const USD_MICRO_SCALE = 1_000_000;

export type VotiumTokenAllocation = {
	amount: string;
	usd: number;
};

type ReconcileVotiumClaimAllocationsParams = {
	claimedTokenAmounts: Record<string, bigint>;
	originalTokenAllocations: Record<
		string,
		Record<string, VotiumTokenAllocation>
	>;
	tokenDecimals: Record<string, number>;
	tokenPrices: Record<string, number>;
};

export type ReconciledVotiumClaimAllocations = {
	perAddressTokenAllocations: Record<string, Record<string, bigint>>;
	tokenAllocations: Record<
		string,
		Record<string, VotiumTokenAllocation>
	>;
};

export const normalizeVotiumTokenAddress = (token: string): string =>
	getAddress(token).toLowerCase();

const usdToMicros = (usd: number, label: string): bigint => {
	if (!Number.isFinite(usd) || usd < 0) {
		throw new Error(`${label} must be a non-negative finite number`);
	}

	const micros = Math.floor(usd * USD_MICRO_SCALE);
	if (!Number.isSafeInteger(micros)) {
		throw new Error(`${label} is too large to convert safely`);
	}
	return BigInt(micros);
};

const normalizeBigintRecord = (
	values: Record<string, bigint>,
	label: string,
): Record<string, bigint> => {
	const normalized: Record<string, bigint> = {};
	for (const [rawToken, value] of Object.entries(values)) {
		if (value < 0n) throw new Error(`${label}.${rawToken} cannot be negative`);
		const token = normalizeVotiumTokenAddress(rawToken);
		normalized[token] = (normalized[token] ?? 0n) + value;
	}
	return normalized;
};

const normalizeNumberRecord = (
	values: Record<string, number>,
): Record<string, number> =>
	Object.fromEntries(
		Object.entries(values).map(([token, value]) => [
			normalizeVotiumTokenAddress(token),
			value,
		]),
	);

/**
 * Reconcile the forwarders' theoretical USD shares against the tokens that
 * were actually claimed by the aggregate Votium forwarder.
 *
 * Every attributable token is capped by its realized claim. Its final token
 * amount is split by the original USD weights using bigint arithmetic, then
 * valued again from that final amount. Unclaimed tokens and claim amounts
 * that are not attributable to a forwarder remain in the delegators pool.
 */
export const reconcileVotiumClaimAllocations = ({
	claimedTokenAmounts,
	originalTokenAllocations,
	tokenDecimals,
	tokenPrices,
}: ReconcileVotiumClaimAllocationsParams): ReconciledVotiumClaimAllocations => {
	const claimedByToken = normalizeBigintRecord(
		claimedTokenAmounts,
		"claimedTokenAmounts",
	);
	const decimalsByToken = normalizeNumberRecord(tokenDecimals);
	const pricesByToken = normalizeNumberRecord(tokenPrices);
	const weightsByToken: Record<string, Record<string, bigint>> = {};

	for (const [rawAddress, allocations] of Object.entries(
		originalTokenAllocations,
	)) {
		const address = getAddress(rawAddress).toLowerCase();
		for (const [rawToken, allocation] of Object.entries(allocations)) {
			const token = normalizeVotiumTokenAddress(rawToken);
			const weight = usdToMicros(
				allocation.usd,
				`originalTokenAllocations.${rawAddress}.${rawToken}.usd`,
			);
			if (weight === 0n) continue;
			weightsByToken[token] ??= {};
			weightsByToken[token][address] =
				(weightsByToken[token][address] ?? 0n) + weight;
		}
	}

	const result: ReconciledVotiumClaimAllocations = {
		perAddressTokenAllocations: {},
		tokenAllocations: {},
	};

	for (const token of Object.keys(weightsByToken).sort()) {
		const claimed = claimedByToken[token] ?? 0n;
		if (claimed === 0n) continue;

		const decimals = decimalsByToken[token];
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
			throw new Error(`Missing or invalid decimals for claimed token ${token}`);
		}

		const price = pricesByToken[token];
		if (!Number.isFinite(price) || price <= 0) {
			throw new Error(`Missing or invalid USD price for claimed token ${token}`);
		}
		const priceMicros = usdToMicros(price, `tokenPrices.${token}`);
		if (priceMicros === 0n) {
			throw new Error(`USD price for claimed token ${token} is below $0.000001`);
		}

		const weights = weightsByToken[token];
		const addresses = Object.keys(weights).sort();
		const totalUsdMicros = addresses.reduce(
			(sum, address) => sum + weights[address],
			0n,
		);
		const tokenScale = 10n ** BigInt(decimals);
		const requestedAmount =
			(totalUsdMicros * tokenScale) / priceMicros;
		const amountToDistribute =
			requestedAmount < claimed ? requestedAmount : claimed;
		let distributed = 0n;

		for (const [index, address] of addresses.entries()) {
			const amountWei =
				index === addresses.length - 1
					? amountToDistribute - distributed
					: (amountToDistribute * weights[address]) / totalUsdMicros;
			distributed += amountWei;
			if (amountWei === 0n) continue;

			const realizedUsdMicros =
				(amountWei * priceMicros) / tokenScale;
			if (realizedUsdMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
				throw new Error(
					`Realized USD value is too large to serialize safely for ${address}`,
				);
			}
			result.perAddressTokenAllocations[address] ??= {};
			result.perAddressTokenAllocations[address][token] = amountWei;
			result.tokenAllocations[address] ??= {};
			result.tokenAllocations[address][token] = {
				amount: formatUnits(amountWei, decimals),
				usd: Number(realizedUsdMicros) / USD_MICRO_SCALE,
			};
		}
	}

	return result;
};
