import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import crypto from "crypto";

const PENDLE_MERKLE_DISTRIBUTIONS_API = "https://api.github.com/repos/pendle-finance/merkle-distributions/contents/external-rewards/1";
const STAKE_DAO_API_BASE = "http://localhost:3000/strategies/pendle/holders";
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

interface PeriodHolder {
  user: string;
  holding_duration_days: number;
  max_balance_in_period: string;
  is_current_holder: boolean;
  entry_date: string;
  exit_date: string | null;
}

interface GaugePeriodData {
  gauge_id: string;
  token: {
    address: string;
    symbol: string;
  };
  holders_in_period: number;
  holders: PeriodHolder[];
}

interface PeriodResponse {
  period: {
    start: string;
    end: string;
  };
  gauges: GaugePeriodData[];
}

interface UniversalMerkle {
  [address: string]: {
    [token: string]: string;
  };
}

interface MerkleData {
  merkleRoot: string;
  claims: any;
}

// Simple keccak256 implementation
function keccak256(data: Buffer): Buffer {
  return crypto.createHash('sha3-256').update(data).digest();
}

// Simple MerkleTree implementation
class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(leaves: string[], hashFn: (data: Buffer) => Buffer, options?: { sortPairs?: boolean }) {
    this.leaves = leaves.map(leaf => Buffer.from(leaf, 'hex'));
    if (options?.sortPairs) {
      this.leaves.sort(Buffer.compare);
    }
    this.layers = [this.leaves];
    this.createTree(hashFn);
  }

  private createTree(hashFn: (data: Buffer) => Buffer) {
    let currentLayer = this.leaves;
    while (currentLayer.length > 1) {
      const nextLayer: Buffer[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 === currentLayer.length) {
          nextLayer.push(currentLayer[i]);
        } else {
          const left = currentLayer[i];
          const right = currentLayer[i + 1];
          const combined = Buffer.compare(left, right) < 0 
            ? Buffer.concat([left, right])
            : Buffer.concat([right, left]);
          nextLayer.push(hashFn(combined));
        }
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getHexRoot(): string {
    if (this.layers.length === 0 || this.layers[this.layers.length - 1].length === 0) {
      return '0x0000000000000000000000000000000000000000000000000000000000000000';
    }
    return '0x' + this.layers[this.layers.length - 1][0].toString('hex');
  }

  getHexProof(leaf: Buffer): string[] {
    const proof: string[] = [];
    let index = this.leaves.findIndex(l => l.equals(leaf));
    
    if (index === -1) return proof;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const pairIndex = isRightNode ? index - 1 : index + 1;

      if (pairIndex < layer.length) {
        proof.push('0x' + layer[pairIndex].toString('hex'));
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }
}

async function fetchCampaignData(folderName: string): Promise<PendleCampaign[]> {
  try {
    const campaignUrl = `https://raw.githubusercontent.com/pendle-finance/merkle-distributions/main/external-rewards/1/${folderName}/campaign.json`;
    console.log(`Fetching campaign data from: ${campaignUrl}`);
    
    const response = await fetch(campaignUrl);
    if (!response.ok) {
      if (response.status === 404) {
        console.error(`Campaign file not found for folder ${folderName}`);
        return [];
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Check if the response has the expected structure
    if (!data || !data.distributions) {
      console.log("Campaign data does not have 'distributions' field");
      return [];
    }
    
    const distributions = data.distributions;
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
    console.error("Error fetching campaign data:", error.message);
    throw error;
  }
}

async function fetchHoldersForPeriod(
  tokenAddress: string,
  fromTimestamp: number,
  toTimestamp: number
): Promise<PeriodHolder[]> {
  try {
    // Convert timestamps to ISO date strings
    const startDate = new Date(fromTimestamp * 1000).toISOString().split('T')[0];
    const endDate = new Date(toTimestamp * 1000).toISOString().split('T')[0];
    
    console.log(`Fetching holders for token ${tokenAddress} from ${startDate} to ${endDate}`);
    
    const url = new URL(`${STAKE_DAO_API_BASE}/period`);
    url.searchParams.append('start_date', startDate);
    url.searchParams.append('end_date', endDate);
    url.searchParams.append('token', tokenAddress);
    
    console.log(`API URL: ${url.toString()}`);
    
    const response = await fetch(url.toString());
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error Response: ${errorText}`);
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data: PeriodResponse = await response.json();
    
    if (!data.gauges || data.gauges.length === 0) {
      console.log(`No gauge found for token ${tokenAddress}`);
      return [];
    }
    
    // Should only have one gauge for a specific token
    const gauge = data.gauges[0];
    console.log(`Found ${gauge.holders_in_period} holders for ${gauge.token.symbol}`);
    
    return gauge.holders || [];
  } catch (error: any) {
    console.error(`Error fetching holders for token ${tokenAddress}:`, error.message);
    if (error.cause) {
      console.error(`Cause:`, error.cause);
    }
    return [];
  }
}

function calculateRewards(
  holders: PeriodHolder[],
  totalReward: bigint,
  campaignFromTimestamp: number,
  campaignToTimestamp: number
): Map<string, bigint> {
  const rewards = new Map<string, bigint>();
  
  // Calculate campaign duration in days
  const campaignDurationDays = (campaignToTimestamp - campaignFromTimestamp) / (24 * 60 * 60);
  
  // Calculate total time-weighted balance (TWAP)
  const totalTimeWeightedBalance = holders.reduce((sum, holder) => {
    const holderBalance = BigInt(holder.max_balance_in_period);
    // Use holding_duration_days for time weighting
    // If holding_duration_days is greater than campaign duration, cap it
    const effectiveDays = Math.min(holder.holding_duration_days, campaignDurationDays);
    const timeWeightedBalance = holderBalance * BigInt(Math.floor(effectiveDays * 10000)) / BigInt(Math.floor(campaignDurationDays * 10000));
    return sum + timeWeightedBalance;
  }, BigInt(0));
  
  if (totalTimeWeightedBalance === BigInt(0)) {
    return rewards;
  }
  
  // Apply fee (15%)
  const feeAmount = (totalReward * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
  const distributableReward = totalReward - feeAmount;
  
  // Distribute rewards proportionally based on time-weighted balance
  holders.forEach(holder => {
    const holderBalance = BigInt(holder.max_balance_in_period);
    // Calculate time-weighted balance for this holder
    const effectiveDays = Math.min(holder.holding_duration_days, campaignDurationDays);
    const timeWeightedBalance = holderBalance * BigInt(Math.floor(effectiveDays * 10000)) / BigInt(Math.floor(campaignDurationDays * 10000));
    
    const holderReward = (distributableReward * timeWeightedBalance) / totalTimeWeightedBalance;
    
    if (holderReward > BigInt(0)) {
      rewards.set(getAddress(holder.user), holderReward);
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
    const response = await fetch(PENDLE_MERKLE_DISTRIBUTIONS_API, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'stake-dao-pendle-script'
      }
    });
    
    if (!response.ok) {
      throw new Error(`GitHub API error! status: ${response.status}`);
    }
    
    const folders = await response.json();
    
    // Filter for directories only, excluding 'deprecated' folder
    const validFolders = folders.filter((item: any) => 
      item.type === "dir" && item.name !== "deprecated"
    );
    
    // Sort folders by name in descending order
    validFolders.sort((a: any, b: any) => {
      const aNum = parseInt(a.name);
      const bNum = parseInt(b.name);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return bNum - aNum;
      }
      return b.name.localeCompare(a.name);
    });
    
    console.log(`\nFound ${validFolders.length} distribution folders. Checking each for delegation campaigns...`);
    
    let allCampaigns: PendleCampaign[] = [];
    
    // Check multiple folders and aggregate all campaigns
    const foundInFolders: string[] = [];
    
    for (const folder of validFolders.slice(0, 10)) { // Check up to 10 latest folders
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
      
      // Extract the token address from assetId (format: "1-0x8e1c2be682b0d3d8f8ee32024455a34cc724cf08")
      const assetIdParts = campaign.extInfo.assetId.split('-');
      if (assetIdParts.length !== 2) {
        console.warn(`Invalid assetId format: ${campaign.extInfo.assetId}`);
        continue;
      }
      
      const chainId = assetIdParts[0];
      const tokenAddress = assetIdParts[1];
      
      console.log(`- Chain ID: ${chainId}`);
      console.log(`- Token Address: ${tokenAddress}`);
      
      // Fetch holders for the period using the new API
      const periodHolders = await fetchHoldersForPeriod(
        tokenAddress,
        campaign.fromTimestamp,
        campaign.toTimestamp
      );
      
      if (periodHolders.length === 0) {
        console.warn(`No holders found for token ${tokenAddress} in the specified period`);
        continue;
      }
      
      console.log(`Found ${periodHolders.length} holders for the period`);
      
      // Calculate rewards
      const totalReward = BigInt(campaign.amount);
      const rewards = calculateRewards(periodHolders, totalReward, campaign.fromTimestamp, campaign.toTimestamp);
      
      console.log(`Calculated rewards for ${rewards.size} holders after applying ${FEE_PERCENTAGE * 100}% fee`);
      
      // Add to distribution
      rewards.forEach((amount, address) => {
        if (!allDistributions[address]) {
          allDistributions[address] = {};
        }
        
        const rewardTokenAddress = getAddress(campaign.token);
        if (!allDistributions[address][rewardTokenAddress]) {
          allDistributions[address][rewardTokenAddress] = "0";
        }
        
        // Add to existing amount
        const currentAmount = BigInt(allDistributions[address][rewardTokenAddress]);
        allDistributions[address][rewardTokenAddress] = (currentAmount + amount).toString();
      });
    }
    
    // Check if we have any distributions
    if (Object.keys(allDistributions).length === 0) {
      console.log("\nNo distributions to process. No holders found for any campaigns.");
      return;
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