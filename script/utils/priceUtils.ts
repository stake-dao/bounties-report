import axios from "axios";

// Identifier for each token we want a price for
export interface TokenIdentifier {
  /**
   * Chain ID (e.g., 1, 8453, 42161)
   */
  chainId: number;
  /**
   * Contract address (in lowercase)
   */
  address: string;
}

const LLAMA_NETWORK_MAPPING: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
};

export { LLAMA_NETWORK_MAPPING };

const GECKO_NETWORK_MAPPING: Record<number, string> = {
  1: "eth",
  8453: "base",
  42161: "arbitrum",
};

const COINGECKO_CHAIN_ID_MAPPING: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum-one",
};

/**
 * Fetch current USD prices for multiple tokens, using DefiLlama as primary
 * and GeckoTerminal as a fallback for any missing data.
 *
 * @param tokens List of tokens (network + address)
 * @param searchWidth How far back to search in DefiLlama (e.g. '4h')
 * @returns A record mapping "{network}:{address}" => price in USD
 */
export async function getTokenPrices(
  tokens: TokenIdentifier[],
  searchWidth: string = "4h"
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  // Build DefiLlama keys and map back to our tokens
  const llamaKeys: string[] = [];
  const tokenKeyMap: Record<string, TokenIdentifier> = {};

  tokens.forEach(({ chainId, address }) => {
    const llamaNetwork = LLAMA_NETWORK_MAPPING[chainId];
    if (!llamaNetwork) {
      throw new Error(`Unsupported network: ${chainId}`);
    }
    const key = `${llamaNetwork}:${address}`.toLowerCase();
    llamaKeys.push(key);
    tokenKeyMap[key] = { chainId, address };
  });

  // Primary fetch from DefiLlama
  try {
    const llamaUrl =
      `https://coins.llama.fi/prices/current/${llamaKeys.join(",")}` +
      `?searchWidth=${encodeURIComponent(searchWidth)}`;
    const llamaResp = await axios.get<{
      coins: Record<string, { price: number }>;
    }>(llamaUrl);
    const coins = llamaResp.data.coins || {};
    // Populate results for any prices > 0
    Object.entries(coins).forEach(([key, { price }]) => {
      if (price > 0) {
        results[key] = price;
      }
    });
  } catch (err) {
    console.error("DefiLlama API error:", err);
  }

  // Determine which keys are still missing
  const missingKeys = llamaKeys.filter((key) => !(key in results));
  if (missingKeys.length === 0) {
    return results;
  }

  // Group missing tokens by GeckoTerminal network
  const geckoGroups: Record<string, { key: string; address: string }[]> = {};
  missingKeys.forEach((key) => {
    const { chainId, address } = tokenKeyMap[key];
    const geckoNetwork = GECKO_NETWORK_MAPPING[chainId];
    if (!geckoNetwork) return;
    if (!geckoGroups[geckoNetwork]) geckoGroups[geckoNetwork] = [];
    geckoGroups[geckoNetwork].push({ key, address });
  });

  // Fallback fetch from GeckoTerminal
  await Promise.all(
    Object.entries(geckoGroups).map(async ([geckoNetwork, group]) => {
      try {
        const addresses = group
          .map((g) => encodeURIComponent(g.address))
          .join(",");
        const geckoUrl =
          `https://api.geckoterminal.com/api/v2/simple/networks/` +
          `${geckoNetwork}/token_price/${addresses}`;
        const geckoResp = await axios.get<any>(geckoUrl);
        const data = geckoResp.data.data || [];
        data.forEach((item: any) => {
          const addr = item.attributes.token_address.toLowerCase();
          const price = item.attributes.price;
          // Find corresponding key in our group
          const found = group.find((g) => g.address === addr);
          if (found && price > 0) {
            results[found.key] = price;
          }
        });
      } catch (err) {
        console.error(`GeckoTerminal error on ${geckoNetwork}:`, err);
      }
    })
  );

  return results;
}

/**
 * Fetch current prices from CoinGecko API.
 * Used as a fallback when historical prices are not available.
 *
 * @param tokens List of tokens (chainId + address)
 * @returns A record mapping "{network}:{address}" => current price in USD
 */
