import {
  Chain,
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { DistributionRow } from "../interfaces/DistributionRow";
import { MerkleData } from "../interfaces/MerkleData";
import { formatAddress } from "./address";
import {
  delegationLogger,
  proposalInformationLogger,
} from "./delegationHelper";
import { getProposal, getVoters } from "./snapshot";
import {
  getClient,
  VOTIUM_FORWARDER_REGISTRY,
  CVX_SPACE,
  CVX_FXN_SPACE,
  WEEK,
} from "./constants";
import { verifyVlCVXDistribution } from "./vlCVXDistributionVerifier";
import fs from "fs";
import path from "path";
const merkleAbi = [
  {
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
    ],
    name: "claimed",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Global cache for token information to persist during the entire script execution
const globalTokenInfoCache: {
  [chainId: number]: {
    [token: string]: { decimals: number; symbol: string };
  };
} = {};

// Chain-specific known token mappings
const KNOWN_TOKENS_BY_CHAIN: {
  [chainId: number]: { [address: string]: { symbol: string; decimals: number } };
} = {
  // Ethereum Mainnet
  1: {
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { symbol: "USDC", decimals: 6 },
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": { symbol: "USDT", decimals: 6 },
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": { symbol: "DAI", decimals: 18 },
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": { symbol: "WBTC", decimals: 8 },
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": { symbol: "WETH", decimals: 18 },
    "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0": { symbol: "wstETH", decimals: 18 },
    "0xD533a949740bb3306d119CC777fa900bA034cd52": { symbol: "CRV", decimals: 18 },
    "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B": { symbol: "CVX", decimals: 18 },
    "0x090185f2135308BaD17527004364eBcC2D37e5F6": { symbol: "SPELL", decimals: 18 },
    "0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68": { symbol: "SAV3", decimals: 18 },
    "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0": { symbol: "FXS", decimals: 18 },
    "0x5f018e73C185aB23647c82bD039e762813877f0e": { symbol: "FXN", decimals: 18 },
    "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5": { symbol: "sdCRV", decimals: 18 },
    "0x30D20208d987713f46DFD34EF128Bb16C404D10f": { symbol: "SD", decimals: 18 },
    "0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F": { symbol: "SDT", decimals: 18 },
    "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E": { symbol: "crvUSD", decimals: 18 },
    "0x853d955aCEf822Db058eb8505911ED77F175b99e": { symbol: "FRAX", decimals: 18 },
    "0xC0c293ce456fF0ED870ADd98a0828Dd4d2903DBF": { symbol: "AURA", decimals: 18 },
    "0xba100000625a3754423978a60c9317c58a424e3D": { symbol: "BAL", decimals: 18 },
    "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32": { symbol: "LDO", decimals: 18 },
    "0xae78736Cd615f374D3085123A210448E74Fc6393": { symbol: "rETH", decimals: 18 },
    "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f": { symbol: "GHO", decimals: 18 },
    "0x085780639CC2cACd35E474e71f4d000e2405d8f6": { symbol: "YFI", decimals: 18 },
  },
  // Arbitrum
  42161: {
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": { symbol: "USDC", decimals: 6 },
    "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": { symbol: "USDT", decimals: 6 },
    "0x912CE59144191C1204E64559FE8253a0e49E6548": { symbol: "ARB", decimals: 18 },
    "0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8": { symbol: "BAL", decimals: 18 },
    "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0": { symbol: "UNI", decimals: 18 },
    "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978": { symbol: "CRV", decimals: 18 },
    "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4": { symbol: "LINK", decimals: 18 },
    "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": { symbol: "WBTC", decimals: 8 },
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": { symbol: "WETH", decimals: 18 },
    "0x5979D7b546E38E414F7E9822514be443A4800529": { symbol: "wstETH", decimals: 18 },
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": { symbol: "DAI", decimals: 18 },
    "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8": { symbol: "USDC.e", decimals: 6 },
    "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F": { symbol: "FRAX", decimals: 18 },
    "0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60": { symbol: "LDO", decimals: 18 },
    "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a": { symbol: "GMX", decimals: 18 },
    "0x7A10F506E4c7658e6AD15Fdf0443d450B7FA80D7": { symbol: "EYWA", decimals: 18 },
  },
  // Base
  8453: {
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { symbol: "USDC", decimals: 6 },
    "0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415": { symbol: "CRV", decimals: 18 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
    "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": { symbol: "USDbC", decimals: 6 },
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": { symbol: "DAI", decimals: 18 },
  },
  // Optimism
  10: {
    "0x7F5c764cBc14f9669B88837ca1490cCa17c31607": { symbol: "USDC.e", decimals: 6 },
    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85": { symbol: "USDC", decimals: 6 },
    "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58": { symbol: "USDT", decimals: 6 },
    "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": { symbol: "DAI", decimals: 18 },
    "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
    "0x68f180fcCe6836688e9084f035309E29Bf0A2095": { symbol: "WBTC", decimals: 8 },
  },
  // Polygon
  137: {
    "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": { symbol: "USDC.e", decimals: 6 },
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": { symbol: "USDC", decimals: 6 },
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": { symbol: "USDT", decimals: 6 },
    "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063": { symbol: "DAI", decimals: 18 },
    "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": { symbol: "WETH", decimals: 18 },
    "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6": { symbol: "WBTC", decimals: 8 },
  },
};

export const getAllTokensInfos = async (
  tokenAddresses: string[],
  chain: Chain
) => {
  const chainId = chain.id;

  // Initialize cache for this chain if it doesn't exist
  if (!globalTokenInfoCache[chainId]) {
    globalTokenInfoCache[chainId] = {};
  }

  const chainCache = globalTokenInfoCache[chainId];
  const knownTokensForChain = KNOWN_TOKENS_BY_CHAIN[chainId] || {};

  // Normalize all addresses first
  const normalizedAddresses = tokenAddresses.map((addr) => {
    try {
      return getAddress(addr);
    } catch {
      console.warn(`Invalid address format: ${addr}`);
      return addr;
    }
  });

  // First, check known tokens for this chain
  for (const addr of normalizedAddresses) {
    if (!chainCache[addr] && knownTokensForChain[addr]) {
      chainCache[addr] = knownTokensForChain[addr];
    }
  }

  // Filter out addresses that are already cached (including known tokens)
  const uncachedAddresses = normalizedAddresses.filter(
    (addr) => !chainCache[addr]
  );

  // If all tokens are cached, return the cached data
  if (uncachedAddresses.length === 0) {
    console.log(`All ${normalizedAddresses.length} tokens found in cache for chain ${chainId}`);
    const result: { [token: string]: { decimals: number; symbol: string } } =
      {};
    for (const addr of normalizedAddresses) {
      result[addr] = chainCache[addr];
    }
    return result;
  }

  console.log(
    `Chain ${chainId}: Fetching info for ${uncachedAddresses.length} uncached tokens (${normalizedAddresses.length - uncachedAddresses.length} cached)`
  );

  const client =
    (await getClient(chainId)) ||
    createPublicClient({
      chain,
      transport: http(),
    });

  const symbolCalls = uncachedAddresses.map((tokenAddr) => ({
    address: tokenAddr as `0x${string}`,
    abi: erc20Abi,
    functionName: "symbol",
    args: [],
  }));

  const decimalsCalls = uncachedAddresses.map((tokenAddr) => ({
    address: tokenAddr as `0x${string}`,
    abi: erc20Abi,
    functionName: "decimals",
    args: [],
  }));

  const decimalsResults = await client.multicall({ contracts: decimalsCalls });
  const symbolResults = await client.multicall({ contracts: symbolCalls });

  // Process results and update cache
  for (let i = 0; i < uncachedAddresses.length; i++) {
    const normalizedAddress = uncachedAddresses[i];
    let decimals = 18;
    let symbol = "UNKNOWN";

    if (decimalsResults[i].status === "success") {
      decimals = Number(decimalsResults[i].result);
    } else {
      // Check if this might be a token from another chain
      let foundInOtherChain = false;
      for (const [otherChainId, tokens] of Object.entries(KNOWN_TOKENS_BY_CHAIN)) {
        if (otherChainId !== chainId.toString() && tokens[normalizedAddress]) {
          console.warn(
            `Token ${normalizedAddress} appears to be from chain ${otherChainId}, not chain ${chainId}. Using known info.`
          );
          decimals = tokens[normalizedAddress].decimals;
          symbol = tokens[normalizedAddress].symbol;
          foundInOtherChain = true;
          break;
        }
      }
      if (!foundInOtherChain) {
        console.warn(
          `Failed to fetch decimals for ${normalizedAddress} on chain ${chainId}, defaulting to 18`
        );
      }
    }

    if (symbolResults[i].status === "success") {
      symbol = symbolResults[i].result as string;
    } else if (symbol === "UNKNOWN") {
      // Check if this might be a token from another chain
      let foundInOtherChain = false;
      for (const [otherChainId, tokens] of Object.entries(KNOWN_TOKENS_BY_CHAIN)) {
        if (otherChainId !== chainId.toString() && tokens[normalizedAddress]) {
          console.warn(
            `Token ${normalizedAddress} appears to be from chain ${otherChainId}, not chain ${chainId}. Using known info.`
          );
          symbol = tokens[normalizedAddress].symbol;
          foundInOtherChain = true;
          break;
        }
      }
      if (!foundInOtherChain) {
        console.warn(
          `Failed to fetch symbol for ${normalizedAddress} on chain ${chainId}, using UNKNOWN`
        );
      }
    }

    // Store in cache
    chainCache[normalizedAddress] = {
      decimals,
      symbol,
    };
  }

  // Build result map from cache (includes both cached and newly fetched)
  const tokenInfoMap: {
    [token: string]: { decimals: number; symbol: string };
  } = {};

  for (const addr of normalizedAddresses) {
    tokenInfoMap[addr] = chainCache[addr];
  }

  return tokenInfoMap;
};

const setupLogging = (proposalId: string): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return path.join(tempDir, `proposal-${proposalId}-${timestamp}.log`);
};

export const distributionVerifier = async (
  space: string,
  merkleChain: Chain,
  merkleAddress: `0x${string}`,
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  distribution: { [address: string]: { tokens: { [token: string]: bigint } } },
  proposalId?: string,
  merkleType?: string,
  merkleSubType?: string
) => {
  const addressCount = Object.keys(distribution).length;
  console.log(`Current Distribution has ${addressCount} addresses.`);

  const tokenSums: { [token: string]: bigint } = {};
  for (const data of Object.values(distribution)) {
    for (const [token, amount] of Object.entries(data.tokens)) {
      tokenSums[token] = (tokenSums[token] || 0n) + amount;
    }
  }
  console.log("Token totals in current distribution (absolute):");
  for (const [token, sum] of Object.entries(tokenSums)) {
    console.log(`${token}: ${sum.toString()}`);
  }

  // Check Votium epoch for vlCVX
  if (space === CVX_SPACE || space === CVX_FXN_SPACE) {
    console.log("\n=== Votium Epoch Check ===");
    try {
      const ethereumClient =
        (await getClient(1)) ||
        createPublicClient({
          chain: merkleChain,
          transport: http(),
        });

      const votiumEpochAbi = [
        {
          name: "currentEpoch",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const;

      const currentEpoch = await ethereumClient.readContract({
        address: VOTIUM_FORWARDER_REGISTRY,
        abi: votiumEpochAbi,
        functionName: "currentEpoch",
      });

      const proposal = await getProposal(proposalId);
      const proposalStartTimestamp = proposal.start;

      console.log(
        `Votium Current Epoch: ${currentEpoch} (${new Date(Number(currentEpoch) * 1000).toUTCString()})`
      );
      console.log(
        `Proposal Start: ${proposalStartTimestamp} (${new Date(proposalStartTimestamp * 1000).toUTCString()})`
      );

      if (Number(currentEpoch) !== proposalStartTimestamp) {
        console.warn(
          `⚠️  WARNING: Votium epoch (${currentEpoch}) does not match proposal start (${proposalStartTimestamp})`
        );
      } else {
        console.log(`✅ Votium epoch matches proposal start`);
      }
    } catch (error) {
      console.error("Error checking Votium epoch:", error);
    }
  }

  // --- Get token info using a single helper call ---
  const tokenSet = new Set<string>();
  for (const claim of Object.values(currentMerkleData.claims)) {
    for (const tokenAddr of Object.keys(claim.tokens)) {
      tokenSet.add(getAddress(tokenAddr));
    }
  }
  const tokenAddresses = Array.from(tokenSet);
  const tokenInfos = await getAllTokensInfos(tokenAddresses, merkleChain);

  // --- Get proposal & votes ---
  const activeProposal = await getProposal(proposalId);
  console.log(activeProposal);
  console.log(space);
  const votes = await getVoters(activeProposal.id);
  const logPath = setupLogging(activeProposal.id);
  const log = (message: string) => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };

  proposalInformationLogger(space, activeProposal, log);
  log("\n=== Delegation Information ===");
  await delegationLogger(space, activeProposal, votes, log, merkleChain.id.toString());
  log(`\nTotal Votes: ${votes.length}`);
  log(`\nHolder Distribution:`);

  // Calculate week change totals per token first
  const weekChangeTotals: { [token: string]: bigint } = {};
  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    const previousClaims = previousMerkleData.claims[address] || { tokens: {} };
    for (const tokenAddr in currentClaims.tokens) {
      const normToken = getAddress(tokenAddr);
      const currentAmount = BigInt(currentClaims.tokens[tokenAddr].amount);
      const previousAmount = previousClaims.tokens[tokenAddr]
        ? BigInt(previousClaims.tokens[tokenAddr].amount)
        : 0n;
      const change = currentAmount - previousAmount;
      weekChangeTotals[normToken] =
        (weekChangeTotals[normToken] || 0n) + change;
    }
  }

  const currentPeriodTimestamp = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

  const comparisonRows = await compareMerkleData(
    currentMerkleData,
    previousMerkleData,
    distribution,
    merkleChain,
    merkleAddress,
    tokenInfos,
    weekChangeTotals,
    space,
    currentPeriodTimestamp
  );
  logDistributionRowsToFile(comparisonRows, tokenInfos, log, merkleChain);

  // --- Log formatted week-change totals per token ---
  console.log("\n=== Week Changes ===");
  for (const tokenAddr of tokenAddresses) {
    const info = tokenInfos[tokenAddr] || { decimals: 18, symbol: "UNKNOWN" };
    const total = weekChangeTotals[tokenAddr] || 0n;
    const formatted = Number(total) / 10 ** info.decimals;
    console.log(`${info.symbol} (${tokenAddr}): ${formatted.toFixed(2)}`);
  }

  // --- Run vlCVX-specific verification if applicable ---
  if (space === CVX_SPACE || space === CVX_FXN_SPACE) {
    const gaugeType = space === CVX_SPACE ? "curve" : "fxn";
    await verifyVlCVXDistribution(
      currentPeriodTimestamp,
      gaugeType,
      currentMerkleData,
      previousMerkleData,
      log,
      merkleType
    );
  }
};

const compareMerkleData = async (
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  distribution: { [address: string]: { tokens: { [token: string]: bigint } } },
  chain: Chain,
  merkleAddress: `0x${string}`,
  tokenInfos: { [token: string]: { decimals: number; symbol: string } },
  weekChangeTotals: { [token: string]: bigint },
  space?: string,
  currentPeriodTimestamp?: number
): Promise<DistributionRow[]> => {
  const client =
    (await getClient(chain.id)) ||
    createPublicClient({
      chain,
      transport: http(),
    });

  // Load user type data for vlCVX
  let forwarders: Set<string> = new Set();
  let nonForwarders: Set<string> = new Set();
  let voters: Set<string> = new Set();

  if (
    (space === CVX_SPACE || space === CVX_FXN_SPACE) &&
    currentPeriodTimestamp
  ) {
    const gaugeType = space === CVX_SPACE ? "curve" : "fxn";
    try {
      // Load delegation data
      const delegationPath = path.join(
        process.cwd(),
        `bounties-reports/${currentPeriodTimestamp}/vlCVX/${gaugeType}/repartition_delegation.json`
      );
      const votersPath = path.join(
        process.cwd(),
        `bounties-reports/${currentPeriodTimestamp}/vlCVX/${gaugeType}/repartition.json`
      );

      if (fs.existsSync(delegationPath)) {
        const delegationData = JSON.parse(
          fs.readFileSync(delegationPath, "utf-8")
        );
        Object.keys(delegationData.distribution.forwarders || {}).forEach(
          (addr) => forwarders.add(getAddress(addr))
        );
        Object.keys(delegationData.distribution.nonForwarders || {}).forEach(
          (addr) => nonForwarders.add(getAddress(addr))
        );
      }

      if (fs.existsSync(votersPath)) {
        const votersData = JSON.parse(fs.readFileSync(votersPath, "utf-8"));
        Object.keys(votersData.distribution || {}).forEach((addr) =>
          voters.add(getAddress(addr))
        );
      }
    } catch (e) {
      console.warn("Could not load user type data:", e);
    }
  }

  const calls: any[] = [];
  const addressMapping: Array<{ address: string; tokenAddress: string }> = [];

  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    for (const tokenAddress in currentClaims.tokens) {
      calls.push({
        address: merkleAddress,
        abi: merkleAbi,
        functionName: "claimed",
        args: [address, tokenAddress],
      });
      addressMapping.push({ address, tokenAddress });
    }
  }

  const results = await client.multicall({ contracts: calls });
  const distributionRows: DistributionRow[] = [];

  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    const previousClaims = previousMerkleData.claims[address] || { tokens: {} };

    for (const tokenAddress in currentClaims.tokens) {
      const normalizedTokenAddress = getAddress(tokenAddress);
      const tokenInfo = tokenInfos[normalizedTokenAddress] || {
        decimals: 18,
        symbol: "UNKNOWN",
      };

      const currentTokenClaim = currentClaims.tokens[tokenAddress];
      const previousTokenClaim = previousClaims.tokens[tokenAddress] || {
        amount: "0",
      };

      const previousClaim = BigInt(previousTokenClaim.amount || "0");
      const currentClaim = BigInt(currentTokenClaim.amount);
      const weekChangeRaw = currentClaim - previousClaim;

      // Lookup distribution amount for this address and token (raw value)
      let distributionAmountRaw = 0n;
      const distributionUser = Object.keys(distribution).find(
        (user) => user.toLowerCase() === address.toLowerCase()
      );
      if (distributionUser) {
        const distributionToken = Object.keys(
          distribution[distributionUser].tokens
        ).find((token) => token.toLowerCase() === tokenAddress.toLowerCase());
        if (distributionToken) {
          distributionAmountRaw = BigInt(
            distribution[distributionUser].tokens[distributionToken]
          );
        }
      }

      // Use the raw values (in token's smallest units) in the row.
      const claimedAmount = BigInt((results.shift()?.result as bigint) || "0");
      const isAmountDifferent =
        distributionAmountRaw !== currentClaim - previousClaim;

      // Calculate percentage of week change relative to total week changes for this token
      let weekChangePercentage = 0;
      const tokenWeekChangeTotal = weekChangeTotals[normalizedTokenAddress];
      if (
        tokenWeekChangeTotal &&
        tokenWeekChangeTotal > 0n &&
        weekChangeRaw > 0n
      ) {
        weekChangePercentage =
          (Number(weekChangeRaw) / Number(tokenWeekChangeTotal)) * 100;
      }

      // Determine user type
      let userType: "forwarder" | "non-forwarder" | "voter" | undefined;
      const normalizedAddress = getAddress(address);
      if (forwarders.has(normalizedAddress)) {
        userType = "forwarder";
      } else if (nonForwarders.has(normalizedAddress)) {
        userType = "non-forwarder";
      } else if (voters.has(normalizedAddress)) {
        userType = "voter";
      }

      const row: DistributionRow = {
        address,
        tokenAddress: normalizedTokenAddress,
        symbol: tokenInfo.symbol,
        prevAmount: previousClaim,
        newAmount: currentClaim,
        weekChange: weekChangeRaw,
        distributionAmount: distributionAmountRaw,
        claimed: claimedAmount === previousClaim,
        isError: isAmountDifferent,
        weekChangePercentage,
        userType,
      };

      distributionRows.push(row);
    }
  }

  return distributionRows;
};

