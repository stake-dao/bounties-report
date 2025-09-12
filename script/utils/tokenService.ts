import axios from "axios";
import { createPublicClient, http, getAddress } from "viem";
import { mainnet, bsc, optimism, fraxtal, base, polygon, arbitrum } from "viem/chains";

// API URL for Stake DAO token list
const STAKE_DAO_TOKENS_URL = "https://raw.githubusercontent.com/stake-dao/assets/refs/heads/main/tokens/all.json";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Chain configurations
const CHAIN_CONFIGS = {
  "1": { chain: mainnet, rpcUrl: "https://eth-mainnet.public.blastapi.io" },
  "10": { chain: optimism, rpcUrl: "https://mainnet.optimism.io" },
  "56": { chain: bsc, rpcUrl: "https://bsc-dataseed1.binance.org" },
  "137": { chain: polygon, rpcUrl: "https://polygon-rpc.com" },
  "252": { chain: fraxtal, rpcUrl: "https://rpc.frax.com" },
  "8453": { chain: base, rpcUrl: "https://mainnet.base.org" },
  "42161": { chain: arbitrum, rpcUrl: "https://arb1.arbitrum.io/rpc" },
};

interface TokenInfo {
  id: string;
  name: string;
  address: Record<string, string>; // chainId -> address
  symbol: string;
  decimals: number;
  logoURI: string;
  tags: string[];
  extensions: Record<string, any>;
}

class TokenService {
  private tokens: TokenInfo[] = [];
  private symbolToToken: Map<string, TokenInfo> = new Map();
  private addressToToken: Map<string, Map<string, TokenInfo>> = new Map(); // chainId -> address -> token
  private rpcFetchedTokens: Map<string, TokenInfo> = new Map(); // cacheKey -> token (for RPC fetched tokens)
  private lastFetchTime: number = 0;
  private isInitialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  // Special case overrides for tokens with multiple entries
  private readonly TOKEN_OVERRIDES: Record<string, Record<string, string>> = {
    USDC: {
      "1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "10": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      "100": "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
      "137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      "146": "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      "250": "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75",
      "252": "0xDcc0F2D8F90FDe85b10aC1c8Ab57dc0AE946A543",
      "8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      "42220": "0x37f750B7cC259A2f741AF45294f6a16572CF5cAd",
      "43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      "56": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
    },
    SDEX: {
      "1": "0x5DE8ab7E27f6E7A1fFf3E5B337584Aa43961BEeF"
    },
    opASF: {
      "1": "0x7fE24F1A024D33506966CB7CA48Bab8c65fB632d"
    },
    EYWA: {
      "42161": "0x7A10F506E4c7658e6AD15Fdf0443d450B7FA80D7"
    },
    RZR: {
      "1": "0xb4444468e444f89e1c2CAc2F1D3ee7e336cBD1f5"
    }
  };

