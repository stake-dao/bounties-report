import {
  getAddress,
  decodeAbiParameters,
  encodePacked,
  keccak256,
  pad,
} from "viem";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { ALL_MIGHT, WETH_ADDRESS } from "../utils/reportUtils";
import { VLCVX_RECIPIENT } from "../utils/constants";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";

export async function getSdCrvTransfer(minBlock: number, maxBlock: number) {
  const explorerUtils = createBlockchainExplorerUtils();
  const sdCrvAddress = getAddress("0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5");

  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedAllMight = pad(ALL_MIGHT as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const paddedVlcvxRecipient = pad(VLCVX_RECIPIENT as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const topics = {
    "0": transferHash,
    "1": paddedAllMight,
    "2": paddedVlcvxRecipient,
  };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    [sdCrvAddress],
    minBlock,
    maxBlock,
    topics,
    1
  );

  if (response.result.length === 0) {
    throw new Error("No sdCRV transfer found");
  }

  const latestTransfer = response.result[response.result.length - 1];
  const [amount] = decodeAbiParameters(
    [{ type: "uint256" }],
    latestTransfer.data
  );

  return {
    amount: BigInt(amount),
    blockNumber: parseInt(latestTransfer.blockNumber, 16),
  };
}

export async function getTokenTransfersOut(
  chainId: number,
  token: string,
  blockNumber: number
) {
  const explorerUtils = createBlockchainExplorerUtils();

  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedAllMight = pad(ALL_MIGHT as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const topics = {
    "0": transferHash,
    "1": paddedAllMight,
  };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    [token],
    blockNumber,
    blockNumber,
    topics,
    chainId
  );

  return response.result.map((log) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    return {
      tokenAddress: getAddress(log.address),
      amount: BigInt(amount),
    };
  });
}

export async function getWethTransfersIn(
  chainId: number,
  blockNumber: number
) {
  const explorerUtils = createBlockchainExplorerUtils();

  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));

  const paddedAllMight = pad(ALL_MIGHT as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const topics = {
    "0": transferHash,
    "2": paddedAllMight,
  };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    [WETH_ADDRESS],
    blockNumber,
    blockNumber,
    topics,
    chainId
  );

  return response.result.map((log) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    return {
      amount: BigInt(amount),
    };
  });
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

export interface TokenClaim {
  amount: string;
  proof: string[];
}

export interface AddressClaim {
  tokens: {
    [tokenAddress: string]: TokenClaim;
  };
}

export interface MerkleData {
  merkleRoot: string;
  claims: {
    [address: string]: AddressClaim;
  };
}

export interface CombinedMerkleData {
  delegators: MerkleData;
  nonDelegators: MerkleData;
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
