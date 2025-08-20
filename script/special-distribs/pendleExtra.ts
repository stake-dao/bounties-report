import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { generateMerkleTree } from "../vlCVX/utils";

const PENDLE_MERKLE_DISTRIBUTIONS_API = "https://api.github.com/repos/pendle-finance/merkle-distributions/contents/external-rewards/1";
const GITHUB_HOLDERS_DATA_URL = "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/strategies/pendle/holders/index.json";
const FEE_PERCENTAGE = 0.15; // 15% fee
const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";
const FEE_RECIPIENT = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";

interface PendleCampaign {
  campaignId: string;
  token: string;
  amount: string;
  fromTimestamp: number;
  toTimestamp: number;
  extInfo: {
    assetId: string;
  };
}

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

// Cache for token info to avoid repeated fetches
const tokenInfoCache: { [address: string]: TokenInfo } = {};

// Minimal ERC20 ABI for symbol and decimals
const ERC20_ABI = [
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    type: "function"
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function"
  }
];

async function fetchTokenInfo(address: string): Promise<TokenInfo> {
  const checksumAddress = getAddress(address);
  
  // Check cache first
  if (tokenInfoCache[checksumAddress.toLowerCase()]) {
    return tokenInfoCache[checksumAddress.toLowerCase()];
  }
  
  try {
    // Use ethers.js to fetch token info
    const ethers = await import("ethers");
    const provider = new ethers.providers.JsonRpcProvider("https://eth.llamarpc.com");
    const contract = new ethers.Contract(checksumAddress, ERC20_ABI, provider);
    
    // Fetch symbol and decimals in parallel
    const [symbol, decimals] = await Promise.all([
      contract.symbol().catch(() => "???"),
      contract.decimals().catch(() => 18)
    ]);
    
    const tokenInfo: TokenInfo = {
      address: checksumAddress,
      symbol: symbol,
      decimals: Number(decimals)
    };
    
    // Cache the result
    tokenInfoCache[checksumAddress.toLowerCase()] = tokenInfo;
    
    return tokenInfo;
  } catch (error) {
    console.warn(`Failed to fetch token info for ${checksumAddress}, using defaults`);
    const fallback = {
      address: checksumAddress,
      symbol: checksumAddress.slice(0, 6) + "...",
      decimals: 18
    };
    tokenInfoCache[checksumAddress.toLowerCase()] = fallback;
    return fallback;
  }
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  // Format with 4 decimal places
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').slice(0, 4);
  return `${wholePart.toString()}.${fractionalStr}`;
}

interface HoldersData {
  metadata: {
    total_gauges: number;
  };
  gauges: Array<{
    gauge_id: string;
    token: {
      address: string;
      symbol: string;
    };
    user_histories: {
      [address: string]: {
        events: Array<{
          type: string;
          amount: string;
          balance_after: string;
          block: number;
          timestamp: number;
          datetime: string;
        }>;
      };
    };
  }>;
}

interface PeriodHolder {
  user: string;
  time_weighted_balance: string; // Accurate TWAP from events
}



async function fetchCampaignData(folderName: string): Promise<PendleCampaign[]> {
  try {
    const campaignUrl = `https://raw.githubusercontent.com/pendle-finance/merkle-distributions/main/external-rewards/1/${folderName}/campaign.json`;
    
    const response = await fetch(campaignUrl);
    if (!response.ok) {
      if (response.status === 404) {
        return [];
      }
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Check if the response has the expected structure
    if (!data || !data.distributions) {
      return [];
    }
    
    const distributions = data.distributions;
    if (!Array.isArray(distributions)) {
      return [];
    }
    
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
          campaignId: `${folderName}-${distribution.extInfo?.assetId || 'unknown'}-${distribution.token}`,
          token: distribution.token,
          amount: delegationAmount, // Use delegation-specific amount
          fromTimestamp: distribution.fromTimestamp,
          toTimestamp: distribution.toTimestamp,
          extInfo: distribution.extInfo || { assetId: 'unknown' }
        });
      }
    }
    
    return ourCampaigns;
  } catch (error: any) {
    console.error("Error fetching campaign data:", error.message);
    throw error;
  }
}

