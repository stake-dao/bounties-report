/*
1. Reading from latest month of folders : https://github.com/pendle-finance/merkle-distributions/tree/main/external-rewards/1
2. `campaign.json` : File containing details (need to take our rewards (DELEGATION) + the pool info (in extInfo assetId -)) (the token is TOKEN field)
3. Minus 15% of fees; for each token, generate a merkle tree -> based on holders from https://github.com/stake-dao/api/blob/main/api/strategies/pendle/holders/index.json; matched with timestamp on each token 
from `fromTimestamp` to `toTimestamp` (use historical + current holders)
*/

import axios from "axios";
import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";
import { MerkleData } from "../interfaces/MerkleData";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";

const PENDLE_MERKLE_DISTRIBUTIONS_API = "https://api.github.com/repos/pendle-finance/merkle-distributions/contents/external-rewards/1";
const STAKE_DAO_HOLDERS_API = "https://raw.githubusercontent.com/stake-dao/api/main/api/strategies/pendle/holders/index.json";
const FEE_PERCENTAGE = 0.15; // 15% fee
const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";

interface PendleCampaign {
  campaignId: string;
  token: string;
  amount: string;
  originalTotalAmount?: string;
  fromTimestamp: number;
  toTimestamp: number;
  users?: {
    [address: string]: string;
  };
  extInfo: {
    assetId: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface CurrentHolder {
  user: string;
  balance: string;
}

interface HistoricalHolder {
  user: string;
  entry_block: number;
  entry_ts: string;
  max_balance: string;
  exit_block?: number;
  exit_ts?: string;
  is_past_user: boolean;
}

interface PoolHolderEntry {
  id: string;
  lpt: string;
  lpt_symbol: string;
  holders: CurrentHolder[];
  holder_count: number;
  historical_data: HistoricalHolder[];
  past_users: HistoricalHolder[];
  total_unique_users: number;
  past_users_count: number;
}

interface HolderApiResponse {
  lp_holder: string;
  gauge_count: number;
  gauges: PoolHolderEntry[];
}

interface HolderData {
  address: string;
  balance: string;
  timestamp: number;
}



async function fetchCampaignData(folderName: string): Promise<PendleCampaign[]> {
  try {
    const campaignUrl = `https://raw.githubusercontent.com/pendle-finance/merkle-distributions/main/external-rewards/1/${folderName}/campaign.json`;
    console.log(`Fetching campaign data from: ${campaignUrl}`);
    
    const response = await axios.get(campaignUrl);
    
    // Check if the response has the expected structure
    if (!response.data || !response.data.distributions) {
      console.log("Campaign data does not have 'distributions' field");
      return [];
    }
    
    const distributions = response.data.distributions;
    if (!Array.isArray(distributions)) {
      console.log("Distributions is not an array");
      return [];
    }
    
    console.log(`Found ${distributions.length} total distributions in folder ${folderName}`);
    
    // Filter campaigns that have our delegation address in the users field
    const ourCampaigns: PendleCampaign[] = [];
    
    for (const distribution of distributions) {
      // Check if delegation address exists in users field (case-insensitive)
      const delegationKey = Object.keys(distribution.users || {}).find(
        key => key.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
      );
      
      if (delegationKey) {
        // Create a new campaign object with the delegation amount
        const delegationAmount = distribution.users[delegationKey];
        ourCampaigns.push({
          campaignId: `${folderName}-${distribution.extInfo?.assetId || 'unknown'}`,
          token: distribution.token,
          amount: delegationAmount, // Use delegation-specific amount
          originalTotalAmount: distribution.sumAmount, // Keep original total for reference
          fromTimestamp: distribution.fromTimestamp,
          toTimestamp: distribution.toTimestamp,
          users: distribution.users,
          extInfo: distribution.extInfo || { assetId: 'unknown' },
          description: distribution.description
        });
        console.log(`Found distribution for pool ${distribution.extInfo?.assetId} with delegation amount: ${delegationAmount}`);
      }
    }
    
    console.log(`Found ${ourCampaigns.length} distributions for delegation address`);
    return ourCampaigns;
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.error(`Campaign file not found for folder ${folderName}`);
      return [];
    }
    console.error("Error fetching campaign data:", error.message);
    throw error;
  }
}

async function fetchHolderData(): Promise<PoolHolderEntry[]> {
  try {
    const response = await axios.get<HolderApiResponse>(STAKE_DAO_HOLDERS_API);
    return response.data.gauges;
  } catch (error) {
    console.error("Error fetching holder data:", error);
    throw error;
  }
}

function getHoldersForPeriod(
  poolEntry: PoolHolderEntry,
  fromTimestamp: number,
  toTimestamp: number
): HolderData[] {
  const relevantHolders: Map<string, HolderData> = new Map();
  
  // Process historical holders
  poolEntry.historical_data.forEach(holder => {
    const entryTs = parseInt(holder.entry_ts);
    const exitTs = holder.exit_ts ? parseInt(holder.exit_ts) : Number.MAX_SAFE_INTEGER;
    
    // Check if holder was active during the period
    if (entryTs <= toTimestamp && exitTs >= fromTimestamp) {
      // Use the timestamp that's within our period
      const effectiveTimestamp = Math.max(entryTs, fromTimestamp);
      
      relevantHolders.set(holder.user, {
        address: holder.user,
        balance: holder.max_balance,
        timestamp: effectiveTimestamp
      });
    }
  });
  
  // Process current holders
  poolEntry.holders.forEach(holder => {
    // Current holders are assumed to be active now, so check if they were active during the period
    // We don't have exact entry timestamps for current holders, so we'll include them if they exist
    const existingHolder = relevantHolders.get(holder.user);
    
    // If this holder is not in historical data or has a more recent balance, update it
    if (!existingHolder || !poolEntry.historical_data.some(h => h.user === holder.user && !h.is_past_user)) {
      relevantHolders.set(holder.user, {
        address: holder.user,
        balance: holder.balance,
        timestamp: toTimestamp // Use end timestamp for current holders
      });
    }
  });
  
  return Array.from(relevantHolders.values());
}

function calculateRewards(
  holders: HolderData[],
  totalReward: bigint
): Map<string, bigint> {
  const rewards = new Map<string, bigint>();
  
  // Calculate total balance
  const totalBalance = holders.reduce((sum, holder) => {
    return sum + BigInt(holder.balance);
  }, BigInt(0));
  
  if (totalBalance === BigInt(0)) {
    return rewards;
  }
  
  // Apply fee (15%)
  const feeAmount = (totalReward * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
  const distributableReward = totalReward - feeAmount;
  
  // Distribute rewards proportionally
  holders.forEach(holder => {
    const holderBalance = BigInt(holder.balance);
    const holderReward = (distributableReward * holderBalance) / totalBalance;
    
    if (holderReward > BigInt(0)) {
      rewards.set(getAddress(holder.address), holderReward);
    }
  });
  
  return rewards;
}

function generateMerkleTree(distribution: UniversalMerkle): MerkleData {
  const elements: string[] = [];
  const values: { [address: string]: { [token: string]: string } } = {};
  
  // Create leaf nodes
  Object.entries(distribution).forEach(([address, tokens]) => {
    Object.entries(tokens).forEach(([token, amount]) => {
      const leaf = keccak256(
        Buffer.concat([
          Buffer.from(address.slice(2), "hex"),
          Buffer.from(token.slice(2), "hex"),
          Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex"),
        ])
      );
      elements.push(leaf.toString("hex"));
      
      if (!values[address]) {
        values[address] = {};
      }
      values[address][token] = amount;
    });
  });
  
  // Create merkle tree
  const merkleTree = new MerkleTree(elements, keccak256, { sortPairs: true });
  const root = merkleTree.getHexRoot();
  
  // Generate proofs
  const claims: any = {};
  Object.entries(values).forEach(([address, tokens]) => {
    claims[address] = {
      tokens: {},
    };
    
    Object.entries(tokens).forEach(([token, amount]) => {
      const leaf = keccak256(
        Buffer.concat([
          Buffer.from(address.slice(2), "hex"),
          Buffer.from(token.slice(2), "hex"),
          Buffer.from(BigInt(amount).toString(16).padStart(64, "0"), "hex"),
        ])
      );
      const proof = merkleTree.getHexProof(leaf);
      
      claims[address].tokens[token] = {
        amount,
        proof,
      };
    });
  });
  
  return {
    merkleRoot: root,
    claims,
  };
}

async function main() {
  try {
    console.log("Starting Pendle extra distribution processing...");
    console.log(`Looking for campaigns with delegation address: ${DELEGATION_ADDRESS}`);
    
    // Get all distribution folders
    const response = await axios.get(PENDLE_MERKLE_DISTRIBUTIONS_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'stake-dao-pendle-script'
      }
    });
    
    // Filter for directories only, excluding 'deprecated' folder
    const folders = response.data.filter((item: any) => 
      item.type === "dir" && item.name !== "deprecated"
    );
    
    // Sort folders by name in descending order
    folders.sort((a: any, b: any) => {
      const aNum = parseInt(a.name);
      const bNum = parseInt(b.name);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return bNum - aNum;
      }
      return b.name.localeCompare(a.name);
    });
    
