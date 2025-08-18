import * as moment from "moment";
import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { getAddress } from "viem";

import {
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
  formatVotingPowerResult,
  getDelegationVotingPower,
} from "../snapshot";
import {
  AUTO_VOTER_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
  SPACE_TO_CHAIN_ID,
  WEEK,
} from "../constants";
import {
  extractCSV,
  extractAllRawTokenCSVs,
  extractProposalChoices,
  getChoiceWhereExistsBribe,
  addVotersFromAutoVoter,
  RawTokenDistribution,
} from "../utils";
import { processAllDelegators } from "../cacheUtils";
import { MerkleData } from "../../interfaces/MerkleData";
import { Distribution } from "../../interfaces/Distribution";
import { createCombineDistribution } from "./merkle";
import { generateMerkleTree } from "../../vlCVX/utils";

export interface UniversalMerkleConfig {
  space: string;
  sdToken: string;
  sdTokenSymbol: string;
  rawTokens?: Array<{
    address: string;
    symbol: string;
  }>;
  merkleContract: string;
  outputFileName: string;
}

export interface UniversalMerkleResult {
  merkleData: MerkleData;
  statistics: {
    [tokenSymbol: string]: {
      total: string;
      recipients: number;
    };
  };
}

/**
 * Generic Universal Merkle generator for sdTokens
 * Can process both sdToken rewards and raw token rewards
 */