async function fetchHoldersData(): Promise<HoldersData> {
  try {
    const response = await fetch(GITHUB_HOLDERS_DATA_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data: HoldersData = await response.json();
    return data;
  } catch (error: any) {
    console.error(`Error fetching holders data:`, error.message);
    throw error;
  }
}

/**
 * Get the exact balance of a user at a specific timestamp based on events
 */
function getBalanceAtTimestamp(
  events: Array<{
    type: string;
    amount: string;
    balance_after: string;
    block: number;
    timestamp: number;
    datetime: string;
  }>,
  targetTimestamp: number
): bigint {
  // Sort events by timestamp
  const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
  
  // Find the last event before or at the target timestamp
  let balance = BigInt(0);
  
  for (const event of sortedEvents) {
    if (event.timestamp <= targetTimestamp) {
      balance = BigInt(event.balance_after);
    } else {
      break;
    }
  }
  
  return balance;
}

/**
 * Calculate time-weighted average balance for a period using events
 */
function calculateTimeWeightedBalance(
  events: Array<{
    type: string;
    amount: string;
    balance_after: string;
    block: number;
    timestamp: number;
    datetime: string;
  }>,
  periodStart: number,
  periodEnd: number
): bigint {
  // Sort events by timestamp
  const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
  
  // Get balance at period start
  let currentBalance = getBalanceAtTimestamp(sortedEvents, periodStart);
  let lastTimestamp = periodStart;
  let weightedSum = BigInt(0);
  
  // Process events within the period
  for (const event of sortedEvents) {
    if (event.timestamp > periodStart && event.timestamp <= periodEnd) {
      // Add weighted balance for the time before this event
      const timeDiff = BigInt(event.timestamp - lastTimestamp);
      weightedSum += currentBalance * timeDiff;
      
      // Update current balance and timestamp
      currentBalance = BigInt(event.balance_after);
      lastTimestamp = event.timestamp;
    }
  }
  
  // Add weighted balance for the remaining time until period end
  const finalTimeDiff = BigInt(periodEnd - lastTimestamp);
  weightedSum += currentBalance * finalTimeDiff;
  
  // Calculate average (total weighted sum / total time)
  const totalTime = BigInt(periodEnd - periodStart);
  if (totalTime === BigInt(0)) {
    return BigInt(0);
  }
  
  return weightedSum / totalTime;
}

function getHoldersForPeriod(
  holdersData: HoldersData,
  tokenAddress: string,
  fromTimestamp: number,
  toTimestamp: number
): PeriodHolder[] {
  // Find the gauge for this token
  const gauge = holdersData.gauges.find(g => 
    g.token.address.toLowerCase() === tokenAddress.toLowerCase()
  );
  
  if (!gauge) {
    return [];
  }
  
  const periodHolders: PeriodHolder[] = [];
  
  // Process user histories to find holders during the campaign period
  Object.entries(gauge.user_histories).forEach(([userAddress, history]) => {
    // Check if user had any balance during the campaign period using events
    const balanceAtStart = getBalanceAtTimestamp(history.events, fromTimestamp);
    const balanceAtEnd = getBalanceAtTimestamp(history.events, toTimestamp);
    
    // Check if there were any events during the period
    const eventsInPeriod = history.events.filter(
      event => event.timestamp >= fromTimestamp && event.timestamp <= toTimestamp
    );
    
    // User was holding if they had balance at start, end, or any events during period
    const wasHoldingDuringPeriod = balanceAtStart > BigInt(0) || 
                                   balanceAtEnd > BigInt(0) || 
                                   eventsInPeriod.length > 0;
    
    if (wasHoldingDuringPeriod) {
      // Calculate time-weighted average balance for the period
      const timeWeightedBalance = calculateTimeWeightedBalance(
        history.events,
        fromTimestamp,
        toTimestamp
      );
      
      periodHolders.push({
        user: userAddress,
        time_weighted_balance: timeWeightedBalance.toString()
      });
    }
  });
  
  return periodHolders;
}

function calculateRewards(
  holders: PeriodHolder[],
  totalReward: bigint
): { rewards: Map<string, bigint>, totalFees: bigint } {
  const rewards = new Map<string, bigint>();
  
  // Calculate total time-weighted balance using the pre-calculated values
  const totalTimeWeightedBalance = holders.reduce((sum, holder) => {
    return sum + BigInt(holder.time_weighted_balance);
  }, BigInt(0));
  
  if (totalTimeWeightedBalance === BigInt(0)) {
    return { rewards, totalFees: BigInt(0) };
  }
  
  // Apply fee to total reward
  const feeAmount = (totalReward * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
  const distributableAmount = totalReward - feeAmount;
  
  // Distribute rewards proportionally based on time-weighted balance
  holders.forEach(holder => {
    const holderTimeWeightedBalance = BigInt(holder.time_weighted_balance);
    const holderReward = (distributableAmount * holderTimeWeightedBalance) / totalTimeWeightedBalance;
    
    if (holderReward > BigInt(0)) {
      const userAddress = getAddress(holder.user);
      rewards.set(userAddress, holderReward);
    }
  });
  
  return { rewards, totalFees: feeAmount };
}



async function main() {
  try {
    console.log("Starting Pendle extra distribution processing...");
    
    // Load existing merkle data if it exists
    const outputDir = path.join(__dirname, "../../data/extra_merkle");
    const existingMerklePath = path.join(outputDir, "merkle.json");
    const processedCampaignsPath = path.join(outputDir, "processed_campaigns.json");
    
    let existingDistributions: UniversalMerkle = {};
    let processedCampaigns: Set<string> = new Set();
    
    // Load existing merkle to get current distributions
    if (fs.existsSync(existingMerklePath)) {
      try {
        const existingMerkle = JSON.parse(fs.readFileSync(existingMerklePath, 'utf8'));
        // Extract distributions from claims
        if (existingMerkle.claims) {
          Object.entries(existingMerkle.claims).forEach(([address, claim]: [string, any]) => {
            existingDistributions[address] = {};
            if (claim.tokens) {
              Object.entries(claim.tokens).forEach(([token, tokenData]: [string, any]) => {
                // Extract just the amount from the token data
                existingDistributions[address][token] = tokenData.amount || tokenData;
              });
            }
          });
        }
        console.log(`Loaded existing distributions with ${Object.keys(existingDistributions).length} recipients`);
      } catch (error) {
        console.log("Could not load existing merkle data, starting fresh");
      }
    }
    
    // Load processed campaigns
    if (fs.existsSync(processedCampaignsPath)) {
      try {
        const processedData = JSON.parse(fs.readFileSync(processedCampaignsPath, 'utf8'));
        if (processedData.processedCampaigns && Array.isArray(processedData.processedCampaigns)) {
          processedData.processedCampaigns.forEach((campaignId: string) => {
            processedCampaigns.add(campaignId);
          });
          console.log(`Found ${processedCampaigns.size} already processed campaigns`);
        }
      } catch (error) {
        console.log("Could not load processed campaigns data");
      }
    }
    
    // Fetch holders data once
    const holdersData = await fetchHoldersData();
    
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
    
    let allCampaigns: PendleCampaign[] = [];
    
    // Check multiple folders and aggregate all campaigns
    const foundInFolders: string[] = [];
    
    for (const folder of validFolders.slice(0, 10)) { // Check up to 10 latest folders
      const campaigns = await fetchCampaignData(folder.name);
      
      if (campaigns.length > 0) {
        allCampaigns.push(...campaigns);
        foundInFolders.push(folder.name);
      }
    }
    
    if (allCampaigns.length === 0) {
      console.log("No campaigns found for delegation address.");
      return;
    }
    
    // Filter out already processed campaigns
    const newCampaigns = allCampaigns.filter(campaign => !processedCampaigns.has(campaign.campaignId));
    const skippedCampaigns = allCampaigns.filter(campaign => processedCampaigns.has(campaign.campaignId));
    
    if (skippedCampaigns.length > 0) {
      console.log(`\nSkipping ${skippedCampaigns.length} already processed campaigns`);
    }
    
    if (newCampaigns.length === 0) {
      console.log("\nNo new campaigns to process.");
      return;
    }
    
    console.log(`\nProcessing ${newCampaigns.length} NEW campaigns:`);
    
    // Show new campaigns with their delegation amounts
    for (const campaign of newCampaigns) {
      const tokenInfo = await fetchTokenInfo(campaign.token);
      console.log(`- ${campaign.campaignId}: ${formatTokenAmount(BigInt(campaign.amount), tokenInfo.decimals)} ${tokenInfo.symbol}`);
    }
    
    // Pre-fetch all token info to speed up processing
    const uniqueTokens = [...new Set(newCampaigns.map(c => c.token))];
    await Promise.all(uniqueTokens.map(token => fetchTokenInfo(token)));
    
    // Process each campaign
    const allDistributions: UniversalMerkle = { ...existingDistributions };
    const feeAccumulator: { [token: string]: bigint } = {};
    
    // Track total delegation amounts per token
    const totalDelegationAmounts: { [token: string]: bigint } = {};
    
    for (const campaign of newCampaigns) {
      const tokenInfo = await fetchTokenInfo(campaign.token);
      
      // Extract the token address from assetId (format: "1-0x8e1c2be682b0d3d8f8ee32024455a34cc724cf08")
      const assetIdParts = campaign.extInfo.assetId.split('-');
      if (assetIdParts.length !== 2) {
        continue;
      }
      
      const tokenAddress = assetIdParts[1];
      
      // Get holders for the period from the fetched data
      const periodHolders = getHoldersForPeriod(
        holdersData,
        tokenAddress,
        campaign.fromTimestamp,
        campaign.toTimestamp
      );
      
      if (periodHolders.length === 0) {
        continue;
      }
      
      // Calculate rewards with fee
      const totalReward = BigInt(campaign.amount);
      const rewardTokenAddress = getAddress(campaign.token);
      const { rewards, totalFees } = calculateRewards(periodHolders, totalReward);
      
      // Track total delegation amounts
      if (!totalDelegationAmounts[rewardTokenAddress]) {
        totalDelegationAmounts[rewardTokenAddress] = BigInt(0);
      }
      totalDelegationAmounts[rewardTokenAddress] += totalReward;
      
      // Accumulate fees per token
      if (!feeAccumulator[rewardTokenAddress]) {
        feeAccumulator[rewardTokenAddress] = BigInt(0);
      }
      feeAccumulator[rewardTokenAddress] += totalFees;
      
      // Calculate total distributed
      let totalDistributed = BigInt(0);
      rewards.forEach(amount => totalDistributed += amount);
      
      // Show campaign info
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Campaign: ${campaign.campaignId}`);
      console.log(`Token: ${tokenInfo.symbol}`);
      console.log(`Pool: ${campaign.extInfo.assetId}`);
      console.log(`Delegation amount: ${formatTokenAmount(totalReward, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`Fee (15%): ${formatTokenAmount(totalFees, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`Distributed: ${formatTokenAmount(totalDistributed, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`Recipients: ${rewards.size}`);
      
      // Add to distribution
      rewards.forEach((amount, address) => {
        if (!allDistributions[address]) {
          allDistributions[address] = {};
        }
        
        if (!allDistributions[address][rewardTokenAddress]) {
          allDistributions[address][rewardTokenAddress] = "0";
        }
        
        // Add to existing amount
        const currentAmount = BigInt(allDistributions[address][rewardTokenAddress]);
        allDistributions[address][rewardTokenAddress] = (currentAmount + amount).toString();
      });
    }
    
    // Add fee recipient to distributions
    const feeRecipientAddress = getAddress(FEE_RECIPIENT);
    if (Object.keys(feeAccumulator).length > 0) {
      if (!allDistributions[feeRecipientAddress]) {
        allDistributions[feeRecipientAddress] = {};
      }
      
      for (const [token, feeAmount] of Object.entries(feeAccumulator)) {
        const fee = feeAmount as bigint;
        if (fee > BigInt(0)) {
          // Add or update fee amount
          const existingFeeAmount = allDistributions[feeRecipientAddress][token] ? BigInt(allDistributions[feeRecipientAddress][token]) : BigInt(0);
          allDistributions[feeRecipientAddress][token] = (existingFeeAmount + fee).toString();
        }
      }
    }
    
    // Generate merkle tree
    const merkleData = generateMerkleTree(allDistributions);
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Save merkle file
    const merklePath = path.join(outputDir, "merkle.json");
    fs.writeFileSync(
      merklePath,
      JSON.stringify(merkleData, null, 2)
    );
    
    // Update processed campaigns
    const updatedProcessedCampaigns = Array.from(processedCampaigns);
    newCampaigns.forEach(campaign => {
      updatedProcessedCampaigns.push(campaign.campaignId);
    });
    
    fs.writeFileSync(
      processedCampaignsPath,
      JSON.stringify({
        processedCampaigns: updatedProcessedCampaigns,
        lastUpdated: new Date().toISOString()
      }, null, 2)
    );
    
    console.log(`\nFiles saved to: ${outputDir}`);
    console.log(`New merkle root: ${merkleData.merkleRoot}`);
    console.log(`Total recipients: ${Object.keys(allDistributions).length}`);
    console.log(`Updated processed campaigns list with ${newCampaigns.length} new campaigns`);
    
    // Show total delegation amounts summary
    if (Object.keys(totalDelegationAmounts).length > 0) {
      console.log(`\n${'='.repeat(60)}`);
      console.log("TOTAL DELEGATION AMOUNTS FROM NEW CAMPAIGNS:");
      console.log(`${'='.repeat(60)}`);
      
      for (const [token, totalAmount] of Object.entries(totalDelegationAmounts)) {
        const total = totalAmount as bigint;
        if (total > BigInt(0)) {
          const tokenInfo = await fetchTokenInfo(token);
          const feeAmount = feeAccumulator[token] || BigInt(0);
          console.log(`\n${tokenInfo.symbol}:`);
          console.log(`  Total delegation: ${formatTokenAmount(total, tokenInfo.decimals)}`);
          console.log(`  Total fees (15%): ${formatTokenAmount(feeAmount, tokenInfo.decimals)}`);
          console.log(`  Total distributed: ${formatTokenAmount(total - feeAmount, tokenInfo.decimals)}`);
        }
      }
    }
    
  } catch (error) {
    console.error("Error in main process:", error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}