    console.log(`\nFound ${folders.length} distribution folders. Checking each for delegation campaigns...`);
    
    let allCampaigns: PendleCampaign[] = [];
    
    // Check multiple folders and aggregate all campaigns
    const foundInFolders: string[] = [];
    
    for (const folder of folders.slice(0, 10)) { // Check up to 10 latest folders
      console.log(`\nChecking folder: ${folder.name}`);
      const campaigns = await fetchCampaignData(folder.name);
      
      if (campaigns.length > 0) {
        allCampaigns.push(...campaigns);
        foundInFolders.push(folder.name);
        console.log(`Found ${campaigns.length} campaigns in ${folder.name}`);
      }
    }
    
    if (allCampaigns.length === 0) {
      console.log("\nNo campaigns found for delegation address in any recent folders.");
      console.log("The delegation address might not have any Pendle reward allocations.");
      return;
    }
    
    console.log(`\nProcessing ${allCampaigns.length} campaigns from folders: ${foundInFolders.join(', ')}`);
    
    // Fetch holder data
    const allHolders = await fetchHolderData();
    
    // Process each campaign
    const allDistributions: UniversalMerkle = {};
    
    for (const campaign of allCampaigns) {
      console.log(`\nProcessing campaign ${campaign.campaignId}:`);
      console.log(`- Token: ${campaign.token}`);
      console.log(`- Delegation Amount: ${campaign.amount}`);
      if (campaign.originalTotalAmount) {
        console.log(`- Total Campaign Amount: ${campaign.originalTotalAmount}`);
      }
      console.log(`- Pool: ${campaign.extInfo.assetId}`);
      console.log(`- Period: ${new Date(campaign.fromTimestamp * 1000).toISOString()} to ${new Date(campaign.toTimestamp * 1000).toISOString()}`);
      
      // Extract the pool address from assetId (format: "1-0x8e1c2be682b0d3d8f8ee32024455a34cc724cf08")
      const assetIdParts = campaign.extInfo.assetId.split('-');
      const poolAddress = assetIdParts.length > 1 ? assetIdParts[1] : campaign.extInfo.assetId;
      
      // Find the matching pool holder entry by lpt address
      const poolHolderEntry = allHolders.find(entry => {
        // Match either by full lpt or just the address part after the hyphen
        const lptAddress = entry.lpt.includes('-') ? entry.lpt.split('-')[1] : entry.lpt;
        return lptAddress.toLowerCase() === poolAddress.toLowerCase();
      });
      
      if (!poolHolderEntry) {
        console.warn(`No holder data found for pool ${poolAddress}`);
        continue;
      }
      
      console.log(`Found holder data for pool: ${poolHolderEntry.lpt_symbol}`);
      
      // Get holders for the campaign period
      const periodHolders = getHoldersForPeriod(
        poolHolderEntry,
        campaign.fromTimestamp,
        campaign.toTimestamp
      );
      
      console.log(`Found ${periodHolders.length} holders for the period`);
      
      // Calculate rewards
      const totalReward = BigInt(campaign.amount);
      const rewards = calculateRewards(periodHolders, totalReward);
      
      // Add to distribution
      rewards.forEach((amount, address) => {
        if (!allDistributions[address]) {
          allDistributions[address] = {};
        }
        
        const tokenAddress = getAddress(campaign.token);
        if (!allDistributions[address][tokenAddress]) {
          allDistributions[address][tokenAddress] = "0";
        }
        
        // Add to existing amount
        const currentAmount = BigInt(allDistributions[address][tokenAddress]);
        allDistributions[address][tokenAddress] = (currentAmount + amount).toString();
      });
    }
    
