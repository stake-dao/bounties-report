import axios from "axios";
import { createPublicClient, http, parseAbi, decodeEventLog, getAddress, pad, keccak256, encodePacked } from "viem";
import { mainnet } from "../chains";
import { createBlockchainExplorerUtils } from "../explorerUtils";
import { saveToCache, loadFromCache, getFallbackDistributors } from "./wardenCache";

const BOTMARKET = getAddress("0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF");

// Quest Board ABI for fetching quest data on-chain (fallback when API doesn't have ended quests)
const QUEST_BOARD_ABI = parseAbi([
  "function quests(uint256 questID) view returns (address creator, address rewardToken, address gauge, uint48 duration, uint48 periodStart, uint48 totalRewardAmount, uint256 minRPV, uint256 maxRPV, uint256 minObjective, uint256 maxObjective, uint8 closeScenario, uint8 status)"
]);

/**
 * Fetches gauge address from Quest Board contract on-chain
 * Used as fallback when the quest is not in the active quests API response
 */
const fetchGaugeOnChain = async (
  boardAddress: string,
  questID: string
): Promise<string | null> => {
  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }

      const client = createPublicClient({
        chain: mainnet,
        transport: http(),
      });

      const result = await client.readContract({
        address: boardAddress as `0x${string}`,
        abi: QUEST_BOARD_ABI,
        functionName: "quests",
        args: [BigInt(questID)],
      });

      // result[2] is the gauge address
      const gauge = result[2] as string;
      if (gauge && gauge !== "0x0000000000000000000000000000000000000000") {
        console.log(`Found gauge on-chain for quest ${questID}: ${gauge}`);
        return getAddress(gauge);
      }
      return null;
    } catch (error) {
      lastError = error;
      console.warn(`[Retry ${attempt + 1}/${maxRetries}] Failed to fetch gauge on-chain for quest ${questID}:`, error);
    }
  }

  console.error(`Failed to fetch gauge on-chain for quest ${questID} after ${maxRetries} retries:`, lastError);
  return null;
};

interface WardenBounty {
  amount: string;
  rewardToken: string;
  gauge: string;
  questID: string;
  period: string;
  distributor: string;
}

interface QuestData {
  id: number;
  questID: number;
  board: string;
  chainId: number;
  gauge: string;
  rewardToken: string;
  duration: number;
  start: number;
  permissions: number;
  closeScenario: number;
  rpw: string;
  minRPV: string;
  maxRPV: string;
  minObjective: string;
  maxObjective: string;
  permissionsList: string[];
}

interface DistributorContract {
  ecosystem: string;
  board: string;
  distributor: string;
  bias: string;
  chainId: number;
}

/**
 * Helper function to make API calls with retry logic
 * @param {string} url - The URL to fetch
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} retryDelay - Delay between retries in milliseconds
 * @returns {Promise<any>} The response data
 */
const fetchWithRetry = async (url: string, maxRetries: number = 3, retryDelay: number = 5000): Promise<any> => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempting to fetch ${url} (attempt ${attempt}/${maxRetries})`);
      const response = await axios.get(url, {
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'Bounties-Report/1.0',
          'Accept': 'application/json',
        }
      });
      return response.data;
    } catch (error: any) {
      lastError = error;
      console.error(`Attempt ${attempt} failed for ${url}:`, error.message);
      
      if (error.response) {
        console.error(`Response status: ${error.response.status}`);
        console.error(`Response data:`, error.response.data);
      }
      
      if (attempt < maxRetries) {
        console.log(`Waiting ${retryDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
};

/**
 * Converts v2 API response to v3 format
 * @param {any} v2Data - The v2 API response
 * @returns {any} Data in v3 format
 */
const convertV2ToV3Format = (v2Data: any): any => {
  // V2 has 'quest' field, V3 has 'contracts' field
  return {
    ...v2Data,
    contracts: v2Data.quest || {}
  };
};

/**
 * Fetches claimed bounties from Warden using the new API structure
 * @param {number} block_min - The minimum block number for the query range
 * @param {number} block_max - The maximum block number for the query range
 * @returns {Promise<{[protocol: string]: {[index: string]: WardenBounty}}>} A mapping of protocol names to their respective claimed bounties
 */
