import assert from "node:assert/strict";
import { encodeAbiParameters, getAddress, hashTypedData, keccak256, parseAbi, parseAbiParameters, concat, toHex, Hex } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { verifyExpiryParent } from "../shared/merkle/expiry";
import { Review, TREASURY_RECIPIENT, pairKey, refreshRecovery } from "./prepare";

export const MODULE_ABI = parseAbi([
  "function nonce() view returns(uint256)",
  "function proposal() view returns(bytes32)",
  "function validAt() view returns(uint256)",
  "function DISTRIBUTOR() view returns(address)",
  "function SAFE() view returns(address)",
  "function TREASURY() view returns(address)",
  "function SIGNER() view returns(address)",
  "function check(bytes) view",
  "function prepare(bytes,bytes)",
  "function activate(bytes)",
  "event Activated(bytes32 indexed proposal,bytes32 indexed parent,bytes32 indexed root)",
]);

export const BATCH = parseAbiParameters("(uint256 nonce,bytes32 parent,bytes32 root,bytes32 ledger,(address account,uint256 tokenIndex,uint256 beforeAmount,uint256 afterAmount,uint256 claimed)[] rows,(address token,uint256 beforeAmount,uint256 afterAmount,uint256 fundingOffset,bytes32[] proof)[] credits,bytes program,bytes32[] nodes,bytes32 expectedProposal)");
const leaf = (account: string, token: string, amount: string) => keccak256(keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint256"), [getAddress(account), getAddress(token), BigInt(amount)])));
const keyHash = (account: string, token: string) => keccak256(encodeAbiParameters(parseAbiParameters("address,address"), [getAddress(account), getAddress(token)]));
const pair = (a: Hex, b: Hex) => keccak256(concat(a < b ? [a, b] : [b, a]));

/** Encode the exact shape used by merkletreejs (sorted pairs, odd-node promotion).
 * There is deliberately no insertion opcode: a missing zero leaf is not membership.
 */
export function transition(review: Review, source: MerkleData, recovery: ReturnType<typeof refreshRecovery>, module: string, nonce: bigint, expectedProposal: Hex) {
  assert(review.chainId === 1 && review.recipient === TREASURY_RECIPIENT, "automatic recovery is Ethereum Treasury only");
  verifyExpiryParent(source);
  const tokens = Object.keys(recovery.grossTotals).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const credits = tokens.map(token => {
    const opening = source.claims[TREASURY_RECIPIENT]?.tokens[token];
    assert(opening, `Treasury leaf absent for ${token}; seed it through a validated ordinary publication`);
    const closing = recovery.merkle.claims[TREASURY_RECIPIENT].tokens[token];
    return { token: getAddress(token), beforeAmount: BigInt(opening.amount), afterAmount: BigInt(closing.amount), fundingOffset: recovery.fundingOffsets[token] ?? 0n, proof: closing.proof as Hex[] };
  });
  const rows = recovery.rows.map(row => ({
    account: getAddress(row.account), tokenIndex: BigInt(tokens.indexOf(row.token)),
    beforeAmount: BigInt(source.claims[row.account].tokens[row.token].amount),
    afterAmount: BigInt(recovery.merkle.claims[row.account].tokens[row.token].amount), claimed: BigInt(row.claimed),
  })).sort((a, b) => keyHash(a.account, tokens[Number(a.tokenIndex)]).localeCompare(keyHash(b.account, tokens[Number(b.tokenIndex)])));
  assert(rows.length > 0 && rows.length <= 256 && credits.length <= 64, "transition batch bounds");
  const changed = new Map(rows.map((row, i) => [pairKey(row.account, tokens[Number(row.tokenIndex)]), [1, i >> 8, i & 255]]));
  credits.forEach((credit, i) => changed.set(pairKey(TREASURY_RECIPIENT, credit.token), [2, i]));
  type Node = { hash: Hex; changed: boolean; op?: number[]; children?: Node[] };
  let layer: Node[] = Object.entries(source.claims).flatMap(([account, claim]) => Object.entries(claim.tokens).map(([token, value]) => ({ hash: leaf(account, token, value.amount), changed: changed.has(pairKey(account, token)), op: changed.get(pairKey(account, token)) })));
  while (layer.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i], b = layer[i + 1];
      next.push(b ? { hash: pair(a.hash, b.hash), changed: a.changed || b.changed, children: [a, b] } : a);
    }
    layer = next;
  }
  assert.equal(layer[0].hash, source.merkleRoot, "parent tree encoding mismatch");
  const program: number[] = [], nodes: Hex[] = [];
  const visit = (node: Node) => {
    if (!node.changed) { program.push(0); nodes.push(node.hash); }
    else if (node.op) program.push(...node.op);
    else { node.children!.forEach(visit); program.push(3); }
  };
  visit(layer[0]);
  assert(program.length <= 8192 && nodes.length <= 2048, "frontier bounds");
  const ledger = keccak256(toHex(JSON.stringify(review)));
  const payload = encodeAbiParameters(BATCH, [{ nonce, parent: source.merkleRoot as Hex, root: recovery.merkle.merkleRoot as Hex, ledger, rows, credits, program: toHex(new Uint8Array(program)), nodes, expectedProposal }]);
  assert((payload.length - 2) / 2 < 110000, "transition exceeds transaction size budget");
  const proposal = hashTypedData({ domain: { name: "StakeDAO RewardsExpiry", version: "1", chainId: 1, verifyingContract: getAddress(module) }, types: { Authorization: [{ name: "payloadHash", type: "bytes32" }] }, primaryType: "Authorization", message: { payloadHash: keccak256(payload) } });
  return { module: getAddress(module), nonce: nonce.toString(), expectedProposal, proposal, payload, ledger };
}