    // Generate merkle tree
    console.log("\nGenerating merkle tree...");
    const merkleData = generateMerkleTree(allDistributions);
    
    // Save results
    const outputDir = path.join(__dirname, "../../data/pendle-extra");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const timestamp = Math.floor(Date.now() / 1000);
    const outputPath = path.join(outputDir, `distribution_${timestamp}.json`);
    
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp,
          folderNames: foundInFolders,
          merkleRoot: merkleData.merkleRoot,
          distribution: allDistributions,
          claims: merkleData.claims,
        },
        null,
        2
      )
    );
    
    console.log(`\nDistribution saved to: ${outputPath}`);
    console.log(`Merkle root: ${merkleData.merkleRoot}`);
    console.log(`Total recipients: ${Object.keys(allDistributions).length}`);
    
    // Summary by token
    const tokenSummary: { [token: string]: bigint } = {};
    Object.values(allDistributions).forEach(tokens => {
      Object.entries(tokens).forEach(([token, amount]) => {
        if (!tokenSummary[token]) {
          tokenSummary[token] = BigInt(0);
        }
        tokenSummary[token] += BigInt(amount);
      });
    });
    
    console.log("\nToken distribution summary:");
    Object.entries(tokenSummary).forEach(([token, total]) => {
      console.log(`- ${token}: ${total.toString()}`);
    });
    
  } catch (error) {
    console.error("Error in main process:", error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}