export const fetchWardenClaimedBounties = async (
  block_min: number,
  block_max: number
): Promise<{[protocol: string]: {[index: string]: WardenBounty}}> => {
  const ethUtils = createBlockchainExplorerUtils();
  
  let distributorsByProtocol: {[protocol: string]: DistributorContract[]} = {};
  let copilotData: any = null;
  
  try {
    // Step 1: Try to fetch distributor contracts from copilot API v3 with retry logic
    copilotData = await fetchWithRetry("https://api.paladin.vote/quest/v3/copilot");
    distributorsByProtocol = copilotData.contracts || {};
    
    // Save to cache for future use
    if (copilotData) {
      saveToCache(copilotData);
    }
  } catch (v3Error) {
    console.error("Failed to fetch from v3 API:", v3Error);
    
    // Try v2 API as fallback
    try {
      console.log("Attempting to use v2 API as fallback...");
      const v2Data = await fetchWithRetry("https://api.paladin.vote/quest/v2/copilot", 2, 3000);
      copilotData = convertV2ToV3Format(v2Data);
      distributorsByProtocol = copilotData.contracts || {};
      
      // Save converted data to cache
      if (copilotData) {
        saveToCache(copilotData);
      }
    } catch (v2Error) {
      console.error("Failed to fetch from v2 API as well:", v2Error);
      
      // Try to load from cache
      const cachedData = loadFromCache();
      if (cachedData) {
        console.log("Using cached distributor data");
        copilotData = cachedData;
        distributorsByProtocol = cachedData.contracts || {};
      } else {
        // Use fallback configuration
        console.log("Using fallback distributor configuration");
        copilotData = getFallbackDistributors();
        distributorsByProtocol = copilotData.contracts || {};
      }
    }
  }
  
  // If we still have no distributors, return empty result
  if (Object.keys(distributorsByProtocol).length === 0) {
    console.error("No distributor contracts available");
    return {};
  }
  
  // Step 2: Fetch quest data for each protocol
  const questsByProtocol: {[protocol: string]: QuestData[]} = {};
  const protocols = Object.keys(distributorsByProtocol);
  
  for (const protocol of protocols) {
    try {
      const platformData = await fetchWithRetry(
        `https://api.paladin.vote/quest/v3/copilot/platform/${protocol}`,
        2, // Fewer retries for individual protocols
        3000 // Shorter delay
      );
      questsByProtocol[protocol] = platformData.quests?.active || [];
    } catch (error) {
      console.log(`No active quests for protocol ${protocol} (API error or no data)`);
      questsByProtocol[protocol] = [];
    }
  }
  
  // Step 3: Fetch Claimed events from all distributor contracts
  const eventSignature = "Claimed(uint256,uint256,uint256,uint256,address,address)";
  const claimedEventHash = keccak256(encodePacked(["string"], [eventSignature]));
  const paddedBotmarket = pad(BOTMARKET as `0x${string}`, { size: 32 }).toLowerCase();
  
  const claimedEventAbi = parseAbi([
    "event Claimed(uint256 indexed questID,uint256 indexed period,uint256 index,uint256 amount,address rewardToken,address indexed account)",
  ]);
  
  const allClaimedBounties: {[protocol: string]: WardenBounty[]} = {};
  
  // Process each protocol's distributors
  for (const [protocol, distributors] of Object.entries(distributorsByProtocol)) {
    allClaimedBounties[protocol] = [];
    
    // Only process mainnet distributors (chainId 1)
    const mainnetDistributors = distributors.filter(d => d.chainId === 1);
    
    for (const distributor of mainnetDistributors) {
      try {
        let logsResponse;
        try {
          logsResponse = await ethUtils.getLogsByAddressAndTopics(
            distributor.distributor,
            block_min,
            block_max,
            { "0": claimedEventHash, "3": paddedBotmarket },
            1
          );
        } catch (logError) {
          console.error(`Failed to fetch logs for distributor ${distributor.distributor}:`, logError);
          continue;
        }
        
        if (!logsResponse || !logsResponse.result || logsResponse.result.length === 0) {
          continue;
        }
        
        for (const log of logsResponse.result) {
          const decodedLog = decodeEventLog({
            abi: claimedEventAbi,
            data: log.data,
            topics: log.topics,
            strict: false,
          });
          
          // Verify it's for our bot market account
          if (
            decodedLog.args.account &&
            getAddress(decodedLog.args.account.toLowerCase()) !== getAddress(BOTMARKET.toLowerCase())
          ) {
            continue;
          }
          
          const wardenBounty: WardenBounty = {
            amount: decodedLog.args.amount.toString(),
            rewardToken: getAddress(decodedLog.args.rewardToken as string),
            gauge: "", // Will be filled from quest data
            questID: decodedLog.args.questID.toString(),
            period: decodedLog.args.period.toString(),
            distributor: getAddress(log.address),
          };
          
          allClaimedBounties[protocol].push(wardenBounty);
        }
      } catch (error) {
        console.error(`Error fetching logs for distributor ${distributor.distributor}:`, error);
      }
    }
  }
  
  // Step 4: Match questIds with gauge information
  const protocolBounties: {[protocol: string]: {[index: string]: WardenBounty}} = {};

  for (const [protocol, bounties] of Object.entries(allClaimedBounties)) {
    if (!protocolBounties[protocol]) {
      protocolBounties[protocol] = {};
    }

    const quests = questsByProtocol[protocol] || [];
    const distributors = distributorsByProtocol[protocol] || [];
    // Get board address for on-chain fallback (use first mainnet distributor's board)
    const mainnetDistributor = distributors.find(d => d.chainId === 1);
    const boardAddress = mainnetDistributor?.board;

    let index = 0;

    for (const bounty of bounties) {
      // Find matching quest from API
      const matchingQuest = quests.find(q => q.questID.toString() === bounty.questID);

      if (matchingQuest) {
        bounty.gauge = matchingQuest.gauge;
      } else if (boardAddress) {
        // Fallback: fetch gauge on-chain for ended/inactive quests
        console.log(`Quest ${bounty.questID} not found in active quests, fetching gauge on-chain...`);
        const onChainGauge = await fetchGaugeOnChain(boardAddress, bounty.questID);
        if (onChainGauge) {
          bounty.gauge = onChainGauge;
        }
      }

      protocolBounties[protocol][index.toString()] = bounty;
      index++;
    }
  }

  return protocolBounties;
};