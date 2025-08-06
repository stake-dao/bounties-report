import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { UniversalMerkle } from "../interfaces/UniversalMerkle";
import { MerkleData } from "../interfaces/MerkleData";
import { generateMerkleTree } from "../vlCVX/utils";

const PENDLE_MERKLE_DISTRIBUTIONS_API = "https://api.github.com/repos/pendle-finance/merkle-distributions/contents/external-rewards/1";
const GITHUB_HOLDERS_DATA_URL = "https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/strategies/pendle/holders/index.json";
const FEE_PERCENTAGE = 0.15; // 15% fee
const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";

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
          fromTimestamp: distribution.fromTimestamp,
          toTimestamp: distribution.toTimestamp,
          extInfo: distribution.extInfo || { assetId: 'unknown' }
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

async function fetchHoldersData(): Promise<HoldersData> {
  try {
    console.log(`Fetching holders data from GitHub...`);
    
    const response = await fetch(GITHUB_HOLDERS_DATA_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data: HoldersData = await response.json();
    console.log(`Fetched data for ${data.metadata.total_gauges} gauges`);
    
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
    console.log(`No gauge found for token ${tokenAddress}`);
    return [];
  }
  
  console.log(`Processing gauge ${gauge.gauge_id} for token ${gauge.token.symbol}`);
  
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
  
  console.log(`Found ${periodHolders.length} holders for the period`);
  return periodHolders;
}

function calculateRewards(
  holders: PeriodHolder[],
  totalReward: bigint
): Map<string, bigint> {
  const rewards = new Map<string, bigint>();
  
  // Calculate total time-weighted balance using the pre-calculated values
  const totalTimeWeightedBalance = holders.reduce((sum, holder) => {
    // Use the time-weighted balance calculated from events
    return sum + BigInt(holder.time_weighted_balance);
  }, BigInt(0));
  
  if (totalTimeWeightedBalance === BigInt(0)) {
    console.log("WARNING: Total time-weighted balance is 0, no rewards to distribute");
    return rewards;
  }
  
  // Apply fee (15%)
  const feeAmount = (totalReward * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
  const distributableReward = totalReward - feeAmount;
  
  // Log top recipients
  console.log(`\nTop 5 reward recipients:`);
  const sortedHolders = [...holders].sort((a, b) => {
    const balA = BigInt(a.time_weighted_balance);
    const balB = BigInt(b.time_weighted_balance);
    return balB > balA ? 1 : balB < balA ? -1 : 0;
  });
  
  // Distribute rewards proportionally based on time-weighted balance
  holders.forEach(holder => {
    // Use the pre-calculated time-weighted balance from events
    const holderTimeWeightedBalance = BigInt(holder.time_weighted_balance);
    
    const holderReward = (distributableReward * holderTimeWeightedBalance) / totalTimeWeightedBalance;
    
    if (holderReward > BigInt(0)) {
      rewards.set(getAddress(holder.user), holderReward);
    }
  });
  
  // Log top 5 recipients with their rewards
  sortedHolders.slice(0, 5).forEach((holder, index) => {
    const reward = rewards.get(getAddress(holder.user));
    if (reward) {
      const percentage = (BigInt(holder.time_weighted_balance) * BigInt(10000) / totalTimeWeightedBalance);
      console.log(`  ${index + 1}. ${holder.user}:`);
      console.log(`     - Share: ${(Number(percentage) / 100).toFixed(2)}%`);
      console.log(`     - Reward: ${reward.toString()} wei`);
    }
  });
  
  return rewards;
}



async function main() {
  try {
    console.log("Starting Pendle extra distribution processing...");
    console.log(`Looking for campaigns with delegation address: ${DELEGATION_ADDRESS}`);
    
    // Pre-fetch token info for known tokens to speed up processing
    console.log("Fetching token information...");
    
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
    
    // Pre-fetch all token info to speed up processing
    const uniqueTokens = [...new Set(allCampaigns.map(c => c.token))];
    console.log(`\nPre-fetching token information for ${uniqueTokens.length} tokens...`);
    await Promise.all(uniqueTokens.map(token => fetchTokenInfo(token)));
    console.log("Token information fetched successfully");
    
    // Process each campaign
    const allDistributions: UniversalMerkle = {};
    
    // Track campaign results for recap
    interface CampaignResult {
      campaignId: string;
      token: string;
      tokenInfo: TokenInfo;
      pool: string;
      inputAmount: bigint;
      feeAmount: bigint;
      distributedAmount: bigint;
      recipients: number;
      period: { from: Date; to: Date; days: number };
    }
    const campaignResults: CampaignResult[] = [];
    
    for (const campaign of allCampaigns) {
      const tokenInfo = await fetchTokenInfo(campaign.token);
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Processing campaign ${campaign.campaignId}:`);
      console.log(`- Token: ${tokenInfo.symbol} (${campaign.token})`);
      console.log(`- Delegation Amount: ${formatTokenAmount(BigInt(campaign.amount), tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`- Pool: ${campaign.extInfo.assetId}`);
      console.log(`- Period: ${new Date(campaign.fromTimestamp * 1000).toISOString()} to ${new Date(campaign.toTimestamp * 1000).toISOString()}`);
      console.log(`- Duration: ${((campaign.toTimestamp - campaign.fromTimestamp) / (24 * 60 * 60)).toFixed(2)} days`);
      
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
      
      // Get holders for the period from the fetched data
      const periodHolders = getHoldersForPeriod(
        holdersData,
        tokenAddress,
        campaign.fromTimestamp,
        campaign.toTimestamp
      );
      
      if (periodHolders.length === 0) {
        console.warn(`No holders found for token ${tokenAddress} in the specified period`);
        continue;
      }
      
      console.log(`Found ${periodHolders.length} holders for the period`);
      
      // Calculate total time-weighted balance for this gauge
      const totalGaugeTWB = periodHolders.reduce((sum, holder) => 
        sum + BigInt(holder.time_weighted_balance), BigInt(0)
      );
      console.log(`Total time-weighted balance for gauge: ${totalGaugeTWB.toString()}`);
      
      // Log detailed holder information
      console.log(`\nDetailed holder breakdown (top 5 by time-weighted balance):`);
      const sortedHolders = [...periodHolders].sort((a, b) => {
        const balA = BigInt(a.time_weighted_balance);
        const balB = BigInt(b.time_weighted_balance);
        return balB > balA ? 1 : balB < balA ? -1 : 0;
      });
      
      sortedHolders.slice(0, 5).forEach((holder, index) => {
        const twb = BigInt(holder.time_weighted_balance);
        const percentage = totalGaugeTWB > BigInt(0) 
          ? (twb * BigInt(10000) / totalGaugeTWB).toString() 
          : "0";
        console.log(`  ${index + 1}. ${holder.user}:`);
        console.log(`     - Time-weighted balance: ${twb.toString()} (${Number(percentage) / 100}%)`);
      });
      
      // Calculate rewards
      const totalReward = BigInt(campaign.amount);
      const feeAmount = (totalReward * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000);
      const distributableAmount = totalReward - feeAmount;
      
      console.log(`\nCalculating rewards distribution:`);
      console.log(`- Total reward amount: ${formatTokenAmount(totalReward, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`- Fee percentage: ${FEE_PERCENTAGE * 100}%`);
      console.log(`- Fee amount: ${formatTokenAmount(feeAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      console.log(`- Distributable amount: ${formatTokenAmount(distributableAmount, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      
      const rewards = calculateRewards(periodHolders, totalReward);
      
      console.log(`\nReward distribution complete:`);
      console.log(`- Recipients: ${rewards.size}`);
      
      // Calculate total distributed
      let totalDistributed = BigInt(0);
      rewards.forEach(amount => totalDistributed += amount);
      console.log(`- Total distributed: ${formatTokenAmount(totalDistributed, tokenInfo.decimals)} ${tokenInfo.symbol}`);
      
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
      
      // Track campaign results
      campaignResults.push({
        campaignId: campaign.campaignId,
        token: campaign.token,
        tokenInfo: tokenInfo,
        pool: campaign.extInfo.assetId,
        inputAmount: totalReward,
        feeAmount: feeAmount,
        distributedAmount: totalDistributed,
        recipients: rewards.size,
        period: {
          from: new Date(campaign.fromTimestamp * 1000),
          to: new Date(campaign.toTimestamp * 1000),
          days: (campaign.toTimestamp - campaign.fromTimestamp) / (24 * 60 * 60)
        }
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
    
    // Create output directory with current week timestamp (Thursday 00:00 UTC)
    const now = new Date();
    const currentThursday = new Date(now);
    currentThursday.setUTCHours(0, 0, 0, 0);
    
    // Find the most recent Thursday
    const dayOfWeek = currentThursday.getUTCDay();
    const daysUntilThursday = (4 - dayOfWeek + 7) % 7;
    if (daysUntilThursday > 0) {
      currentThursday.setUTCDate(currentThursday.getUTCDate() - (7 - daysUntilThursday));
    }
    
    const timestamp = Math.floor(currentThursday.getTime() / 1000);
    console.log(`\nUsing week timestamp: ${timestamp} (${currentThursday.toISOString()})`);
    
    const outputDir = path.join(__dirname, "../../data/pendle-extra", timestamp.toString());
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Save repartition file
    const repartitionPath = path.join(outputDir, "repartition.json");
    const repartitionData = {
      timestamp,
      folderNames: foundInFolders,
      distribution: allDistributions
    };
    
    fs.writeFileSync(
      repartitionPath,
      JSON.stringify(repartitionData, null, 2)
    );
    
    // Save merkle file
    const merklePath = path.join(outputDir, "merkle.json");
    fs.writeFileSync(
      merklePath,
      JSON.stringify(merkleData, null, 2)
    );
    
    console.log(`\nFiles saved to: ${outputDir}`);
    console.log(`- Repartition: ${path.basename(repartitionPath)}`);
    console.log(`- Merkle: ${path.basename(merklePath)}`);
    console.log(`\nMerkle root: ${merkleData.merkleRoot}`);
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
    for (const [token, total] of Object.entries(tokenSummary)) {
      const tokenInfo = await fetchTokenInfo(token);
      console.log(`- ${tokenInfo.symbol}: ${formatTokenAmount(total, tokenInfo.decimals)} (${token})`);
    }
    

    
    // Campaign recap
    console.log("\n" + "=".repeat(80));
    console.log("CAMPAIGN RECAP:");
    console.log("=".repeat(80));
    
    campaignResults.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.campaignId}`);
      console.log(`   Token: ${result.tokenInfo.symbol} (${result.token})`);
      console.log(`   Pool: ${result.pool}`);
      console.log(`   Period: ${result.period.days.toFixed(1)} days`);
      console.log(`   Input: ${formatTokenAmount(result.inputAmount, result.tokenInfo.decimals)} ${result.tokenInfo.symbol}`);
      console.log(`   Fee (${FEE_PERCENTAGE * 100}%): ${formatTokenAmount(result.feeAmount, result.tokenInfo.decimals)} ${result.tokenInfo.symbol}`);
      console.log(`   Distributed: ${formatTokenAmount(result.distributedAmount, result.tokenInfo.decimals)} ${result.tokenInfo.symbol}`);
      console.log(`   Recipients: ${result.recipients}`);
    });
    
    console.log("\n" + "=".repeat(80));
    console.log(`Total unique recipients: ${Object.keys(allDistributions).length}`);
    
    // Save summary file with detailed information
    const summaryPath = path.join(outputDir, "summary.json");
    
    // Build detailed token summary with info
    const detailedTokenSummary: { [token: string]: any } = {};
    for (const [token, total] of Object.entries(tokenSummary)) {
      const tokenInfo = await fetchTokenInfo(token);
      detailedTokenSummary[token] = {
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        totalAmount: total.toString(),
        totalAmountFormatted: formatTokenAmount(total, tokenInfo.decimals)
      };
    }
    
    // Build campaign details for summary
    const campaignDetails = campaignResults.map(result => ({
      campaignId: result.campaignId,
      token: {
        address: result.token,
        symbol: result.tokenInfo.symbol,
        decimals: result.tokenInfo.decimals
      },
      pool: result.pool,
      period: {
        from: result.period.from.toISOString(),
        to: result.period.to.toISOString(),
        days: result.period.days
      },
      amounts: {
        input: result.inputAmount.toString(),
        inputFormatted: formatTokenAmount(result.inputAmount, result.tokenInfo.decimals),
        fee: result.feeAmount.toString(),
        feeFormatted: formatTokenAmount(result.feeAmount, result.tokenInfo.decimals),
        distributed: result.distributedAmount.toString(),
        distributedFormatted: formatTokenAmount(result.distributedAmount, result.tokenInfo.decimals)
      },
      recipients: result.recipients
    }));
    
    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        timestamp,
        generatedAt: new Date().toISOString(),
        weekStartDate: new Date(timestamp * 1000).toISOString(),
        folderNames: foundInFolders,
        delegationAddress: DELEGATION_ADDRESS,
        feePercentage: FEE_PERCENTAGE,
        merkleRoot: merkleData.merkleRoot,
        totalRecipients: Object.keys(allDistributions).length,
        totalCampaigns: allCampaigns.length,
        tokenSummary: detailedTokenSummary,
        campaignDetails: campaignDetails
      }, null, 2)
    );
    
  } catch (error) {
    console.error("Error in main process:", error);
    process.exit(1);
  }
}

// Run the script
if (require.main === module) {
  main();
}