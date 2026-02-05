import { formatUnits } from "viem";
import { sendTelegramMessage } from "../../utils/telegramUtils";
import { tokenService } from "../../utils/tokenService";

interface TokenClaim {
  rewardToken: string;
  amount: string | number | bigint;
  chainId?: number;
  isWrapped?: boolean;
  protocol?: string;
}

type ClaimsData = Record<string, Record<string, TokenClaim>>;
type AggregatedClaims = Record<string, Record<string, bigint>>;

export class ClaimsTelegramLogger {
  /**
   * Retrieves token info using tokenService with RPC fallback
   */
  private async getTokenInfo(
    tokenAddress: string,
    chainId: number
  ): Promise<{ symbol: string; decimals: number }> {
    try {
      // Try to get token from service (includes RPC fallback for unknown tokens)
      const tokenInfo = await tokenService.getTokenByAddress(
        tokenAddress,
        chainId.toString()
      );

      if (tokenInfo) {
        return {
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
        };
      }

      // If still not found, try to get at least decimals
      const decimals = await tokenService.getTokenDecimals(
        tokenAddress,
        chainId.toString()
      );

      console.warn(`Token ${tokenAddress} on chain ${chainId} not found in token service or RPC, using fallback`);
      
      return {
        symbol: this.formatUnknownToken(tokenAddress),
        decimals,
      };
    } catch (error) {
      console.warn(`Failed to get token info for ${tokenAddress} on chain ${chainId}:`, error);
      return {
        symbol: this.formatUnknownToken(tokenAddress),
        decimals: 18,
      };
    }
  }

  /**
   * Format unknown token address for display
   */
  private formatUnknownToken(address: string): string {
    return `Unknown (${address.slice(0, 6)}...${address.slice(-4)})`;
  }

  /**
   * Safely converts an amount to BigInt
   */
  private toBigInt(amount: string | number | bigint): bigint {
    if (typeof amount === "bigint") return amount;

    try {
      return BigInt(amount);
    } catch {
      // Handle floating point numbers
      if (typeof amount === "number") {
        return BigInt(Math.round(amount));
      }
      if (typeof amount === "string" && amount.includes(".")) {
        return BigInt(Math.round(parseFloat(amount)));
      }
      console.warn(`Failed to convert amount: ${amount}`);
      return 0n;
    }
  }

  /**
   * Aggregates claims by token address
   */
  private aggregateClaims(claims: ClaimsData): AggregatedClaims {
    const aggregated: AggregatedClaims = {};

    for (const protocol in claims) {
      const protocolClaims = claims[protocol];
      aggregated[protocol] = {};

      for (const claimIndex in protocolClaims) {
        const claim = protocolClaims[claimIndex];
        const { rewardToken, amount } = claim;

        if (!aggregated[protocol][rewardToken]) {
          aggregated[protocol][rewardToken] = 0n;
        }

        aggregated[protocol][rewardToken] += this.toBigInt(amount);
      }
    }

    return aggregated;
  }

  /**
   * Extract claim metadata for a token
   */
  private getClaimMetadata(
    claims: ClaimsData,
    protocol: string,
    tokenAddress: string,
    defaultChainId: number
  ): { chainId: number; isWrapped: boolean; protocolInfo: string } {
    let chainId = defaultChainId;
    let isWrapped = false;
    let protocolInfo = "";

    // Find first claim with this token to get metadata
    for (const claimIndex in claims[protocol]) {
      const claim = claims[protocol][claimIndex];
      if (claim.rewardToken === tokenAddress) {
        chainId = claim.chainId ?? defaultChainId;
        isWrapped = claim.isWrapped ?? false;
        protocolInfo = claim.protocol ? ` (${claim.protocol})` : "";
        break;
      }
    }

    return { chainId, isWrapped, protocolInfo };
  }

  /**
   * Format protocol display name
   */
  private formatProtocolName(title: string): string {
    const [protocol, fileName] = title.split("/");
    if (fileName?.includes("vlaura")) {
      return `${protocol}-aura`;
    }
    if (fileName?.includes("convex")) {
      return `${protocol}-convex`;
    }
    return protocol;
  }

  /**
   * Build GitHub report URL
   */
  private buildReportUrl(period: number, title: string): string {
    return `https://github.com/stake-dao/bounties-report/tree/main/weekly-bounties/${period}/${title}`;
  }

  /**
   * Format period date for display
   */
  private formatPeriodDate(period: number): string {
    return new Date(period * 1000).toLocaleDateString("fr-FR");
  }

  /**
   * Logs claim data to Telegram
   */
  async logClaims(
    title: string,
    currentPeriod: number,
    claims: ClaimsData,
    defaultChainId: number = 1
  ): Promise<void> {
    const aggregated = this.aggregateClaims(claims);
    const displayProtocol = this.formatProtocolName(title);
    const reportUrl = this.buildReportUrl(currentPeriod, title);

    // Build message header
    let message = `<a href="${reportUrl}"><b>[Distribution] Claimed bounties for ${displayProtocol.toUpperCase()}</b></a>\n\n`;
    message += `<b>Period:</b> ${this.formatPeriodDate(currentPeriod)}\n\n`;

    // Process each protocol
    for (const protocol in aggregated) {
      message += `<b>${protocol.toUpperCase()}</b>\n\n`;

      // Process each token
      for (const tokenAddress in aggregated[protocol]) {
        try {
          const { chainId, isWrapped, protocolInfo } = this.getClaimMetadata(
            claims,
            protocol,
            tokenAddress,
            defaultChainId
          );

          // Use mainnet (chainId 1) for wrapped tokens
          const effectiveChainId = isWrapped ? 1 : chainId;
          const tokenInfo = await this.getTokenInfo(tokenAddress, effectiveChainId);
          
          const amount = aggregated[protocol][tokenAddress];
          const formattedAmount = formatUnits(amount, tokenInfo.decimals);
          const displayAmount = parseFloat(formattedAmount).toFixed(2);

          const wrappedIndicator = isWrapped ? " [Wrapped]" : "";
          message += `• ${tokenInfo.symbol}${protocolInfo}: <code>${displayAmount}</code> [Chain: ${chainId}]${wrappedIndicator}\n\n`;
        } catch (err) {
          console.error(`Error processing token ${tokenAddress}:`, err);
          // Fallback formatting
          const shortAddress = this.formatUnknownToken(tokenAddress);
          const fallbackAmount = formatUnits(aggregated[protocol][tokenAddress], 18);
          message += `• ${shortAddress}: <code>${fallbackAmount}</code> [Chain: Unknown]\n\n`;
        }
      }
    }

    await sendTelegramMessage(message, "HTML");
  }
}
