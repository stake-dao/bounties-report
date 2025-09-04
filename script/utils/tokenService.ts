import axios from "axios";

// API URL for Stake DAO token list
const STAKE_DAO_TOKENS_URL = "https://raw.githubusercontent.com/stake-dao/assets/refs/heads/main/tokens/all.json";

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

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
    const chainMap = this.addressToToken.get(chainId);
    if (!chainMap) return undefined;
    return chainMap.get(address.toLowerCase());
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
    
    // Try as address first
    let token = await this.getTokenByAddress(addressOrSymbol, chainId);
    
    // If not found, try as symbol
    if (!token) {
      token = await this.getTokenBySymbol(addressOrSymbol, chainId);
    }
    
    // Return decimals or default to 18
    return token?.decimals || 18;
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

// Initialize on first import (but don't block)
tokenService.initialize().catch(console.error);