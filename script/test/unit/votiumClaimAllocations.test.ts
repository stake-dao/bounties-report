import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { computeVotiumForwarderPayouts } from "../../vlCVX/3_merkles/votiumForwarderPayouts";
import { reconcileVotiumClaimAllocations } from "../../vlCVX/claims/votiumClaimAllocations";

const DIRECT_VOTER = "0x4b908f3d5e46b89c0d8a6478f86c80b88aa277d3";
const DELEGATOR_OVERLAP = "0x5bff1a68663ff91b0650327d83d4230cd00023ad";
const UNION_FORWARDER = "0x8ac4c0630c5ed1636537924ec9b037fc652adee8";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const BOLD = "0x6440f144b7e50D6a8439336510312d2F54beB01D";
const ONE = 10n ** 18n;

const tenderlyReconciliation = () =>
	reconcileVotiumClaimAllocations({
		claimedTokenAmounts: {
			[USDT.toLowerCase()]: 4_940_131n,
			[BOLD]: 61_161_700_796_976_898_048n,
		},
		originalTokenAllocations: {
			[DELEGATOR_OVERLAP]: {
				[USDT]: { amount: "12.670407", usd: 12.670407799995806 },
			},
			[UNION_FORWARDER]: {
				[USDT]: { amount: "0.135879", usd: 0.1358790914156403 },
			},
			[DIRECT_VOTER]: {
				[BOLD]: { amount: "61.161700", usd: 60.9191943767544 },
			},
		},
		tokenDecimals: { [USDT]: 6, [BOLD]: 18 },
		tokenPrices: { [USDT.toLowerCase()]: 1, [BOLD]: 0.98746 },
	});

describe("reconcileVotiumClaimAllocations", () => {
	it("resolves Ethereum USDT without loading the remote token list", async () => {
		// The explicit extension prevents ignored, locally compiled JS artifacts
		// from shadowing the TypeScript source in developer checkouts.
		// @ts-expect-error TypeScript source imports are supported by Vitest.
		const { getTokenAddress } = await import("../../utils/tokenService.ts");
		expect(await getTokenAddress("USDT")).toBe(USDT);
	});

	it("caps Tenderly's USDT attribution to the realized claim", () => {
		const result = tenderlyReconciliation();
		const overlap = DELEGATOR_OVERLAP.toLowerCase();
		const unionForwarder = UNION_FORWARDER.toLowerCase();
		const token = USDT.toLowerCase();

		expect(
			[overlap, unionForwarder].reduce(
				(total, address) =>
					total + result.perAddressTokenAllocations[address][token],
				0n,
			),
		).toBe(4_940_131n);
		expect(result.tokenAllocations[unionForwarder][token]).toEqual({
			amount: "0.052417",
			usd: 0.052417,
		});
		expect(result.tokenAllocations[overlap][token]).toEqual({
			amount: "4.887714",
			usd: 4.887714,
		});
	});

	it("values the direct voter's BOLD from the realized Tenderly amount", () => {
		const result = tenderlyReconciliation();
		const direct = DIRECT_VOTER.toLowerCase();
		const token = BOLD.toLowerCase();

		expect(result.perAddressTokenAllocations[direct][token]).toBe(
			61_161_700_796_976_898_048n,
		);
		expect(result.tokenAllocations[direct][token]).toEqual({
			amount: "61.161700796976898048",
			usd: 60.394733,
		});
	});

	it("pays both a direct voter and a delegator overlap from realized USD", () => {
		const reconciled = tenderlyReconciliation();
		const payouts = computeVotiumForwarderPayouts({
			claimedBounties: {
				curve: {
					0: { amount: "4940131", rewardToken: USDT },
					1: {
						amount: "61161700796976898048",
						rewardToken: BOLD,
					},
				},
				fxn: {},
			},
			maxTotal: 100n * ONE,
			minimumPayoutUsd: 1,
			pricePerShare: ONE,
			tokenAllocations: Object.fromEntries(
				Object.entries(reconciled.tokenAllocations).map(
					([address, allocations]) => [
						address,
						Object.fromEntries(
							Object.entries(allocations).map(([token, allocation]) => [
								token,
								{
									...allocation,
									amountWei:
										reconciled.perAddressTokenAllocations[address][
											token
										].toString(),
								},
							]),
						),
					],
				),
			),
		});

		expect(payouts.payouts).toEqual({
			[getAddress(DIRECT_VOTER)]: 60_394_733n * 10n ** 12n,
			[getAddress(DELEGATOR_OVERLAP)]: 4_887_714n * 10n ** 12n,
		});
		expect(payouts.totalPayout).toBe(65_282_447n * 10n ** 12n);
	});

	it("leaves unclaimed and unattributed amounts in the delegators pool", () => {
		const result = reconcileVotiumClaimAllocations({
			claimedTokenAmounts: { [USDT]: 10_000_000n },
			originalTokenAllocations: {
				[DIRECT_VOTER]: {
					[USDT]: { amount: "2", usd: 2 },
					[BOLD]: { amount: "5", usd: 5 },
				},
			},
			tokenDecimals: { [USDT]: 6 },
			tokenPrices: { [USDT]: 1 },
		});

		expect(result.perAddressTokenAllocations).toEqual({
			[DIRECT_VOTER.toLowerCase()]: { [USDT.toLowerCase()]: 2_000_000n },
		});
	});

	it("fails when an attributable claimed token has no usable price", () => {
		expect(() =>
			reconcileVotiumClaimAllocations({
				claimedTokenAmounts: { [USDT]: 1_000_000n },
				originalTokenAllocations: {
					[DIRECT_VOTER]: {
						[USDT]: { amount: "1", usd: 1 },
					},
				},
				tokenDecimals: { [USDT]: 6 },
				tokenPrices: {},
			}),
		).toThrow(/Missing or invalid USD price/);
	});
});
