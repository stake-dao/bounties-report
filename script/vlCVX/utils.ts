import { getAddress } from "viem";
import { VLCVX_RECIPIENT } from "../utils/constants";
import { ALL_MIGHT, WETH_ADDRESS } from "../utils/reportUtils";
import MerkleTree from "merkletreejs";
import { utils } from "ethers";
import keccak256 from "keccak256";

export async function getSdCrvTransfer(publicClient: any) {
  const sdCrvAddress = "0x..."; // Replace with actual sdCRV address
  const transferFilter = await publicClient.createEventFilter({
    address: sdCrvAddress,
    event: "Transfer(address,address,uint256)",
    fromBlock: "latest",
    toBlock: "latest",
    args: {
      from: ALL_MIGHT,
      to: VLCVX_RECIPIENT,
    },
  });

  const logs = await publicClient.getFilterLogs({ filter: transferFilter });

  if (logs.length === 0) {
    throw new Error("No sdCRV transfer found");
  }

  const latestTransfer = logs[logs.length - 1];
  return {
    amount: BigInt(latestTransfer.args.value),
    blockNumber: Number(latestTransfer.blockNumber),
  };
}

export async function getTokenTransfersOut(
  publicClient: any,
  token: string,
  blockNumber: number
) {
  const transferFilter = await publicClient.createEventFilter({
    address: token,
    event: "Transfer(address,address,uint256)",
    fromBlock: BigInt(blockNumber),
    toBlock: BigInt(blockNumber),
    args: {
      from: ALL_MIGHT,
    },
  });

  const logs = await publicClient.getFilterLogs({ filter: transferFilter });

  return logs.map((log: any) => ({
    tokenAddress: getAddress(log.address),
    amount: BigInt(log.args.value),
  }));
}

export async function getWethTransfersIn(
  publicClient: any,
  blockNumber: number
) {
  const transferFilter = await publicClient.createEventFilter({
    address: WETH_ADDRESS,
    event: "Transfer(address,address,uint256)",
    fromBlock: BigInt(blockNumber),
    toBlock: BigInt(blockNumber),
    args: {
      to: ALL_MIGHT,
    },
  });

  const logs = await publicClient.getFilterLogs({ filter: transferFilter });

  return logs.map((log: any) => ({
    amount: BigInt(log.args.value),
  }));
}

export function matchTokensWithWeth(
  tokenTransfers: any[],
  wethTransfers: any[]
) {
  let wethIndex = 0;
  const tokenWethValues: { [tokenAddress: string]: bigint } = {};

  for (const tokenTransfer of tokenTransfers) {
    if (wethIndex >= wethTransfers.length) break;

    tokenWethValues[tokenTransfer.tokenAddress] =
      wethTransfers[wethIndex].amount;
    wethIndex++;
  }

  return tokenWethValues;
}

export function calculateTokenSdCrvShares(
  tokenWethValues: { [tokenAddress: string]: bigint },
  totalSdCrv: bigint
) {
  const totalWeth = Object.values(tokenWethValues).reduce(
    (sum, value) => sum + value,
    BigInt(0)
  );
  const tokenSdCrvShares: { [tokenAddress: string]: bigint } = {};

  for (const [tokenAddress, wethValue] of Object.entries(tokenWethValues)) {
    tokenSdCrvShares[tokenAddress] = (totalSdCrv * wethValue) / totalWeth;
  }

  return tokenSdCrvShares;
}

export interface MerkleData {
  merkleRoot: string;
  claims: {
    [address: string]: {
      tokens: {
        [tokenAddress: string]: {
          amount: string;
          proof: string[];
        };
      };
    };
  };
}

export function generateMerkleTree(distribution: {
  [address: string]: { [tokenAddress: string]: string };
}): MerkleData {
  const leaves: string[] = [];
  const claims: MerkleData["claims"] = {};

  Object.entries(distribution).forEach(([address, tokens]) => {
    Object.entries(tokens).forEach(([tokenAddress, amount]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, amount]
              )
            ),
          ]
        )
      );
      leaves.push(leaf);

      if (!claims[address]) {
        claims[address] = { tokens: {} };
      }
      claims[address].tokens[tokenAddress] = {
        amount,
        proof: [],
      };
    });
  });

  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const merkleRoot = merkleTree.getHexRoot();

  // Generate proofs
  Object.entries(claims).forEach(([address, claim]) => {
    Object.entries(claim.tokens).forEach(([tokenAddress, tokenClaim]) => {
      const leaf = utils.keccak256(
        utils.solidityPack(
          ["bytes"],
          [
            utils.keccak256(
              utils.defaultAbiCoder.encode(
                ["address", "address", "uint256"],
                [address, tokenAddress, tokenClaim.amount]
              )
            ),
          ]
        )
      );
      tokenClaim.proof = merkleTree.getHexProof(leaf);
    });
  });

  return { merkleRoot, claims };
}
