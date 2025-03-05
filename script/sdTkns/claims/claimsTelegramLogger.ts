// ClaimsTelegramLogger.ts
import { createPublicClient, http, formatUnits } from "viem";
import { mainnet, bsc, polygon, base, optimism, arbitrum } from "viem/chains";
import { sendTelegramMessage } from "../../utils/telegramUtils";
import { ethers } from "ethers";

const ERC20_ABI = [
  {
    name: "name",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    name: "symbol",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
];

export class ClaimsTelegramLogger {
  // Returns a public client for the given chain ID.
  private getPublicClientForChain(chainId: number) {
    if (chainId === 1) {
      return createPublicClient({ chain: mainnet, transport: http("https://rpc.flashbots.net") });
    } else if (chainId === 56) {
      return createPublicClient({ chain: bsc, transport: http("https://rpc.flashbots.net") });
    } else if (chainId === 137) {
      return createPublicClient({ chain: polygon, transport: http("https://rpc.flashbots.net") });
    } else if (chainId === 8453) {
      return createPublicClient({ chain: base, transport: http("https://base.meowrpc.com") });
    } else if (chainId === 10) {
      return createPublicClient({ chain: optimism, transport: http("https://rpc.flashbots.net") });
    } else if (chainId === 42161) {
      return createPublicClient({ chain: arbitrum, transport: http("https://1rpc.io/arb") });
    }
    // Default to mainnet if unknown.
    return createPublicClient({ chain: mainnet, transport: http("https://rpc.flashbots.net") });
  }

  // Retrieves ERC20 token info (name, symbol, decimals) from the token contract.
  private async getTokenInfo(client: any, tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
    try {
      // Try to get symbol and decimals
      const [symbol, decimals] = await Promise.all([
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "symbol",
          args: [],
        }).catch(() => `Unknown (${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)})`),
        client.readContract({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "decimals",
          args: [],
        }).catch(() => 18), // Default to 18 decimals if not available
      ]);
      return { symbol, decimals: Number(decimals) };
    } catch (error) {
      console.warn(`Failed to get complete token info for ${tokenAddress}, using fallback values`);
      return { 
        symbol: `Unknown (${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)})`, 
        decimals: 18 
      };
    }
  }

  /**
   * Aggregates claims by token address.
   *
   * also format amounts and put token names
  */
  private aggregateClaims(claims: any): { [protocol: string]: { [token: string]: bigint } } {
    const aggregated: { [protocol: string]: { [token: string]: bigint } } = {};

    for (const protocol in claims) {
      const protocolClaims = claims[protocol];
      
      // Iterate through numeric keys in the protocol claims
      for (const claimIndex in protocolClaims) {
        const claim = protocolClaims[claimIndex];
        const rewardToken = claim.rewardToken;
        
        // Safely convert amount to BigInt, handling non-integer values
        let amount: bigint;
        try {
          amount = BigInt(claim.amount);
        } catch (error) {
          // If direct conversion fails (e.g., for floating point numbers),
          // round to the nearest integer before converting
          if (error instanceof RangeError && typeof claim.amount === 'number') {
            amount = BigInt(Math.round(claim.amount));
          } else if (typeof claim.amount === 'string' && claim.amount.includes('.')) {
            // For string representations of floating point numbers
            amount = BigInt(Math.round(parseFloat(claim.amount)));
          } else {
            console.warn(`Failed to convert amount for ${protocol}/${claimIndex}: ${claim.amount}`);
            amount = 0n;
          }
        }
        
        if (!aggregated[protocol]) {
          aggregated[protocol] = {};
        }

        if (!aggregated[protocol][rewardToken]) {
          aggregated[protocol][rewardToken] = 0n;
        }
        
        aggregated[protocol][rewardToken] += amount;
      }
    }

    return aggregated;
  }

  private getTokensInfosAndFormatAmounts(aggregated: any): { [protocol: string]: { [token: string]: string } } {
    const result: { [protocol: string]: { [token: string]: string } } = {};
    
    for (const protocol in aggregated) {
      if (!result[protocol]) {
        result[protocol] = {};
      }
      
      const tokenAddresses = Object.keys(aggregated[protocol]);
      for (const tokenAddress of tokenAddresses) {
        // Get token symbol from address (would need a mapping or on-chain lookup)
        // For now, using the address as a placeholder
        const tokenSymbol = tokenAddress;
        const amount = aggregated[protocol][tokenAddress];
        
        // Format the amount (assuming 18 decimals for now)
        // In a real implementation, you'd get the decimals from token info
        const formattedAmount = formatUnits(amount, 18);
        
        // Add token amount to the protocol
        result[protocol][tokenSymbol] = parseFloat(formattedAmount).toFixed(2);
      }
    }
    
    return result;
  }

  /**
   * Logs claim data to Telegram:
   * - Aggregates raw claim amounts per token (using rewardToken addresses).
   * - For each token, queries on‑chain ERC20 info (name, symbol, decimals).
   * - Formats the aggregated amount using the token's decimals.
   * - Sends an HTML‑formatted message with token name, symbol, and formatted total.
   *
   * @param currentPeriod - The current period timestamp.
   * @param claims - The raw claims data.
   * @param defaultChainId - The default chain ID to use if not found in claims (defaults to 1).
   */
  async logClaims(title: string, currentPeriod: number, claims: any, defaultChainId: number = 1): Promise<void> {
    const aggregated = this.aggregateClaims(claims);

    let protocol = title.split('/')[0];
    const fileName = title.split('/')[1];

    if (fileName.includes("convex")) {
        protocol = protocol + "-convex";
    }
    
    // Build the message
    const reportUrl = `https://github.com/stake-dao/bounties-report/tree/main/weekly-bounties/${currentPeriod}/${protocol}/${title}`;
    let message = `<a href="${reportUrl}"><b>[Distribution] Claimed bounties for ${protocol.toUpperCase()}</b></a>\n\n`;
    message += `<b>Period:</b> ${new Date(currentPeriod * 1000).toISOString().split('T')[0]}\n\n`;
    
    // Process each protocol
    for (const protocol in aggregated) {
      message += `<b>${protocol.toUpperCase()}</b>\n`;
      message += `\n`
      
      // Process each token in this protocol
      for (const tokenAddress in aggregated[protocol]) {
        try {
          // Find chainId and isWrapped from the first claim for this token in this protocol
          let chainId = defaultChainId;
          let isWrapped = false;
          
          // Look for a claim with this token to get its chainId and isWrapped status
          for (const claimIndex in claims[protocol]) {
            const claim = claims[protocol][claimIndex];
            if (claim.rewardToken === tokenAddress) {
              if (claim.chainId) chainId = claim.chainId;
              if (claim.isWrapped !== undefined) isWrapped = claim.isWrapped;
              break;
            }
          }
          
          // If token is wrapped, always use Ethereum mainnet client
          // Otherwise use the client for the specified chain
          const client = isWrapped 
            ? this.getPublicClientForChain(1) // Use Ethereum mainnet for wrapped tokens
            : this.getPublicClientForChain(chainId);
          
          // Get token info from blockchain
          const tokenInfo = await this.getTokenInfo(client, tokenAddress);
          const amount = aggregated[protocol][tokenAddress];
          const formattedAmount = formatUnits(amount, tokenInfo.decimals);
          
          // Add to message with chain ID indicator and wrapped status if applicable
          const wrappedIndicator = isWrapped ? " [Wrapped]" : "";
          message += `• ${tokenInfo.symbol}: <code>${parseFloat(formattedAmount).toFixed(2)}</code> [Chain: ${chainId}]${wrappedIndicator}\n`;
          message += `\n`        } catch (err) {
          console.error(`Error processing token ${tokenAddress}: ${err}`);
          // Use address as fallback with shortened format
          const shortAddress = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
          message += `• Token ${shortAddress}: ${formatUnits(aggregated[protocol][tokenAddress], 18)} [Chain: Unknown]\n`;
        }
      }
      
      message += '\n';
    }

    // Send the message
    await sendTelegramMessage(message, "HTML");
  }
}

