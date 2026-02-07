import {
  getAddress,
  decodeAbiParameters,
  encodePacked,
  keccak256,
  pad,
} from "viem";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { VLCVX_DELEGATORS_MERKLE } from "../utils/constants";

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

  if (response.result.length === 0) {
    throw new Error("No sCRVUSD transfers found");
  }

  let totalAmount = 0n;
  let latestBlockNumber = 0;
  const txHashes: string[] = [];

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
  }

  return {
    amount: totalAmount,
    blockNumber: latestBlockNumber,
    txHashes,
  };
}
