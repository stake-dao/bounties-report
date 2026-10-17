import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { Abi, Hex, parseAbi, parseAbiItem, PublicClient } from "viem";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import { MerkleData } from "../../interfaces/MerkleData";
import { EXPIRY_DISTRIBUTOR, verifyExpiryParent } from "../../shared/merkle/expiry";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { getClient } from "../../utils/getClients";

export async function readActiveVotersMerkle(chainId: number, root: string, client?: PublicClient): Promise<MerkleData> {
  if (![1, 8453, 42161].includes(chainId)) throw new Error("expiry chain");
  const verified = (merkle: MerkleData, target: string) => {
    verifyExpiryParent(merkle);
    if (merkle.merkleRoot.toLowerCase() !== target.toLowerCase()) throw new Error("active root changed; regenerate distribution");
    return merkle;
  };
  const local = (target: string): MerkleData | null => {
    const file = path.join("bounties-reports/expiry/roots", String(chainId), `${target.toLowerCase()}.json`);
    return fs.existsSync(file) ? verified(JSON.parse(fs.readFileSync(file, "utf8")), target) : null;
  };
  const stored = local(root);
  if (stored) return stored;
  try {
    const response = await fetch(`https://hub.stakedao.org/v1/merkles/active?chainId=${chainId}`);
    if (response.ok) return verified(await response.json() as MerkleData, root);
  } catch {}
  const rpc = client ?? await getClient(chainId);
  if (await rpc.getChainId() !== chainId) throw new Error("expiry RPC chain");
  const iface = new utils.Interface(expiryAbi);
  const ROOT_SET = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
  const ROOT_ABI = parseAbi(["function root() view returns(bytes32)"]);
  const visiting = new Set<string>();
  const resolve = async (target: Hex, upper?: bigint): Promise<MerkleData> => {
    if (visiting.has(target)) throw new Error("expiry parent cycle");
    visiting.add(target);
    const stored = local(target);
    if (stored) return stored;
    let publication: Response | null = null;
    try { publication = await fetch(`https://raw.githubusercontent.com/stake-dao/bounties-report/main/bounties-reports/expiry/roots/${chainId}/${target.toLowerCase()}.json`); } catch {}
    if (publication?.ok) return verified(await publication.json() as MerkleData, target);
    let high = upper ?? await rpc.getBlockNumber({ cacheTime: 0 });
    const recent = await rpc.getLogs({ address: EXPIRY_DISTRIBUTOR, event: ROOT_SET, args: { newRoot: target }, fromBlock: high > 9999n ? high - 9999n : 0n, toBlock: high });
    const located = recent[recent.length - 1]?.blockNumber;
    if (located !== undefined && located !== null) high = located;
    else {
      const at = async (blockNumber: bigint) => {
        const code = await rpc.getBytecode({ address: EXPIRY_DISTRIBUTOR, blockNumber });
        return code && code !== "0x" ? rpc.readContract({ address: EXPIRY_DISTRIBUTOR, abi: ROOT_ABI, functionName: "root", blockNumber }) : null;
      };
      if (await at(high) !== target) throw new Error("expiry activation unavailable");
      let low = 0n;
      while (high - low > 1n) {
        const middle = (high + low) / 2n;
        if (await at(middle) === target) high = middle;
        else low = middle;
      }
    }
    const events = await rpc.getLogs({ address: EXPIRY_DISTRIBUTOR, event: ROOT_SET, args: { newRoot: target }, fromBlock: high, toBlock: high });
    for (const event of events.reverse()) {
      if (!event.transactionHash || event.removed) continue;
      const receipt = await rpc.getTransactionReceipt({ hash: event.transactionHash });
      const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== "success" || receipt.blockHash !== block.hash) throw new Error("expiry receipt reorged");
      const activations = receipt.logs.filter(log => log.topics[0] === iface.getEventTopic("Activated")).map(log => ({ address: log.address, event: iface.parseLog({ topics: [...log.topics], data: log.data }) }));
      const activation = activations.find(({ event: row }) => row.args.root === target && row.args.digest === event.args.newIpfsHash);
      if (!activation) continue;
      const parent = await resolve(activation.event.args.parent, receipt.blockNumber - 1n);
      const distribution = verifyExpiryParent(parent);
      const treasury = utils.getAddress(String(await rpc.readContract({ address: activation.address, abi: expiryAbi as Abi, functionName: "TREASURY", blockNumber: receipt.blockNumber })));
      const changes = receipt.logs.filter(log => log.address.toLowerCase() === activation.address.toLowerCase() && log.topics[0] === iface.getEventTopic("Reduced")).map(log => iface.parseLog({ topics: [...log.topics], data: log.data }).args).filter(row => row.digest === activation.event.args.digest);
      const seen = new Set<string>();
      let token: string | null = null;
      let total = 0n;
      for (const change of changes) {
        const account = utils.getAddress(change.account), reward = utils.getAddress(change.token);
        if (seen.has(account) || account === treasury || (token !== null && token !== reward)) throw new Error("expiry rows");
        seen.add(account);
        token = reward;
        const amount = distribution[account]?.[reward];
        if (amount === undefined || BigInt(amount) < BigInt(change.paid.toString()) + BigInt(change.amount.toString())) throw new Error("expiry claimed floor");
        distribution[account][reward] = (BigInt(amount) - BigInt(change.amount.toString())).toString();
        total += BigInt(change.amount.toString());
      }
      if (token === null || total !== BigInt(activation.event.args.recovered.toString()) || distribution[treasury]?.[token] === undefined) throw new Error("expiry treasury conservation");
      distribution[treasury][token] = (BigInt(distribution[treasury][token]) + total).toString();
      return verified(generateMerkleTree(distribution), target);
    }
    throw new Error("active root has no reconstructible expiry receipt");
  };
  return resolve(root as Hex);
}
