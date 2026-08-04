import { getAddress } from "viem";

/**
 * Pure helpers for paying Votium direct-voter forwarders individually from the
 * Tuesday delegators merkle. Kept free of I/O and module state so they can be
 * unit-tested (createDelegatorsMerkle.ts reads files at import time and can't
 * be imported from vitest).
 */

export type DirectWeights = {
	// EIP-55 checksummed address -> USD weight in micro-dollars (1e6 = $1)
	weightsMicros: Record<string, bigint>;
	totalMicros: bigint;
};

/**
 * Extracts per-address USD payout weights from a
 * weekly-bounties/<period>/votium/forwarders_voted_rewards.json payload
 * (shape: tokenAllocations[address][token] = { amount, amountWei, usd }).
 *
 * - a missing/invalid `usd` (NaN, <= 0) contributes nothing: dust must never
 *   abort the weekly distribution, it just weighs zero;
 * - addresses are normalized to EIP-55; two casings of the same address are
 *   SUMMED. generateMerkleTree overwrites amounts when two input keys checksum
 *   to the same address, so collisions must be resolved before the merge;
 * - an unparseable address is a corrupted file, not dust: throw rather than
 *   silently dropping someone's payout.
 */
export function computeDirectWeights(forwardersData: unknown): DirectWeights {
	const weightsMicros: Record<string, bigint> = {};
	let totalMicros = 0n;

	const allocations = (forwardersData as any)?.tokenAllocations;
	if (
		allocations === undefined ||
		allocations === null ||
		typeof allocations !== "object" ||
		Array.isArray(allocations)
	) {
		return { weightsMicros, totalMicros };
	}

	for (const [rawAddress, tokens] of Object.entries(allocations)) {
		let address: string;
		try {
			address = getAddress(rawAddress);
		} catch {
			throw new Error(
				`computeDirectWeights: invalid forwarder address in tokenAllocations: ${rawAddress}`,
			);
		}
		if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
			continue;
		}

		let addressMicros = 0n;
		for (const allocation of Object.values(tokens as Record<string, any>)) {
			const usd = allocation?.usd;
			if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
				continue;
			}
			const micros = Math.round(usd * 1e6);
			if (micros <= 0) {
				continue;
			}
			if (!Number.isSafeInteger(micros)) {
				// A single allocation above ~$9e9 is upstream corruption, not dust:
				// skipping it silently would socialize that address's payout.
				throw new Error(
					`computeDirectWeights: usd value out of safe range for ${address}: ${usd}`,
				);
			}
			addressMicros += BigInt(micros);
		}

		if (addressMicros > 0n) {
			weightsMicros[address] = (weightsMicros[address] || 0n) + addressMicros;
			totalMicros += addressMicros;
		}
	}

	return { weightsMicros, totalMicros };
}

/**
 * Splits `pool` across `weights` exactly (largest-remainder): floors first,
 * then hands the leftover wei to the largest remainders. Deterministic for any
 * input order (ties broken by address) so a re-run reproduces the same merkle.
 * Post-condition: the returned amounts sum to exactly `pool`.
 */
export function allocateExact(
	pool: bigint,
	weightsMicros: Record<string, bigint>,
): Record<string, bigint> {
	if (pool < 0n) {
		throw new Error("allocateExact: negative pool");
	}
	for (const [address, weight] of Object.entries(weightsMicros)) {
		if (weight < 0n) {
			throw new Error(`allocateExact: negative weight for ${address}`);
		}
	}
	if (pool === 0n) {
		return {};
	}

	const entries = Object.entries(weightsMicros)
		.filter(([, weight]) => weight > 0n)
		.map(([address, weight]) => ({ address, weight }));
	const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0n);
	if (totalWeight === 0n) {
		// The caller derives the pool from these same weights; a positive pool
		// with no positive weight means it would be distributed to no one.
		throw new Error("allocateExact: positive pool with zero total weight");
	}

	const ranked = entries.map((entry) => {
		const numerator = pool * entry.weight;
		return {
			...entry,
			amount: numerator / totalWeight,
			remainder: numerator % totalWeight,
		};
	});
	let remaining = pool - ranked.reduce((sum, entry) => sum + entry.amount, 0n);
	// remaining < entries.length by construction (sum of floors)
	ranked.sort((a, b) => {
		if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
		return a.address < b.address ? -1 : 1;
	});
	for (let index = 0; remaining > 0n; index++, remaining--) {
		ranked[index].amount += 1n;
	}

	const out: Record<string, bigint> = {};
	let allocated = 0n;
	for (const entry of ranked) {
		if (entry.amount > 0n) {
			out[entry.address] = entry.amount;
			allocated += entry.amount;
		}
	}
	if (allocated !== pool) {
		throw new Error(
			`allocateExact: allocated ${allocated} does not conserve pool ${pool}`,
		);
	}
	return out;
}