async function getCoinGeckoCurrentPrices(
  tokens: TokenIdentifier[]
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  // Group tokens by chain
  const tokensByChain: Record<number, string[]> = {};
  tokens.forEach(({ chainId, address }) => {
    if (!tokensByChain[chainId]) {
      tokensByChain[chainId] = [];
    }
    tokensByChain[chainId].push(address);
  });

  // Fetch prices for each chain
  await Promise.all(
    Object.entries(tokensByChain).map(async ([chainIdStr, addresses]) => {
      const chainId = parseInt(chainIdStr);
      const coingeckoChain = COINGECKO_CHAIN_ID_MAPPING[chainId];
      if (!coingeckoChain) {
        console.warn(`CoinGecko chain mapping not found for chainId ${chainId}`);
        return;
      }

      try {
        // CoinGecko expects addresses as comma-separated list
        const addressList = addresses.join(",");
        const url = `https://api.coingecko.com/api/v3/simple/token_price/${coingeckoChain}?contract_addresses=${addressList}&vs_currencies=usd`;
        
        const resp = await axios.get(url);
        const data = resp.data;

        // Process results
        addresses.forEach((address) => {
          const normalizedAddr = address.toLowerCase();
          const priceData = data[normalizedAddr];
          if (priceData && priceData.usd && priceData.usd > 0) {
            const llamaKey = `${LLAMA_NETWORK_MAPPING[chainId]}:${normalizedAddr}`;
            results[llamaKey] = priceData.usd;
          }
        });
      } catch (err) {
        console.error(`CoinGecko API error for ${coingeckoChain}:`, err);
      }
    })
  );

  return results;
}

/**
 * Fetch historical USD prices at a specific UNIX timestamp for multiple tokens.
 * Uses DefiLlama only (GeckoTerminal does not support historical via API).
 *
 * @param tokens List of tokens (chainId + address)
 * @param timestamp UNIX timestamp (seconds since epoch)
 * @returns A record mapping "{network}:{address}" => historical price in USD
 * @throws If any token price is zero or missing
 */
export async function getHistoricalTokenPrices(
  tokens: TokenIdentifier[],
  timestamp: number
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  // Build DefiLlama keys
  const llamaKeys = tokens.map(({ chainId, address }) => {
    const llamaNetwork = LLAMA_NETWORK_MAPPING[chainId];
    if (!llamaNetwork) {
      throw new Error(`Unsupported network for historical price: ${chainId}`);
    }
    return `${llamaNetwork}:${address}`.toLowerCase();
  });

  // Fetch historical prices in one batch
  try {
    const url = `https://coins.llama.fi/prices/historical/${timestamp}/${llamaKeys.join(
      ","
    )}`;
    const resp = await axios.get<{ coins: Record<string, { price: number }> }>(
      url
    );
    const coins = resp.data.coins || {};

    const missingTokens: TokenIdentifier[] = [];
    tokens.forEach(({ chainId, address }) => {
      const key = `${LLAMA_NETWORK_MAPPING[chainId]}:${address}`.toLowerCase();
      const entry = coins[key];
      if (!entry || entry.price === 0) {
        missingTokens.push({ chainId, address });
      } else {
        results[key] = entry.price;
      }
    });

    // If we have missing tokens, fallback to CoinGecko current prices
    if (missingTokens.length > 0) {
      console.warn(
        `Historical prices unavailable for ${missingTokens.length} tokens, falling back to CoinGecko current prices`
      );
      const currentPrices = await getCoinGeckoCurrentPrices(missingTokens);
      Object.assign(results, currentPrices);
    }

    // Check if we still have missing prices
    tokens.forEach(({ chainId, address }) => {
      const key = `${LLAMA_NETWORK_MAPPING[chainId]}:${address}`.toLowerCase();
      if (!results[key] || results[key] === 0) {
        throw new Error(`Price unavailable for ${key} even after CoinGecko fallback`);
      }
    });

    return results;
  } catch (err) {
    console.error("Error fetching historical prices:", err);
    throw err;
  }
}
