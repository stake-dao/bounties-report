import axios from "axios";
import { createPublicClient, http, parseAbi, decodeEventLog, getAddress, pad, keccak256, encodePacked } from "viem";
import { mainnet } from "viem/chains";
import { createBlockchainExplorerUtils } from "../explorerUtils";

const BOTMARKET = getAddress("0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF");

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
  
  // Step 1: Fetch distributor contracts from copilot API
  const copilotResponse = await axios.get("https://api.paladin.vote/quest/v3/copilot");
  const distributorsByProtocol: {[protocol: string]: DistributorContract[]} = copilotResponse.data.contracts;
  
  // Step 2: Fetch quest data for each protocol
  const questsByProtocol: {[protocol: string]: QuestData[]} = {};
  const protocols = Object.keys(distributorsByProtocol);
  
  for (const protocol of protocols) {
    try {
      const platformResponse = await axios.get(`https://api.paladin.vote/quest/v3/copilot/platform/${protocol}`);
      questsByProtocol[protocol] = platformResponse.data.quests.active || [];
    } catch (error) {
      console.log(`No active quests for protocol ${protocol}`);
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
        const logsResponse = await ethUtils.getLogsByAddressAndTopics(
          distributor.distributor,
          block_min,
          block_max,
          { "0": claimedEventHash, "3": paddedBotmarket },
          1
        );
        
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
    let index = 0;
    
    for (const bounty of bounties) {
      // Find matching quest
      const matchingQuest = quests.find(q => q.questID.toString() === bounty.questID);
      
      if (matchingQuest) {
        bounty.gauge = matchingQuest.gauge;
      }
      
      protocolBounties[protocol][index.toString()] = bounty;
      index++;
    }
  }
  
  return protocolBounties;
};