import { getAddress } from "viem";

const SCRVUSD_DECIMALS = 18n;
const USD_MICRO_DECIMALS = 6n;
const SCRVUSD_SCALE = 10n ** SCRVUSD_DECIMALS;
const USD_MICRO_TO_WEI = 10n ** (SCRVUSD_DECIMALS - USD_MICRO_DECIMALS);

type TokenAllocation = {
	amountWei?: unknown;
	usd?: unknown;
};

type ClaimedBounty = {
	amount?: unknown;
	rewardToken?: unknown;
};

export type ForwarderPayoutResult = {
	/** True when the requested payouts were reduced to fit the available pool. */
	capped: boolean;
	/** Checksummed forwarder address -> sCRVUSD amount (wei). */
	payouts: Record<string, bigint>;
	/** Total requested before applying the pool cap. */
	requestedTotal: bigint;
	/** Sum of the final payouts. */
	totalPayout: bigint;
};

type ComputeForwarderPayoutsParams = {
	claimedBounties: unknown;
	maxTotal: bigint;
	minimumPayoutUsd: number;
	pricePerShare: bigint;
	tokenAllocations: unknown;
};

const asRecord = (
	value: unknown,
	label: string,
): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
};

const parseUnsignedBigInt = (value: unknown, label: string): bigint => {
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		throw new Error(`${label} must be an unsigned integer string`);
	}
	return BigInt(value);
};

const usdToMicros = (value: unknown, label: string): bigint => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number`);
	}
	if (value <= 0) return 0n;

	const micros = Math.floor(value * Number(10n ** USD_MICRO_DECIMALS));
	if (!Number.isSafeInteger(micros)) {
		throw new Error(`${label} is too large to convert safely`);
	}
	return BigInt(micros);
};

const sumClaimedAmounts = (claimedBounties: unknown): Record<string, bigint> => {
	const root = asRecord(claimedBounties, "claimedBounties");
	const totals: Record<string, bigint> = {};

	for (const protocol of ["curve", "fxn"] as const) {
		const entries = root[protocol];
		if (entries === undefined) continue;

		for (const [claimId, rawClaim] of Object.entries(
			asRecord(entries, `claimedBounties.${protocol}`),
		)) {
			const claim = asRecord(
				rawClaim,
				`claimedBounties.${protocol}.${claimId}`,
			) as ClaimedBounty;
			if (typeof claim.rewardToken !== "string") {
				throw new Error(
					`claimedBounties.${protocol}.${claimId}.rewardToken must be a string`,
				);
			}
			const token = claim.rewardToken.toLowerCase();
			const amount = parseUnsignedBigInt(
				claim.amount,
				`claimedBounties.${protocol}.${claimId}.amount`,
			);
			totals[token] = (totals[token] ?? 0n) + amount;
		}
	}

	return totals;
};

/**
 * True when the claimed-bounties data records at least one positive claim.
 * Throws on malformed input so a corrupt file cannot pass as "no claims".
 */
export const hasClaimedVotiumBounties = (claimedBounties: unknown): boolean =>
	Object.values(sumClaimedAmounts(claimedBounties)).some(
		(amount) => amount > 0n,
	);

/**
 * Convert Votium's per-forwarder USD attribution to sCRVUSD payouts.
 *
 * Only allocations backed by a positive `amountWei` are considered. Their
 * token totals must not exceed the same period's claimed Votium bounties.
 * USD values are rounded down to six decimals before conversion so every
 * subsequent operation, including pool capping, uses deterministic bigint
 * arithmetic.
 */
export const computeVotiumForwarderPayouts = ({
	claimedBounties,
	maxTotal,
	minimumPayoutUsd,
	pricePerShare,
	tokenAllocations,
}: ComputeForwarderPayoutsParams): ForwarderPayoutResult => {
	if (pricePerShare <= 0n) {
		throw new Error("pricePerShare must be positive");
	}
	if (maxTotal < 0n) {
		throw new Error("maxTotal cannot be negative");
	}
	if (!Number.isFinite(minimumPayoutUsd) || minimumPayoutUsd < 0) {
		throw new Error("minimumPayoutUsd must be a non-negative finite number");
	}

	const claimedByToken = sumClaimedAmounts(claimedBounties);
	const allocations = asRecord(tokenAllocations, "tokenAllocations");
	const allocatedByToken: Record<string, bigint> = {};
	const usdMicrosByAddress: Record<string, bigint> = {};

	for (const [rawAddress, rawTokens] of Object.entries(allocations)) {
		const address = getAddress(rawAddress);
		let addressUsdMicros = 0n;

		for (const [rawToken, rawAllocation] of Object.entries(
			asRecord(rawTokens, `tokenAllocations.${rawAddress}`),
		)) {
			const allocation = asRecord(
				rawAllocation,
				`tokenAllocations.${rawAddress}.${rawToken}`,
			) as TokenAllocation;
			const usdMicros = usdToMicros(
				allocation.usd,
				`tokenAllocations.${rawAddress}.${rawToken}.usd`,
			);
			if (usdMicros === 0n) continue;

			const claimedAmount = parseUnsignedBigInt(
				allocation.amountWei,
				`tokenAllocations.${rawAddress}.${rawToken}.amountWei`,
			);
			if (claimedAmount === 0n) continue;

			const token = rawToken.toLowerCase();
			allocatedByToken[token] =
				(allocatedByToken[token] ?? 0n) + claimedAmount;
			addressUsdMicros += usdMicros;
		}

		usdMicrosByAddress[address] =
			(usdMicrosByAddress[address] ?? 0n) + addressUsdMicros;
	}

	for (const [token, allocated] of Object.entries(allocatedByToken)) {
		const claimed = claimedByToken[token] ?? 0n;
		if (allocated > claimed) {
			throw new Error(
				`Votium forwarder allocations exceed claimed amount for ${token}: ` +
					`${allocated} allocated, ${claimed} claimed`,
			);
		}
	}

	const minimumUsdMicros = usdToMicros(
		minimumPayoutUsd,
		"minimumPayoutUsd",
	);
	const requestedPayouts: Record<string, bigint> = {};
	let requestedTotal = 0n;

	for (const address of Object.keys(usdMicrosByAddress).sort()) {
		const usdMicros = usdMicrosByAddress[address];
		if (usdMicros < minimumUsdMicros) continue;

		const usdWei = usdMicros * USD_MICRO_TO_WEI;
		const amount = (usdWei * SCRVUSD_SCALE) / pricePerShare;
		if (amount === 0n) continue;

		requestedPayouts[address] = amount;
		requestedTotal += amount;
	}

	if (requestedTotal <= maxTotal) {
		return {
			capped: false,
			payouts: requestedPayouts,
			requestedTotal,
			totalPayout: requestedTotal,
		};
	}

	const payouts: Record<string, bigint> = {};
	let totalPayout = 0n;
	for (const [address, requested] of Object.entries(requestedPayouts)) {
		const amount = (requested * maxTotal) / requestedTotal;
		if (amount === 0n) continue;
		payouts[address] = amount;
		totalPayout += amount;
	}

	return { capped: true, payouts, requestedTotal, totalPayout };
};
