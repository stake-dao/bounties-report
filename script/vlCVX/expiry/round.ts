import { parseAbi, PublicClient } from "viem";
import { VLCVX_ADDRESS, WEEK } from "../../utils/constants";

export async function readExpiryRound(client: PublicClient) {
  if (await client.getChainId() !== 1) throw new Error("vlCVX round source must be Ethereum");
  const block = await client.getBlock({ blockTag: "finalized" });
  const [, firstEpoch] = await client.readContract({ address: VLCVX_ADDRESS, abi: parseAbi(["function epochs(uint256) view returns(uint224,uint32)"]), functionName: "epochs", args: [0n], blockNumber: block.number! });
  if (firstEpoch % WEEK !== 0 || Number(block.timestamp) < firstEpoch + 3 * WEEK) throw new Error("vlCVX epoch origin");
  const round = 2 * Math.floor((Math.floor((Number(block.timestamp) - firstEpoch) / WEEK) - 1) / 2);
  return { round, contract: VLCVX_ADDRESS, firstEpoch, week: WEEK, block: Number(block.number), blockHash: block.hash, timestamp: Number(block.timestamp) };
}
