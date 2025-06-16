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
import { clients, getOptimizedClient, VOTIUM_FORWARDER_REGISTRY, CVX_SPACE, CVX_FXN_SPACE } from "./constants";
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

  // Filter out addresses that are already cached
  const uncachedAddresses = normalizedAddresses.filter(
    (addr) => !chainCache[addr]
  );

  // If all tokens are cached, return the cached data
  if (uncachedAddresses.length === 0) {
    console.log(`All ${normalizedAddresses.length} tokens found in cache`);
    const result: { [token: string]: { decimals: number; symbol: string } } =
      {};
    for (const addr of normalizedAddresses) {
      result[addr] = chainCache[addr];
    }
    return result;
  }

  console.log(
    `Fetching info for ${uncachedAddresses.length} uncached tokens (${normalizedAddresses.length - uncachedAddresses.length} cached)`
  );

  const client = await getOptimizedClient(chainId) || createPublicClient({
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
      console.warn(
        `Failed to fetch decimals for ${normalizedAddress}, defaulting to 18`
      );
    }

    if (symbolResults[i].status === "success") {
      symbol = symbolResults[i].result as string;
    } else {
      console.warn(
        `Failed to fetch symbol for ${normalizedAddress}, using UNKNOWN`
      );
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
  proposalId: any,
  chainId: string = "1"
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
      const ethereumClient = await getOptimizedClient(1) || createPublicClient({
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
      
      console.log(`Votium Current Epoch: ${currentEpoch} (${new Date(Number(currentEpoch) * 1000).toUTCString()})`);
      console.log(`Proposal Start: ${proposalStartTimestamp} (${new Date(proposalStartTimestamp * 1000).toUTCString()})`);
      
      if (Number(currentEpoch) !== proposalStartTimestamp) {
        console.warn(`⚠️  WARNING: Votium epoch (${currentEpoch}) does not match proposal start (${proposalStartTimestamp})`);
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
  await delegationLogger(space, activeProposal, votes, log, chainId);
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

  const comparisonRows = await compareMerkleData(
    currentMerkleData,
    previousMerkleData,
    distribution,
    merkleChain,
    merkleAddress,
    tokenInfos,
    weekChangeTotals
  );
  logDistributionRowsToFile(comparisonRows, tokenInfos, log);

  // --- Log formatted week-change totals per token ---
  console.log("\n=== Week Changes ===");
  for (const tokenAddr of tokenAddresses) {
    const info = tokenInfos[tokenAddr] || { decimals: 18, symbol: "UNKNOWN" };
    const total = weekChangeTotals[tokenAddr] || 0n;
    const formatted = Number(total) / 10 ** info.decimals;
    console.log(`${info.symbol} (${tokenAddr}): ${formatted.toFixed(2)}`);
  }
};

const compareMerkleData = async (
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  distribution: { [address: string]: { tokens: { [token: string]: bigint } } },
  chain: Chain,
  merkleAddress: `0x${string}`,
  tokenInfos: { [token: string]: { decimals: number; symbol: string } },
  weekChangeTotals: { [token: string]: bigint }
): Promise<DistributionRow[]> => {
  const client = await getOptimizedClient(chain.id) || createPublicClient({
    chain,
    transport: http(),
  });

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
      if (tokenWeekChangeTotal && tokenWeekChangeTotal > 0n && weekChangeRaw > 0n) {
        weekChangePercentage = (Number(weekChangeRaw) / Number(tokenWeekChangeTotal)) * 100;
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
      };

      distributionRows.push(row);
    }
  }

  return distributionRows;
};

const logDistributionRowsToFile = (
  distributionRows: DistributionRow[],
  tokenInfos: { [token: string]: { decimals: number; symbol: string } },
  log: (message: string) => void
) => {
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
    "Previous Amount",
    "New Amount",
    "Week Change",
    "% of Token",
    "Distribution Amount",
    "Claimed",
    "Distribution correct",
  ];

  const rows = distributionRows.map((row) => {
    const tokenInfo = tokenInfos[row.tokenAddress] || {
      decimals: 18,
      symbol: row.symbol,
    };
    const decimals = tokenInfo.decimals;
    // Convert raw BigInt values to floating point numbers for display
    const formattedPrev = Number(row.prevAmount) / 10 ** decimals;
    const formattedNew = Number(row.newAmount) / 10 ** decimals;
    const formattedWeekChange = Number(row.weekChange) / 10 ** decimals;
    const formattedDistribution =
      Number(row.distributionAmount) / 10 ** decimals;

    const percentageStr = row.weekChange > 0n && row.weekChangePercentage !== undefined
      ? `${row.weekChangePercentage.toFixed(2)}%`
      : "-";

    return [
      formatAddress(row.address),
      tokenInfo.symbol.toUpperCase(),
      formattedPrev.toFixed(2),
      formattedNew.toFixed(2),
      formattedWeekChange.toFixed(2),
      percentageStr,
      formattedDistribution.toFixed(2),
      row.claimed ? "✅" : "❌",
      row.isError ? "❌" : "✅",
    ];
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
  const fileContent = [headerLine, separatorLine, ...formattedRows].join("\n");

  log(fileContent + "\n\n");
};
