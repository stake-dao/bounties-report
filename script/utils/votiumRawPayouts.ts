import { getAddress } from "viem";

const USD_MICRO_DECIMALS = 6n;

// Votium payees whose attributed value is below this USD amount are not paid
// raw leaves; their value stays with the pool and settles through the Tuesday
// delegators pot. Builder and verifiers must share this floor.
export const MIN_VOTIUM_RAW_PAYOUT_USD = 1;

type TokenAllocation = {
	amountWei?: unknown;
	usd?: unknown;
};

type ClaimedBounty = {
	amount?: unknown;
	rewardToken?: unknown;
};

export type VotiumRawPayoutsResult = {
	/** Lowercase forwarder address -> lowercase token -> wei to pay raw. */
	payouts: Record<string, Record<string, bigint>>;
	/** Per-token totals over the PAID wallets (the Thursday withdrawal). */
	totalsPerToken: Record<string, bigint>;
	/** Wallets dropped by the USD floor — their value stays with the pool. */
	belowFloor: string[];
};

type ComputeVotiumRawPayoutsParams = {
	claimedBounties: unknown;
	minimumPayoutUsd: number;
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
 * The raw-token Votium payouts for the Thursday combined merkle.
 *
 * `tokenAllocations` (forwarders_voted_rewards.json) already carries
 * claimed-cap reconciled wei amounts for every individually attributed leg —
 * own votes and slices of non-Stake-DAO delegates' votes; pooled legs never
 * appear in it. This function re-validates the per-token totals against the
 * same period's claims (a generator bug must not over-pay), then applies the
 * USD floor per wallet: below-floor wallets are not paid — their tokens stay
 * with the pool, are swapped with the Stake DAO remainder and settle through
 * the Tuesday delegators pot.
 */
export const computeVotiumRawPayouts = ({
	claimedBounties,
	minimumPayoutUsd,
	tokenAllocations,
}: ComputeVotiumRawPayoutsParams): VotiumRawPayoutsResult => {
	if (!Number.isFinite(minimumPayoutUsd) || minimumPayoutUsd < 0) {
		throw new Error("minimumPayoutUsd must be a non-negative finite number");
	}

	const claimedByToken = sumClaimedAmounts(claimedBounties);
	const allocations = asRecord(tokenAllocations, "tokenAllocations");
	const allocatedByToken: Record<string, bigint> = {};
	const byAddress: Record<
		string,
		{ tokens: Record<string, bigint>; usdMicros: bigint }
	> = {};

	for (const [rawAddress, rawTokens] of Object.entries(allocations)) {
		const address = getAddress(rawAddress).toLowerCase();
		const entry = (byAddress[address] ??= { tokens: {}, usdMicros: 0n });

		for (const [rawToken, rawAllocation] of Object.entries(
			asRecord(rawTokens, `tokenAllocations.${rawAddress}`),
		)) {
			const allocation = asRecord(
				rawAllocation,
				`tokenAllocations.${rawAddress}.${rawToken}`,
			) as TokenAllocation;
			const amountWei = parseUnsignedBigInt(
				allocation.amountWei,
				`tokenAllocations.${rawAddress}.${rawToken}.amountWei`,
			);
			if (amountWei === 0n) continue;

			const token = rawToken.toLowerCase();
			allocatedByToken[token] = (allocatedByToken[token] ?? 0n) + amountWei;
			entry.tokens[token] = (entry.tokens[token] ?? 0n) + amountWei;
			entry.usdMicros += usdToMicros(
				allocation.usd,
				`tokenAllocations.${rawAddress}.${rawToken}.usd`,
			);
		}
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

	const minimumUsdMicros = usdToMicros(minimumPayoutUsd, "minimumPayoutUsd");
	const result: VotiumRawPayoutsResult = {
		payouts: {},
		totalsPerToken: {},
		belowFloor: [],
	};

	for (const address of Object.keys(byAddress).sort()) {
		const { tokens, usdMicros } = byAddress[address];
		if (Object.keys(tokens).length === 0) continue;
		if (usdMicros < minimumUsdMicros) {
			result.belowFloor.push(address);
			continue;
		}
		result.payouts[address] = tokens;
		for (const [token, amount] of Object.entries(tokens)) {
			result.totalsPerToken[token] =
				(result.totalsPerToken[token] ?? 0n) + amount;
		}
	}

	return result;
};
