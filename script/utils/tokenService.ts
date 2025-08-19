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
    const token = this.symbolToToken.get(symbol.toUpperCase());
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