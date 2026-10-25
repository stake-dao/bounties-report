import { PublicClient } from "viem";

export async function readExpiryRound(client: PublicClient) {
  const block = await client.getBlock({ blockTag: "finalized" });
  const date = new Date(Number(block.timestamp) * 1000);
  const round = date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;
  const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  return { round, startsAt, block: Number(block.number), blockHash: block.hash, timestamp: Number(block.timestamp) };
}
