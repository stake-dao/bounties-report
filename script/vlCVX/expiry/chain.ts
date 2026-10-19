import { utils } from "ethers";
import { Abi, Hash, PublicClient } from "viem";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import { ConfirmedExpiry, EXPIRY_DISTRIBUTOR, expiryDigest, PreparedExpiry } from "../../shared/merkle/expiry";
import { ALL_MIGHT_V2 } from "../../utils/constants";

const iface = new utils.Interface(expiryAbi);

export async function readConfirmedExpiry(client: PublicClient, prepared: PreparedExpiry, hash: Hash): Promise<ConfirmedExpiry | null> {
  const [receipt, finalized] = await Promise.all([client.getTransactionReceipt({ hash }), client.getBlock({ blockTag: "finalized" })]);
  if (receipt.status !== "success") throw new Error("expiry transaction failed");
  if (finalized.number === null || receipt.blockNumber > finalized.number) return null;
  const [block, checkpoint, actualDigest, owner, preparer, treasury, delay, distributor] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlock({ blockNumber: BigInt(prepared.state.checkpoint.block) }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "digest", args: [prepared.batch], blockNumber: receipt.blockNumber }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "SAFE", blockNumber: receipt.blockNumber }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "PREPARER", blockNumber: receipt.blockNumber }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "TREASURY", blockNumber: receipt.blockNumber }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "DELAY", blockNumber: receipt.blockNumber }),
    client.readContract({ address: prepared.module.address as Hash, abi: expiryAbi as Abi, functionName: "DISTRIBUTOR", blockNumber: receipt.blockNumber }),
  ]);
  if (block.hash !== receipt.blockHash || checkpoint.hash !== prepared.state.checkpoint.blockHash) throw new Error("expiry input or receipt reorged");
  if (actualDigest !== expiryDigest(prepared) || prepared.module.preparer?.toLowerCase() !== ALL_MIGHT_V2.toLowerCase() || String(preparer).toLowerCase() !== prepared.module.preparer.toLowerCase() || String(owner).toLowerCase() !== prepared.module.safe.toLowerCase() || String(treasury).toLowerCase() !== prepared.treasury.toLowerCase() || String(distributor).toLowerCase() !== EXPIRY_DISTRIBUTOR.toLowerCase() || BigInt(delay as bigint) !== BigInt(prepared.module.delay)) throw new Error("expiry module domain");
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === prepared.module.address.toLowerCase()).map(log => ({ log, event: iface.parseLog({ topics: [...log.topics], data: log.data }) }));
  const activations = logs.filter(({ event }) => event.name === "Activated" && event.args.digest === actualDigest);
  if (activations.length !== 1) throw new Error("expiry activation event missing");
  const { event, log } = activations[0];
  const changed = event.args.root !== event.args.parent;
  const rootSets = receipt.logs.filter(row => row.address.toLowerCase() === EXPIRY_DISTRIBUTOR.toLowerCase() && row.topics[0] === utils.id("RootSet(bytes32,bytes32)") && row.topics[1] === event.args.root && row.topics[2] === actualDigest);
  if (changed && rootSets.length !== 1) throw new Error("distributor activation missing");
  if (!changed && !event.args.recovered.isZero()) throw new Error("unchanged root with recovery");
  return {
    digest: String(actualDigest), parent: event.args.parent, root: event.args.root, recovered: event.args.recovered.toString(), transactionHash: receipt.transactionHash,
    logIndex: log.logIndex!, block: Number(receipt.blockNumber), blockHash: receipt.blockHash, timestamp: Number(block.timestamp),
    rows: logs.filter(({ event }) => event.name === "Reduced" && event.args.digest === actualDigest).map(({ event }) => ({ account: event.args.account, token: event.args.token, paid: event.args.paid.toString(), amount: event.args.amount.toString() })),
  };
}
