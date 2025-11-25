import { getAddress, encodePacked, keccak256, pad } from "viem";
import { getClosestBlockTimestamp } from "../utils/chainUtils";
import { FRAXTAL_SD_FXS, SD_FXS, SDFXS_UNIVERSAL_MERKLE } from "../utils/constants";
import { getClient } from "../utils/getClients";

export interface SdFXSTransferResult {
  amount: bigint;
  blockNumber: number;
  txHashes: string[];
}

/**
 * Fetches sdFXS transfers to the Fraxtal recipient address during the specified week
 * @param weekTimestamp - The timestamp of the week start (should be aligned to WEEK)
 * @returns Total sdFXS amount transferred and transaction details
 */
export async function getSdFXSTransfersOnFraxtal(weekTimestamp: number): Promise<SdFXSTransferResult> {
  // Create Fraxtal client using getClient for automatic RPC selection
  const fraxtalClient = await getClient(252);

  // Get block numbers for the week
  const startBlock = await getClosestBlockTimestamp("fraxtal", weekTimestamp);
  const endBlock = Number(await fraxtalClient.getBlockNumber());

  console.log(`Fetching sdFXS transfers on Fraxtal from block ${startBlock} to ${endBlock}`);

  // Transfer event signature
  // const transferSig = "Transfer(address,address,uint256)";
  // const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  // Pad the recipient address for topic matching
  // const paddedRecipient = pad(FRAXTAL_RECIPIENT as `0x${string}`, { size: 32 }).toLowerCase();

  // Get transfer logs
  const logs = await fraxtalClient.getLogs({
    address: FRAXTAL_SD_FXS as `0x${string}`,
    event: {
      type: 'event',
      name: 'Transfer',
      inputs: [
        { type: 'address', indexed: true, name: 'from' },
        { type: 'address', indexed: true, name: 'to' },
        { type: 'uint256', indexed: false, name: 'value' }
      ]
    },
    fromBlock: BigInt(startBlock),
    toBlock: BigInt(endBlock),
    args: {
      to: SDFXS_UNIVERSAL_MERKLE as `0x${string}`
    }
  });

  // Process logs to calculate total amount
  let totalAmount = 0n;
  const txHashes: string[] = [];
  let latestBlockNumber = 0;

  for (const log of logs) {
    if (log.args && 'value' in log.args) {
      totalAmount += log.args.value as bigint;
    }

    const blockNumber = Number(log.blockNumber);
    if (blockNumber > latestBlockNumber) {
      latestBlockNumber = blockNumber;
    }

    // Add unique transaction hashes
    if (log.transactionHash && !txHashes.includes(log.transactionHash)) {
      txHashes.push(log.transactionHash);
    }
  }

  console.log(`Found ${logs.length} sdFXS transfers totaling ${totalAmount.toString()} wei`);
  console.log(`Transaction hashes: ${txHashes.join(", ")}`);

  return {
    amount: totalAmount,
    blockNumber: latestBlockNumber,
    txHashes
  };
}