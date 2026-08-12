/**
 * Value-weighted forwarder split for the Tuesday sCRVUSD distribution (pure
 * math — price/decimals fetching stays in createDelegatorsMerkle).
 *
 * All the week's reward tokens are swapped to sCRVUSD in batched multi-token
 * txs minting ONE sCRVUSD amount per tx (verified on real deposit txs), so
 * per-token proceeds cannot be read off receipts without fragile route
 * tracing. Instead the whole available pool is split by each forwarder's
 * USD-VALUED exact entitlement:
 *
 *   weight(wallet) = Σ_token exactAmount(wallet, token) × priceUsd(token)
 *
 * computed in pico-USD bigints. Only price RATIOS matter for the split; the
 * price vector used is recorded in the breakdown artifact for audit. A
 * wallet weighs only the tokens its own delegate earned (a wallet entitled
 * only to USG gets USG-value share, never a CRV share); swap slippage is
 * socialized across the pool.
 *
 * Votium-leftover value (below-floor wallets, cap overflow) stays pooled by
 * design and follows the same value weights.
 */

// Prices are fixed-pointed at 1e-12 USD (pico-USD): micro-USD floors a
// sub-$0.000001 token to zero (aborting the split) and biases anything just
// above it by up to ~50%. Pico keeps 12 significant decimals for dust-priced
// tokens while string-based conversion (no float multiply) stays exact for
// large prices too. Only ratios matter for the split, so the scale cancels.
export const USD_PICO_DECIMALS = 12;
export const USD_PICO_SCALE = 10n ** BigInt(USD_PICO_DECIMALS);

/**
 * Merges the exact forwarder entitlements of both platforms:
 * lowercase wallet -> lowercase token -> wei, summed on overlap.
 */
export const mergeEntitlements = (
	...groups: Record<string, Record<string, bigint>>[]
): Record<string, Record<string, bigint>> => {
	const out: Record<string, Record<string, bigint>> = {};
	for (const group of groups) {
		for (const [wallet, tokens] of Object.entries(group)) {
			for (const [token, amount] of Object.entries(tokens)) {
				(out[wallet] ??= {})[token] = (out[wallet][token] ?? 0n) + amount;
			}
		}
	}
	return out;
};

/**
 * Pico-USD value of each wallet's entitlement:
 *   Σ_token amountWei × pricePico / 10^decimals
 *
 * Throws when a token carrying a non-zero amount has no (or a non-positive)
 * price or missing decimals — silently zero-weighting a token would move its
 * holders' money to everyone else.
 */
export const computeValueWeights = (
	entitlements: Record<string, Record<string, bigint>>,
	pricePicoByToken: Record<string, bigint>,
	decimalsByToken: Record<string, number>,
): Record<string, bigint> => {
	const weights: Record<string, bigint> = {};
	for (const [wallet, tokens] of Object.entries(entitlements)) {
		let value = 0n;
		for (const [token, amount] of Object.entries(tokens)) {
			if (amount <= 0n) continue;
			const price = pricePicoByToken[token];
			const decimals = decimalsByToken[token];
			if (price === undefined || price <= 0n) {
				throw new Error(
					`computeValueWeights: no usable price for token ${token} ` +
						`(wallet ${wallet} holds ${amount}) — refusing to zero-weight it`,
				);
			}
			if (decimals === undefined || decimals < 0 || decimals > 36) {
				throw new Error(
					`computeValueWeights: missing/invalid decimals for token ${token}`,
				);
			}
			value += (amount * price) / 10n ** BigInt(decimals);
		}
		if (value > 0n) weights[wallet] = value;
	}
	return weights;
};

/**
 * USD number -> pico-USD bigint via decimal-string conversion: no float
 * multiply, so a $100k token stays exact and a $0.0000000005 token keeps its
 * significant digits (toFixed rounds at the 12th decimal). Rejects
 * non-finite/negative input.
 */
export const usdToPico = (usd: number, label: string): bigint => {
	if (!Number.isFinite(usd) || usd < 0) {
		throw new Error(`${label}: invalid USD price ${usd}`);
	}
	// toFixed(12) never uses exponent notation and rounds the decimal
	// expansion of the float, e.g. 123456.789 -> "123456.789000000000".
	const fixed = usd.toFixed(USD_PICO_DECIMALS);
	const [whole, frac = ""] = fixed.split(".");
	return BigInt(whole) * USD_PICO_SCALE + BigInt(frac.padEnd(USD_PICO_DECIMALS, "0"));
};
