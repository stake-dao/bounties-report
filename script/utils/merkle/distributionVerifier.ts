import {
  Chain,
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
} from "viem";
import { DistributionRow } from "../../interfaces/DistributionRow";
import { MerkleData } from "../../interfaces/MerkleData";
import { formatAddress } from "../address";
import {
  delegationLogger,
  proposalInformationLogger,
} from "../delegationHelper";
import { getProposal, getVoters } from "../snapshot";
import {
  getClient,
  VOTIUM_FORWARDER_REGISTRY,
  CVX_SPACE,
  CVX_FXN_SPACE,
  WEEK,
} from "../constants";
import { verifyVlCVXDistribution } from "../vlCVXDistributionVerifier";
import { getTokenByAddress } from "../tokenService";
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

  // Normalize all addresses first
  const normalizedAddresses = tokenAddresses.map((addr) => {
    try {
      return getAddress(addr);
    } catch {
      console.warn(`Invalid address format: ${addr}`);
      return addr;
    }
  });

  // First, check tokenService for known tokens
  for (const addr of normalizedAddresses) {
    if (!chainCache[addr]) {
      const tokenInfo = await getTokenByAddress(addr, chainId.toString());
      if (tokenInfo) {
        chainCache[addr] = {
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals
        };
      }
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

  let client;
  try {
    client = await getClient(chainId);
  } catch (error) {
    console.warn(`Failed to get client for chain ${chainId}, using fallback RPC`);
    const fallbackRpc = chain.id === 1 
      ? "https://ethereum-rpc.publicnode.com"
      : "https://rpc.ankr.com/eth";
    client = createPublicClient({
      chain,
      transport: http(fallbackRpc, {
        retryCount: 3,
        retryDelay: 1000,
        timeout: 30000,
      }),
    });
  }

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
      // Try to get token info from tokenService for other chains
      let foundInOtherChain = false;
      const chainIds = ["1", "10", "137", "42161", "8453", "252"]; // Common chain IDs
      for (const otherChainId of chainIds) {
        if (otherChainId !== chainId.toString()) {
          const tokenInfo = await getTokenByAddress(normalizedAddress, otherChainId);
          if (tokenInfo) {
            console.warn(
              `Token ${normalizedAddress} appears to be from chain ${otherChainId}, not chain ${chainId}. Using known info.`
            );
            decimals = tokenInfo.decimals;
            symbol = tokenInfo.symbol;
            foundInOtherChain = true;
            break;
          }
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
      // Try to get token info from tokenService for other chains
      let foundInOtherChain = false;
      const chainIds = ["1", "10", "137", "42161", "8453", "252"]; // Common chain IDs
      for (const otherChainId of chainIds) {
        if (otherChainId !== chainId.toString()) {
          const tokenInfo = await getTokenByAddress(normalizedAddress, otherChainId);
          if (tokenInfo) {
            console.warn(
              `Token ${normalizedAddress} appears to be from chain ${otherChainId}, not chain ${chainId}. Using known info.`
            );
            symbol = tokenInfo.symbol;
            foundInOtherChain = true;
            break;
          }
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
      let ethereumClient;
      try {
        ethereumClient = await getClient(1);
      } catch (error) {
        console.warn(`Failed to get Ethereum client, using fallback RPC`);
        ethereumClient = createPublicClient({
          chain: merkleChain,
          transport: http("https://ethereum-rpc.publicnode.com", {
            retryCount: 3,
            retryDelay: 1000,
            timeout: 30000,
          }),
        });
      }

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
  let client;
  try {
    client = await getClient(chain.id);
  } catch (error) {
    console.warn(`Failed to get client for chain ${chain.id}, using fallback RPC`);
    // Use a reliable public RPC as fallback
    const fallbackRpc = chain.id === 1 
      ? "https://ethereum-rpc.publicnode.com"
      : chain.rpcUrls.default.http[0];
    client = createPublicClient({
      chain,
      transport: http(fallbackRpc, {
        retryCount: 3,
        retryDelay: 1000,
        timeout: 30000,
      }),
    });
  }
  
  if (!client) {
    throw new Error(`Failed to create client for chain ${chain.id}`);
  }

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