export async function generateUniversalMerkle(
  config: UniversalMerkleConfig,
  currentPeriodTimestamp: number
): Promise<UniversalMerkleResult | null> {
  console.log(`Generating Universal Merkle for ${config.space} - Period: ${currentPeriodTimestamp}`);
  
  // Fetch proposal IDs
  const now = moment.utc().unix();
  const filter = "*Gauge vote.*$";
  const proposalIdPerSpace = await fetchLastProposalsIds([config.space], now, filter);
  const proposalId = proposalIdPerSpace[config.space];
  
  if (!proposalId) {
    console.error(`No proposal found for ${config.space}`);
    return null;
  }
  
  console.log(`Processing proposal: ${proposalId}`);
  
  // Extract CSV data for sdToken rewards
  const csvResult = await extractCSV(currentPeriodTimestamp, config.space);
  
  if (!csvResult) {
    console.log(`No ${config.sdTokenSymbol} rewards found for this period`);
    return null;
  }
  
  // Extract raw token distributions if configured
  let rawDistributions: RawTokenDistribution[] = [];
  if (config.rawTokens && config.rawTokens.length > 0) {
    const allRawDistributions = await extractAllRawTokenCSVs(currentPeriodTimestamp);
    rawDistributions = allRawDistributions.filter(dist => 
      dist.space === config.space && 
      config.rawTokens!.some(token => 
        token.address.toLowerCase() === dist.token.toLowerCase()
      )
    );
  }
  
  // Process voting data
  const proposal = await getProposal(proposalId);
  const allAddressesPerChoice = extractProposalChoices(proposal);
  const addressesPerChoice = getChoiceWhereExistsBribe(allAddressesPerChoice, csvResult);
  
  // Get voters and voting power
  let voters = await getVoters(proposalId);
  const vps = await getVotingPower(
    proposal,
    voters.map(v => v.voter),
    SPACE_TO_CHAIN_ID[config.space]
  );
  
  voters = formatVotingPowerResult(voters, vps);
  voters = await addVotersFromAutoVoter(config.space, proposal, voters, allAddressesPerChoice);
  
  // Remove auto voter address
  voters = voters.filter(
    voter => voter.voter.toLowerCase() !== AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase()
  );
  
  // Get delegators
  const delegators = await processAllDelegators(config.space, proposal.created, DELEGATION_ADDRESS);
  const delegatorsVotingPower = await getDelegationVotingPower(
    proposal,
    delegators.concat([DELEGATION_ADDRESS]),
    SPACE_TO_CHAIN_ID[config.space]
  );
  
  // Reduce delegator voting power for direct voters
  for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
    const da = delegatorAddress.toLowerCase();
    for (const vote of voters) {
      if (vote.voter.toLowerCase() === da) {
        delegatorsVotingPower[delegatorAddress] -= vote.vp;
        if (delegatorsVotingPower[delegatorAddress] <= 0) {
          delegatorsVotingPower[delegatorAddress] = 0;
        }
        break;
      }
    }
  }
  
  const delegatorSumVotingPower = Object.values(delegatorsVotingPower).reduce(
    (acc, vp) => acc + vp,
    0.0
  );
  
  // Initialize user rewards
  const userRewards: { [userAddress: string]: { [tokenAddress: string]: number } } = {};
  
  // Process sdToken rewards distribution
  for (const gaugeAddress of Object.keys(addressesPerChoice)) {
    const index = addressesPerChoice[gaugeAddress].index;
    const sdTokenRewardAmount = addressesPerChoice[gaugeAddress].amount;
    
    // Calculate total VP for this gauge
    let totalVP = 0;
    for (const voter of voters) {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (index === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      
      if (currentChoiceIndex === 0) continue;
      
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      totalVP += (voter.vp * ratio) / 100;
    }
    
    // Distribute sdToken rewards to voters
    for (const voter of voters) {
      let vpChoiceSum = 0;
      let currentChoiceIndex = 0;
      for (const choiceIndex of Object.keys(voter.choice)) {
        if (index === parseInt(choiceIndex)) {
          currentChoiceIndex = voter.choice[choiceIndex];
        }
        vpChoiceSum += voter.choice[choiceIndex];
      }
      
      if (currentChoiceIndex === 0) continue;
      
      const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
      const vpUsed = (voter.vp * ratio) / 100;
      const totalVPRatio = (vpUsed * 100) / totalVP;
      const amountEarned = (totalVPRatio * sdTokenRewardAmount) / 100;
      
      const voterAddress = voter.voter.toLowerCase();
      if (!userRewards[voterAddress]) {
        userRewards[voterAddress] = {};
      }
      if (!userRewards[voterAddress][config.sdToken]) {
        userRewards[voterAddress][config.sdToken] = 0;
      }
      userRewards[voterAddress][config.sdToken] += amountEarned;
    }
  }
  
  // Process raw token distributions using the same voting mechanism
  if (rawDistributions.length > 0) {
    console.log(`Processing ${rawDistributions.length} raw token distributions`);
    
    // Group distributions by token and gauge
    const rawRewardsByTokenAndGauge: { 
      [token: string]: { [gauge: string]: number } 
    } = {};
    
    for (const dist of rawDistributions) {
      const token = dist.token.toLowerCase();
      if (!rawRewardsByTokenAndGauge[token]) {
        rawRewardsByTokenAndGauge[token] = {};
      }
      if (!rawRewardsByTokenAndGauge[token][dist.gauge]) {
        rawRewardsByTokenAndGauge[token][dist.gauge] = 0;
      }
      rawRewardsByTokenAndGauge[token][dist.gauge] += dist.amount;
    }
    
    // Distribute each raw token's rewards
    for (const [tokenAddress, gaugeRewards] of Object.entries(rawRewardsByTokenAndGauge)) {
      for (const [gaugeAddress, rewardAmount] of Object.entries(gaugeRewards)) {
        // Find the choice index for this gauge
        let index = -1;
        for (const [addr, idx] of Object.entries(allAddressesPerChoice)) {
          if (gaugeAddress.toLowerCase().includes(addr.toLowerCase())) {
            index = idx;
            break;
          }
        }
        
        if (index === -1) {
          console.warn(`Could not find choice index for gauge ${gaugeAddress}`);
          continue;
        }
        
        // Calculate total VP for this gauge
        let totalVP = 0;
        for (const voter of voters) {
          let vpChoiceSum = 0;
          let currentChoiceIndex = 0;
          for (const choiceIndex of Object.keys(voter.choice)) {
            if (index === parseInt(choiceIndex)) {
              currentChoiceIndex = voter.choice[choiceIndex];
            }
            vpChoiceSum += voter.choice[choiceIndex];
          }
          
          if (currentChoiceIndex === 0) continue;
          
          const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
          totalVP += (voter.vp * ratio) / 100;
        }
        
        // Distribute raw token rewards to voters
        for (const voter of voters) {
          let vpChoiceSum = 0;
          let currentChoiceIndex = 0;
          for (const choiceIndex of Object.keys(voter.choice)) {
            if (index === parseInt(choiceIndex)) {
              currentChoiceIndex = voter.choice[choiceIndex];
            }
            vpChoiceSum += voter.choice[choiceIndex];
          }
          
          if (currentChoiceIndex === 0) continue;
          
          const ratio = (currentChoiceIndex * 100) / vpChoiceSum;
          const vpUsed = (voter.vp * ratio) / 100;
          const totalVPRatio = (vpUsed * 100) / totalVP;
          const amountEarned = (totalVPRatio * rewardAmount) / 100;
          
          const voterAddress = voter.voter.toLowerCase();
          if (!userRewards[voterAddress]) {
            userRewards[voterAddress] = {};
          }
          if (!userRewards[voterAddress][tokenAddress]) {
            userRewards[voterAddress][tokenAddress] = 0;
          }
          userRewards[voterAddress][tokenAddress] += amountEarned;
        }
      }
    }
  }
  
  // Handle delegation rewards
  const delegationVote = voters.find(
    v => v.voter.toLowerCase() === DELEGATION_ADDRESS.toLowerCase()
  );
  
  if (delegationVote && delegationVote.totalRewards) {
    // Distribute delegation rewards
    for (const delegatorAddress of Object.keys(delegatorsVotingPower)) {
      const vp = delegatorsVotingPower[delegatorAddress];
      const ratioVp = (vp * 100) / delegatorSumVotingPower;
      
      const sdTokenAmount = (ratioVp * (delegationVote.totalRewards || 0)) / 100;
      
      const delAddress = delegatorAddress.toLowerCase();
      if (!userRewards[delAddress]) {
        userRewards[delAddress] = {};
      }
      if (!userRewards[delAddress][config.sdToken]) {
        userRewards[delAddress][config.sdToken] = 0;
      }
      userRewards[delAddress][config.sdToken] += sdTokenAmount;
    }
  }
  
  // Load previous merkle data if exists
  const prevPeriodTimestamp = currentPeriodTimestamp - WEEK;
  const previousMerkleDataPath = path.join(
    process.cwd(),
    "bounties-reports",
    prevPeriodTimestamp.toString(),
    config.outputFileName
  );
  
  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  if (fs.existsSync(previousMerkleDataPath)) {
    previousMerkleData = JSON.parse(fs.readFileSync(previousMerkleDataPath, "utf8"));
    console.log(`Loaded previous Universal Merkle data for ${config.space}`);
  }
  
  // Convert userRewards to Distribution format
  const currentDistribution: Distribution = {};
  for (const [address, tokens] of Object.entries(userRewards)) {
    currentDistribution[address] = { tokens: {} };
    for (const [token, amount] of Object.entries(tokens)) {
      // Convert to wei (BigInt)
      const weiAmount = BigInt(Math.floor(amount * 1e18));
      currentDistribution[address].tokens[token] = weiAmount;
    }
  }
  
  // Combine with previous unclaimed rewards
  const combinedDistribution = createCombineDistribution(
    { distribution: currentDistribution },
    previousMerkleData
  );
  
  // Generate merkle tree using shared utility
  const merkleData = generateMerkleTree(combinedDistribution);
  
  // Calculate statistics
  const statistics: UniversalMerkleResult["statistics"] = {};
  
  // Initialize token stats
  statistics[config.sdTokenSymbol] = { total: "0", recipients: 0 };
  if (config.rawTokens) {
    for (const token of config.rawTokens) {
      statistics[token.symbol] = { total: "0", recipients: 0 };
    }
  }
  
  // Calculate totals
  for (const claim of Object.values(merkleData.claims)) {
    for (const [tokenAddress, tokenClaim] of Object.entries(claim.tokens)) {
      const tokenAddressLower = tokenAddress.toLowerCase();
      const amount = BigNumber.from(tokenClaim.amount);
      
      if (tokenAddressLower === config.sdToken.toLowerCase()) {
        const current = BigNumber.from(statistics[config.sdTokenSymbol].total);
        statistics[config.sdTokenSymbol].total = current.add(amount).toString();
        statistics[config.sdTokenSymbol].recipients++;
      } else if (config.rawTokens) {
        const rawToken = config.rawTokens.find(
          t => t.address.toLowerCase() === tokenAddressLower
        );
        if (rawToken) {
          const current = BigNumber.from(statistics[rawToken.symbol].total);
          statistics[rawToken.symbol].total = current.add(amount).toString();
          statistics[rawToken.symbol].recipients++;
        }
      }
    }
  }
  
  return {
    merkleData,
    statistics
  };
}