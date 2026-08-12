import {
  getAddress,
  decodeAbiParameters,
  encodePacked,
  keccak256,
  pad,
} from "viem";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { VLCVX_DELEGATORS_MERKLE } from "../utils/constants";

export type ScrvUsdTransfer = {
  txHash: string;
  amount: bigint;
};

/**
 * Every sCRVUSD amount minted to the delegators distributor in the block
 * range, with the per-transaction breakdown callers need to tell the sources
 * apart (all of them mint from the zero address, so the amounts alone say
 * nothing about where the value came from).
 *
 * An empty range is a legitimate result, not an error: a week can distribute a
 * carried-over half with no fresh deposit at all. Callers that require money
 * to have arrived check the total themselves.
 */
export async function getSCRVUsdTransfer(minBlock: number, maxBlock: number) {
  const explorerUtils = createBlockchainExplorerUtils();
  const scrvUsdAddress = getAddress(
    "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367"
  );

  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedVlcvxRecipient = pad(VLCVX_DELEGATORS_MERKLE as `0x${string}`, { size: 32 }).toLowerCase();

  const topics = {
    "0": transferHash,
    "2": paddedVlcvxRecipient,
  };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    [scrvUsdAddress],
    minBlock,
    maxBlock,
    topics,
    1
  );

  let totalAmount = 0n;
  let latestBlockNumber = 0;
  const txHashes: string[] = [];
  const perTx = new Map<string, bigint>();

  for (const transfer of response.result) {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], transfer.data);
    totalAmount += BigInt(amount);

    const blockNumber = parseInt(transfer.blockNumber, 16);
    if (blockNumber > latestBlockNumber) {
      latestBlockNumber = blockNumber;
    }

    // Add transaction hash to the array if it doesn't already exist
    if (!txHashes.includes(transfer.transactionHash)) {
      txHashes.push(transfer.transactionHash);
    }
    perTx.set(
      transfer.transactionHash,
      (perTx.get(transfer.transactionHash) ?? 0n) + BigInt(amount)
    );
  }

  const transfers: ScrvUsdTransfer[] = txHashes.map((txHash) => ({
    txHash,
    amount: perTx.get(txHash) ?? 0n,
  }));

  return {
    amount: totalAmount,
    blockNumber: latestBlockNumber,
    txHashes,
    transfers,
  };
}
