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
  const failures: string[] = [];
  try {
    const explorerUtils = createBlockchainExplorerUtils();
    const block = await explorerUtils.getBlockNumberByTimestamp(timestamp, closest, chain_id);
    if (block > 0) {
      return block;
    }
    failures.push("explorer: no closest block");
  } catch (error) {
    failures.push(`explorer: ${error}`);
  }
  try {
    const chainName = CHAINS_IDS_TO_SHORTS[chain_id];
    const url = `https://coins.llama.fi/block/${chainName}/${timestamp}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      const data = await response.json();
      if (data.height > 0) {
        return data.height;
      }
      failures.push("llama: no height");
    } else {
      failures.push(`llama: HTTP ${response.status}`);
    }
  } catch (error) {
    failures.push(`llama: ${error}`);
  }
  throw new Error(
    `No block ${closest} timestamp ${timestamp} on chain ${chain_id} (${failures.join("; ")})`
  );
};
