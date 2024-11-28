import { CHAINS_IDS_TO_SHORTS } from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";

export async function getClosestBlockTimestamp(
  chain: string,
  timestamp: number
): Promise<number> {
  const response = await fetch(
    `https://coins.llama.fi/block/${chain}/${timestamp}`
  );

  if (!response.ok) {
    const data = await response.json();
    console.error(data);
    throw new Error("Failed to get closest block timestamp");
  }

  const result = await response.json();
  return result.height;
}

export const getBlockNumberByTimestamp = async (
  timestamp: number,
  closest: "before" | "after" = "before",
  chain_id: number
): Promise<number> => {
  try {
    // Try explorer utils first
    const explorerUtils = createBlockchainExplorerUtils();
    const block = await explorerUtils.getBlockNumberByTimestamp(timestamp, closest, chain_id);
    
    if (block > 0) {
      return block;
    }

    // Fallback to Llama API with correct endpoint
    try {
      const chainName = CHAINS_IDS_TO_SHORTS[chain_id];
      const url = `https://coins.llama.fi/block/${chainName}/${timestamp}`;
      const response = await fetch(url, { 
        timeout: 10000,
        signal: AbortSignal.timeout(10000)
      });
      
      if (!response.ok) {
        return 0;
      }
      
      const data = await response.json();
      return data.height || 0;
    } catch {
      return 0;
    }
  } catch (error) {
    console.error('Error fetching block number:', error);
    return 0;
  }
};