  /**
   * Initialize the token service by fetching data from the API
   */
  async initialize(): Promise<void> {
    // If already initializing, return the existing promise
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // If already initialized and cache is still valid, return
    if (this.isInitialized && Date.now() - this.lastFetchTime < CACHE_DURATION) {
      return;
    }

    // Start initialization
    this.initializationPromise = this._performInitialization();
    
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async _performInitialization(): Promise<void> {
    try {
      console.log("Fetching token data from Stake DAO assets...");
      const response = await axios.get<TokenInfo[]>(STAKE_DAO_TOKENS_URL);
      this.tokens = response.data;

      // Clear existing maps
      this.symbolToToken.clear();
      this.addressToToken.clear();

      // Build lookup maps
      for (const token of this.tokens) {
        // Map by symbol (uppercase for case-insensitive lookup)
        this.symbolToToken.set(token.symbol.toUpperCase(), token);

        // Map by address for each chain
        for (const [chainId, address] of Object.entries(token.address)) {
          if (!this.addressToToken.has(chainId)) {
            this.addressToToken.set(chainId, new Map());
          }
          const chainMap = this.addressToToken.get(chainId)!;
          chainMap.set(address.toLowerCase(), token);
        }
      }

      this.lastFetchTime = Date.now();
      this.isInitialized = true;
      console.log(`Loaded ${this.tokens.length} tokens from Stake DAO assets`);
    } catch (error) {
      console.error("Failed to fetch token data:", error);
      // If we have cached data, continue using it
      if (this.isInitialized) {
        console.log("Using cached token data");
      } else {
        throw new Error("Failed to initialize token service");
      }
    }
  }

  /**
   * Ensure the service is initialized before accessing data
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Get token info by symbol
   */
  async getTokenBySymbol(symbol: string, chainId: string = "1"): Promise<TokenInfo | undefined> {
    await this.ensureInitialized();
    
    const upperSymbol = symbol.toUpperCase();
    
    // Check for overrides first
    if (this.TOKEN_OVERRIDES[upperSymbol] && this.TOKEN_OVERRIDES[upperSymbol][chainId]) {
      // Create a token info object with override addresses
      return {
        id: upperSymbol.toLowerCase(),
        name: upperSymbol === 'USDT' ? 'Tether USD' : upperSymbol === 'USDC' ? 'USD Coin' : upperSymbol,
        symbol: upperSymbol,
        address: this.TOKEN_OVERRIDES[upperSymbol],
        decimals: upperSymbol === 'USDC' && chainId === '56' ? 18 : 6, // Binance USDC has 18 decimals
        logoURI: "",
        tags: [],
        extensions: {}
      };
    }
    
    const token = this.symbolToToken.get(upperSymbol);
    // Check if token exists on the specified chain
    if (token && token.address[chainId]) {
      return token;
    }
    return undefined;
  }

  /**
   * Get token info by address
   */
  async getTokenByAddress(address: string, chainId: string = "1"): Promise<TokenInfo | undefined> {
    await this.ensureInitialized();
    
    // First check if this address matches any override
    const lowerAddress = address.toLowerCase();
    for (const [symbol, addresses] of Object.entries(this.TOKEN_OVERRIDES)) {
      if (addresses[chainId] && addresses[chainId].toLowerCase() === lowerAddress) {
        // Create a TokenInfo object for the override
        return {
          id: symbol.toLowerCase(),
          name: this.getTokenNameFromSymbol(symbol),
          symbol: symbol,
          address: addresses,
          decimals: this.getTokenDecimalsFromSymbol(symbol, chainId),
          logoURI: "",
          tags: [],
          extensions: {}
        };
      }
    }
    
    // Then check the regular token map
    const chainMap = this.addressToToken.get(chainId);
    if (!chainMap) return undefined;
    const tokenInfo = chainMap.get(lowerAddress);
    
    // If not found, try to fetch from RPC
    if (!tokenInfo) {
      return await this.fetchTokenFromRpc(address, chainId);
    }
    
    return tokenInfo;
  }
  
  /**
   * Fetch token information directly from blockchain via RPC
   */
  private async fetchTokenFromRpc(address: string, chainId: string): Promise<TokenInfo | undefined> {
    // Check cache first
    const cacheKey = `${chainId}-${address.toLowerCase()}`;
    const cached = this.rpcFetchedTokens.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const chainConfig = CHAIN_CONFIGS[chainId as keyof typeof CHAIN_CONFIGS];
      if (!chainConfig) {
        console.warn(`Chain ${chainId} not configured for RPC fallback`);
        return undefined;
      }

      const publicClient = createPublicClient({
        chain: chainConfig.chain,
        transport: http(chainConfig.rpcUrl, {
          retryCount: 2,
          timeout: 10000,
        }),
      }) as any;

      // Fetch symbol and decimals from the token contract
      const [symbol, decimals, name] = await Promise.all([
        publicClient.readContract({
          address: getAddress(address),
          abi: [
            {
              inputs: [],
              name: "symbol",
              outputs: [{ type: "string" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "symbol",
        }).catch(() => "UNKNOWN"),
        
        publicClient.readContract({
          address: getAddress(address),
          abi: [
            {
              inputs: [],
              name: "decimals",
              outputs: [{ type: "uint8" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "decimals",
        }).catch(() => 18),
        
        publicClient.readContract({
          address: getAddress(address),
          abi: [
            {
              inputs: [],
              name: "name",
              outputs: [{ type: "string" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "name",
        }).catch(() => "Unknown Token"),
      ]);

      console.log(`Fetched unknown token from RPC - Address: ${address}, Symbol: ${symbol}, Decimals: ${decimals}, Chain: ${chainId}`);

      // Create TokenInfo object
      const tokenInfo: TokenInfo = {
        id: `${symbol.toLowerCase()}-${chainId}`,
        name: name as string,
        symbol: symbol as string,
        address: { [chainId]: address },
        decimals: Number(decimals),
        logoURI: "",
        tags: ["rpc-fetched"],
        extensions: {}
      };

      // Cache the result
      this.rpcFetchedTokens.set(cacheKey, tokenInfo);

      return tokenInfo;
    } catch (error) {
      console.error(`Failed to fetch token info from RPC for ${address} on chain ${chainId}:`, error);
      return undefined;
    }
  }
  
  /**
   * Helper to get token name from symbol
   */
  private getTokenNameFromSymbol(symbol: string): string {
    const names: Record<string, string> = {
      'USDC': 'USD Coin',
      'USDT': 'Tether USD',
      'SDEX': 'Stake DAO Exchange',
      'EYWA': 'EYWA Token',
      'USDaf': 'Asymmetry Finance USD',
      'RSUP': 'RSup Token',
      'USDf': 'Fluid USD',
      'fxUSD': 'f(x) Protocol USD',
      'CRV': 'Curve DAO Token',
      'CVX': 'Convex Finance',
      'FXS': 'Frax Share',
      'SDT': 'Stake DAO Token',
      'WETH': 'Wrapped Ether',
      'PAL': 'Paladin',
      'SPELL': 'Spell Token',
      'INV': 'Inverse Finance',
      'crvUSD': 'Curve USD',
      'ASF': 'Asymmetry Finance'
    };
    return names[symbol] || symbol;
  }
  
  /**
   * Helper to get token decimals from symbol
   */
  private getTokenDecimalsFromSymbol(symbol: string, chainId: string): number {
    // Special cases for decimals
    if (symbol === 'USDC' && chainId === '56') return 18; // BSC USDC has 18 decimals
    if (symbol === 'USDC' || symbol === 'USDT') return 6;
    return 18; // Default to 18
  }

  /**
   * Get token address by symbol for a specific chain
   */
  async getTokenAddress(symbol: string, chainId: string = "1"): Promise<string | undefined> {
    const upperSymbol = symbol.toUpperCase();
    
    // Check for overrides first for direct address lookup
    if (this.TOKEN_OVERRIDES[upperSymbol] && this.TOKEN_OVERRIDES[upperSymbol][chainId]) {
      return this.TOKEN_OVERRIDES[upperSymbol][chainId];
    }
    
    const token = await this.getTokenBySymbol(symbol, chainId);
    return token?.address[chainId];
  }

  /**
   * Get token decimals by address or symbol
   */
  async getTokenDecimals(addressOrSymbol: string, chainId: string = "1"): Promise<number> {
    await this.ensureInitialized();
    
    // Try as address first (includes RPC fallback)
    let token = await this.getTokenByAddress(addressOrSymbol, chainId);
    
    // If not found, try as symbol
    if (!token) {
      token = await this.getTokenBySymbol(addressOrSymbol, chainId);
    }
    
    // If still not found and it looks like an address, try RPC directly
    if (!token && addressOrSymbol.startsWith("0x") && addressOrSymbol.length === 42) {
      token = await this.fetchTokenFromRpc(addressOrSymbol, chainId);
    }
    
    // Return decimals or default to 18
    return token?.decimals || 18;
  }

  /**
   * Get token symbol by address - with RPC fallback
   */
  async getTokenSymbol(address: string, chainId: string = "1"): Promise<string> {
    const token = await this.getTokenByAddress(address, chainId);
    return token?.symbol || "UNKNOWN";
  }

  /**
   * Get all tokens for a specific chain
   */
  async getTokensForChain(chainId: string): Promise<TokenInfo[]> {
    await this.ensureInitialized();
    return this.tokens.filter(token => token.address[chainId]);
  }

  /**
   * Search tokens by partial symbol or name
   */
  async searchTokens(query: string, chainId?: string): Promise<TokenInfo[]> {
    await this.ensureInitialized();
    const lowerQuery = query.toLowerCase();
    
    let results = this.tokens.filter(token => 
      token.symbol.toLowerCase().includes(lowerQuery) ||
      token.name.toLowerCase().includes(lowerQuery)
    );

    // Filter by chain if specified
    if (chainId) {
      results = results.filter(token => token.address[chainId]);
    }

    return results;
  }
}

// Export singleton instance
export const tokenService = new TokenService();

// Export convenience functions that use the singleton
export async function getTokenAddress(symbol: string, chainId: string = "1"): Promise<string | undefined> {
  return tokenService.getTokenAddress(symbol, chainId);
}

export async function getTokenDecimals(addressOrSymbol: string, chainId: string = "1"): Promise<number> {
  return tokenService.getTokenDecimals(addressOrSymbol, chainId);
}

export async function getTokenBySymbol(symbol: string, chainId: string = "1"): Promise<TokenInfo | undefined> {
  return tokenService.getTokenBySymbol(symbol, chainId);
}

export async function getTokenByAddress(address: string, chainId: string = "1"): Promise<TokenInfo | undefined> {
  return tokenService.getTokenByAddress(address, chainId);
}

export async function getTokenSymbol(address: string, chainId: string = "1"): Promise<string> {
  return tokenService.getTokenSymbol(address, chainId);
}

// Initialize on first import (but don't block)
tokenService.initialize().catch(console.error);