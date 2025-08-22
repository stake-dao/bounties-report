import fs from "fs";
import path from "path";

interface CachedData {
  timestamp: number;
  data: any;
}

const CACHE_DIR = path.join(__dirname, "../../../.cache");
const CACHE_FILE = path.join(CACHE_DIR, "warden_distributors.json");
const CACHE_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

/**
 * Ensures the cache directory exists
 */
const ensureCacheDir = () => {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
};

/**
 * Saves data to cache
 * @param {any} data - The data to cache
 */
export const saveToCache = (data: any): void => {
  ensureCacheDir();
  
  const cacheData: CachedData = {
    timestamp: Date.now(),
    data: data
  };
  
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log("Saved distributor data to cache");
  } catch (error) {
    console.error("Failed to save to cache:", error);
  }
};

/**
 * Loads data from cache if it exists and is not expired
 * @returns {any | null} The cached data or null if not available/expired
 */
export const loadFromCache = (): any | null => {
  if (!fs.existsSync(CACHE_FILE)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cachedData: CachedData = JSON.parse(content);
    
    const age = Date.now() - cachedData.timestamp;
    if (age > CACHE_EXPIRY) {
      console.log("Cache is expired");
      return null;
    }
    
    console.log(`Loading distributor data from cache (age: ${Math.floor(age / 1000 / 60)} minutes)`);
    return cachedData.data;
  } catch (error) {
    console.error("Failed to load from cache:", error);
    return null;
  }
};

/**
 * Gets a fallback distributor configuration for emergency use
 * This contains known distributor contracts for each protocol
 */
export const getFallbackDistributors = () => {
  return {
    contracts: {
      "crv": [
        {
          "ecosystem": "Curve",
          "board": "0x82E9115174922c451Bc3901EE549B7E1744842f4",
          "distributor": "0x7fD488bF51F832cF3e91Ecb563E52B9b17743045",
          "bias": "0",
          "chainId": 1
        }
      ],
      "bal": [
        {
          "ecosystem": "Balancer",
          "board": "0x1Bf0eC8dc8F75256f4539a949848C3d6C4B2A4d3",
          "distributor": "0x47DD734471B17Ce7963Ea6133870833881548938",
          "bias": "0",
          "chainId": 1
        }
      ],
      "fxn": [
        {
          "ecosystem": "f(x) Protocol",
          "board": "0x09d89F16d8618CE16A1A31654c5B45d2f4aDD28C",
          "distributor": "0x8964c76B6f0253A77129D58cBA5D184d414d7C9a",
          "bias": "0",
          "chainId": 1
        }
      ]
    }
  };
};