const logDistributionRowsToFile = (
  distributionRows: DistributionRow[],
  tokenInfos: { [token: string]: { decimals: number; symbol: string } },
  log: (message: string) => void,
  chain?: Chain
) => {
  // Add chain info to headers if available
  const chainInfo = chain ? ` (Chain: ${chain.name})` : "";

  // Regular detailed mode
  // Sort rows by address first, then by week change within each address
  distributionRows.sort((a, b) => {
    if (a.address.toLowerCase() !== b.address.toLowerCase()) {
      return a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1;
    }
    // Within same address, sort by descending week changes
    if (b.weekChange > a.weekChange) return 1;
    if (b.weekChange < a.weekChange) return -1;
    return 0;
  });

  const headers = [
    "Address",
    "Token",
    "Previous",
    "Current",
    "Change",
    "Share %",
    "Status",
  ];

  const rows: string[][] = [];
  let lastAddress = "";
  const uniqueAddresses = new Set<string>();
  const addressesWithErrors = new Set<string>();
  const addressesUnclaimed = new Set<string>();
  const addressStats: { [address: string]: { totalChange: number; tokenCount: number; hasError: boolean; allClaimed: boolean } } = {};

  // First pass: collect statistics per address
  distributionRows.forEach((row) => {
    if (row.weekChange === 0n) return;
    
    const addr = row.address.toLowerCase();
    if (!addressStats[addr]) {
      addressStats[addr] = { totalChange: 0, tokenCount: 0, hasError: false, allClaimed: true };
    }
    
    const tokenInfo = tokenInfos[row.tokenAddress] || { decimals: 18, symbol: "UNKNOWN" };
    const change = Number(row.weekChange) / 10 ** tokenInfo.decimals;
    
    addressStats[addr].totalChange += change;
    addressStats[addr].tokenCount++;
    if (row.isError) addressStats[addr].hasError = true;
    if (!row.claimed) addressStats[addr].allClaimed = false;
  });

  // Second pass: create rows
  distributionRows.forEach((row) => {
    const tokenInfo = tokenInfos[row.tokenAddress] || {
      decimals: 18,
      symbol: row.symbol || "UNKNOWN",
    };
    const decimals = tokenInfo.decimals;
    
    // Skip tokens with zero week change
    if (row.weekChange === 0n) {
      return;
    }

    uniqueAddresses.add(row.address.toLowerCase());
    if (row.isError) addressesWithErrors.add(row.address.toLowerCase());
    if (!row.claimed) addressesUnclaimed.add(row.address.toLowerCase());

    // Convert raw BigInt values to floating point numbers for display
    const formattedPrev = Number(row.prevAmount) / 10 ** decimals;
    const formattedNew = Number(row.newAmount) / 10 ** decimals;
    const formattedWeekChange = Number(row.weekChange) / 10 ** decimals;

    const percentageStr =
      row.weekChange > 0n && row.weekChangePercentage !== undefined
        ? `${row.weekChangePercentage.toFixed(2)}%`
        : "-";

    // For repeated addresses, show abbreviated address
    const isNewAddress = row.address !== lastAddress;
    let displayAddress = "";
    
    if (isNewAddress) {
      displayAddress = formatAddress(row.address);
    } else {
      displayAddress = "  └─";
    }

    // Status column shows claim status and user type with error indicators
    let statusStr = row.claimed ? "✅" : "❌";
    
    // Add user type if available
    if (row.userType === "forwarder") statusStr += " 🔄";
    else if (row.userType === "voter") statusStr += " 🗳️";
    else if (row.userType === "non-forwarder") statusStr += " 👤";
    
    // Add error indicator if applicable
    if (row.isError) statusStr += " ⚠️";

    rows.push([
      displayAddress,
      tokenInfo.symbol,
      formattedPrev.toFixed(2),
      formattedNew.toFixed(2),
      formattedWeekChange > 0 ? `+${formattedWeekChange.toFixed(2)}` : formattedWeekChange.toFixed(2),
      percentageStr,
      statusStr,
    ]);

    lastAddress = row.address;
  });

  const columnWidths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const headerLine = headers
    .map((h, i) => h.padEnd(columnWidths[i]))
    .join(" | ");
  const separatorLine = columnWidths.map((w) => "-".repeat(w)).join("-|-");
  const formattedRows = rows.map((row) =>
    row.map((cell, i) => cell.padEnd(columnWidths[i])).join(" | ")
  );

  log("\n=== Distribution Verification ===" + chainInfo);
  log(`📊 Summary:`);
  log(`  • Total addresses: ${uniqueAddresses.size}`);
  log(`  • Total distributions: ${rows.length}`);
  if (addressesWithErrors.size > 0) {
    log(`  • ⚠️  Addresses with errors: ${addressesWithErrors.size}`);
  }
  if (addressesUnclaimed.size > 0) {
    log(`  • 📋 Unclaimed distributions: ${addressesUnclaimed.size} addresses`);
  }
  
  // Calculate total changes by token
  const tokenTotals: { [symbol: string]: number } = {};
  distributionRows.forEach((row) => {
    if (row.weekChange === 0n) return;
    const tokenInfo = tokenInfos[row.tokenAddress] || { decimals: 18, symbol: row.symbol || "UNKNOWN" };
    const change = Number(row.weekChange) / 10 ** tokenInfo.decimals;
    tokenTotals[tokenInfo.symbol] = (tokenTotals[tokenInfo.symbol] || 0) + change;
  });
  
  if (Object.keys(tokenTotals).length > 0) {
    log(`\n📈 Token Distribution Summary:`);
    Object.entries(tokenTotals)
      .sort(([, a], [, b]) => b - a)
      .forEach(([symbol, total]) => {
        log(`  • ${symbol}: ${total.toFixed(2)}`);
      });
  }
  
  log("\n🔍 Legend (Status column): ✅ Claimed | ❌ Unclaimed | 🔄 Forwarder | 🗳️ Voter | 👤 Non-Forwarder | ⚠️ Error\n");

  const fileContent = [headerLine, separatorLine, ...formattedRows].join("\n");

  log(fileContent + "\n\n");
};
