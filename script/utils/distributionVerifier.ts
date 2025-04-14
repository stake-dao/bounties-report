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
import { getLastClosedProposal, getProposal, getVoters } from "./snapshot";
import fs from "fs";
import path from "path";
const merkleAbi = parseAbi([
  "function claimed(address,address) external view returns(uint256)",
]);

export const getAllTokensInfos = async (
  tokenAddresses: string[],
  chain: Chain
) => {
  const client = createPublicClient({
    chain,
    transport: http(),
  });

  const symbolCalls = tokenAddresses.map((tokenAddr) => ({
    address: tokenAddr as `0x${string}`,
    abi: erc20Abi,
    functionName: "symbol",
    args: [],
  }));

  const decimalsCalls = tokenAddresses.map((tokenAddr) => ({
    address: tokenAddr as `0x${string}`,
    abi: erc20Abi,
    functionName: "decimals",
    args: [],
  }));

  const decimalsResults = await client.multicall({ contracts: decimalsCalls });
  const symbolResults = await client.multicall({ contracts: symbolCalls });

  const tokenInfoMap: {
    [token: string]: { decimals: number; symbol: string };
  } = {};
  for (let i = 0; i < tokenAddresses.length; i++) {
    const normalizedAddress = getAddress(tokenAddresses[i]);
    tokenInfoMap[normalizedAddress] = {
      decimals:
        decimalsResults[i].status === "success"
          ? (decimalsResults[i].result as number)
          : 18,
      symbol:
        symbolResults[i].status === "success"
          ? (symbolResults[i].result as string)
          : normalizedAddress,
    };
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
  proposalId: any
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
  await delegationLogger(space, activeProposal, votes, log);
  log(`\nTotal Votes: ${votes.length}`);
  log(`\nHolder Distribution:`);

  const comparisonRows = await compareMerkleData(
    currentMerkleData,
    previousMerkleData,
    distribution,
    merkleChain,
    merkleAddress,
    tokenInfos
  );
  logDistributionRowsToFile(comparisonRows, tokenInfos, log);

  // --- Log formatted week-change totals per token ---
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
  tokenInfos: { [token: string]: { decimals: number; symbol: string } }
): Promise<DistributionRow[]> => {
  const client = createPublicClient({
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

      const row: DistributionRow = {
        address,
        symbol: tokenInfo.symbol,
        prevAmount: previousClaim,
        newAmount: currentClaim,
        weekChange: weekChangeRaw,
        distributionAmount: distributionAmountRaw,
        claimed: claimedAmount === previousClaim,
        isError: isAmountDifferent,
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
    return b.weekChange > a.weekChange ? 1 : -1;
  });

  const headers = [
    "Address",
    "Token",
    "Previous Amount",
    "New Amount",
    "Week Change",
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

    return [
      formatAddress(row.address),
      tokenInfo.symbol.toUpperCase(),
      formattedPrev.toFixed(2),
      formattedNew.toFixed(2),
      formattedWeekChange.toFixed(2),
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
