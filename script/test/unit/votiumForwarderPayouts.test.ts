import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
	computeVotiumForwarderPayouts,
	hasClaimedVotiumBounties,
} from "../../vlCVX/3_merkles/votiumForwarderPayouts";

const A = "0x5bff1a68663ff91b0650327d83d4230cd00023ad";
const B = "0x8ac4c0630c5ed1636537924ec9b037fc652adee8";
const TOKEN_1 = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";
const TOKEN_2 = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const ONE = 10n ** 18n;

const claims = (tokenAmounts: Record<string, bigint>) => ({
	curve: Object.fromEntries(
		Object.entries(tokenAmounts).map(([rewardToken, amount], index) => [
			index,
			{ amount: amount.toString(), rewardToken },
		]),
	),
	fxn: {},
});

const compute = ({
	claimedBounties = claims({ [TOKEN_1]: 1_000n, [TOKEN_2]: 1_000n }),
	maxTotal = 1_000n * ONE,
	minimumPayoutUsd = 1,
	pricePerShare = ONE,
	tokenAllocations = {},
}: Partial<Parameters<typeof computeVotiumForwarderPayouts>[0]> = {}) =>
	computeVotiumForwarderPayouts({
		claimedBounties,
		maxTotal,
		minimumPayoutUsd,
		pricePerShare,
		tokenAllocations,
	});

describe("computeVotiumForwarderPayouts", () => {
	it("converts each address's claimed USD total to sCRVUSD", () => {
		const result = compute({
			pricePerShare: 2n * ONE,
			tokenAllocations: {
				[A]: {
					[TOKEN_1]: { amountWei: "6", usd: 6 },
					[TOKEN_2]: { amountWei: "4", usd: 4 },
				},
				[B]: { [TOKEN_1]: { amountWei: "5", usd: 5 } },
			},
		});

		expect(result).toEqual({
			capped: false,
			payouts: {
				[getAddress(A)]: 5n * ONE,
				[getAddress(B)]: 2_500_000_000_000_000_000n,
			},
			requestedTotal: 7_500_000_000_000_000_000n,
			totalPayout: 7_500_000_000_000_000_000n,
		});
	});

	it("keeps sub-threshold and unclaimed values in the delegators pool", () => {
		const result = compute({
			tokenAllocations: {
				[A]: { [TOKEN_1]: { amountWei: "10", usd: 10 } },
				[B]: {
					[TOKEN_1]: { amountWei: "1", usd: 0.4 },
					[TOKEN_2]: { amountWei: "0", usd: 50 },
				},
			},
		});

		expect(result.payouts).toEqual({ [getAddress(A)]: 10n * ONE });
		expect(result.totalPayout).toBe(10n * ONE);
	});

	it("caps payouts pro rata using bigint arithmetic", () => {
		const result = compute({
			maxTotal: 100n * ONE,
			tokenAllocations: {
				[A]: { [TOKEN_1]: { amountWei: "150", usd: 150 } },
				[B]: { [TOKEN_1]: { amountWei: "50", usd: 50 } },
			},
		});

		expect(result.capped).toBe(true);
		expect(result.requestedTotal).toBe(200n * ONE);
		expect(result.payouts).toEqual({
			[getAddress(A)]: 75n * ONE,
			[getAddress(B)]: 25n * ONE,
		});
		expect(result.totalPayout).toBe(100n * ONE);
	});

	it("never over-allocates a non-round pool", () => {
		const maxTotal = 50n * ONE + 17n;
		const result = compute({
			maxTotal,
			pricePerShare: 1_037_000_000_000_000_000n,
			tokenAllocations: {
				[A]: {
					[TOKEN_1]: { amountWei: "34", usd: 33.33 },
					[TOKEN_2]: { amountWei: "1", usd: 0.01 },
				},
				[B]: { [TOKEN_1]: { amountWei: "67", usd: 66.67 } },
			},
		});

		expect(result.capped).toBe(true);
		expect(result.totalPayout).toBeLessThanOrEqual(maxTotal);
		expect(Object.values(result.payouts).reduce((sum, value) => sum + value, 0n)).toBe(
			result.totalPayout,
		);
	});

	it("merges duplicate address keys after checksum normalization", () => {
		const checksummedA = getAddress(A);
		const result = compute({
			claimedBounties: claims({ [TOKEN_1]: 2n }),
			tokenAllocations: {
				[A]: { [TOKEN_1]: { amountWei: "1", usd: 2 } },
				[checksummedA]: { [TOKEN_1]: { amountWei: "1", usd: 3 } },
			},
		});

		expect(result.payouts).toEqual({ [checksummedA]: 5n * ONE });
	});

	it("returns an empty result when there are no payable allocations", () => {
		expect(compute()).toEqual({
			capped: false,
			payouts: {},
			requestedTotal: 0n,
			totalPayout: 0n,
		});

		const result = compute({
			tokenAllocations: {
				[A]: {
					[TOKEN_1]: { amountWei: "1", usd: 0 },
					[TOKEN_2]: { amountWei: "1", usd: -5 },
				},
			},
		});
		expect(result.payouts).toEqual({});
	});

	it("rejects attribution that is not backed by claimed token amounts", () => {
		expect(() =>
			compute({
				claimedBounties: claims({ [TOKEN_1]: 9n }),
				tokenAllocations: {
					[A]: { [TOKEN_1]: { amountWei: "10", usd: 10 } },
				},
			}),
		).toThrow(/10 allocated, 9 claimed/);

		expect(() =>
			compute({
				tokenAllocations: {
					[A]: { [TOKEN_1]: { usd: 10 } },
				},
			}),
		).toThrow(/amountWei must be an unsigned integer string/);
	});

	it("rejects invalid monetary bounds", () => {
		expect(() => compute({ pricePerShare: 0n })).toThrow(
			"pricePerShare must be positive",
		);
		expect(() => compute({ maxTotal: -1n })).toThrow(
			"maxTotal cannot be negative",
		);
		expect(() => compute({ minimumPayoutUsd: Number.NaN })).toThrow(
			"minimumPayoutUsd must be a non-negative finite number",
		);
	});
});

describe("hasClaimedVotiumBounties", () => {
	it("detects positive claimed amounts across protocols", () => {
		expect(hasClaimedVotiumBounties(claims({ [TOKEN_1]: 1n }))).toBe(true);
		expect(
			hasClaimedVotiumBounties({
				curve: {},
				fxn: { 0: { amount: "5", rewardToken: TOKEN_2 } },
			}),
		).toBe(true);
	});

	it("treats missing or zero-amount claims as empty", () => {
		expect(hasClaimedVotiumBounties({ curve: {}, fxn: {} })).toBe(false);
		expect(hasClaimedVotiumBounties({})).toBe(false);
		expect(hasClaimedVotiumBounties(claims({ [TOKEN_1]: 0n }))).toBe(false);
	});

	it("rejects malformed claims instead of treating them as empty", () => {
		expect(() => hasClaimedVotiumBounties(null)).toThrow(
			"claimedBounties must be an object",
		);
		expect(() =>
			hasClaimedVotiumBounties({ curve: { 0: { rewardToken: TOKEN_1 } } }),
		).toThrow(/amount must be an unsigned integer string/);
	});
});
