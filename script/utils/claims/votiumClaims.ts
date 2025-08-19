import {
  decodeEventLog,
  getAddress,
  keccak256,
  encodePacked,
  parseAbi,
  pad,
} from "viem";
import { createBlockchainExplorerUtils } from "../explorerUtils";

export const fetchVotiumClaimedBounties = async (
  block_min: number,
  block_max: number
) => {
  const ethUtils = createBlockchainExplorerUtils();
  const VOTIUM_MERKLE = "0x378Ba9B73309bE80BF4C2c027aAD799766a7ED5A";
  const RECIPIENT = "0xAe86A3993D13C8D77Ab77dBB8ccdb9b7Bc18cd09";

  // Event signature for Claimed event
  const claimedSig = "Claimed(address,uint256,uint256,address,uint256)";
  const claimedHash = keccak256(encodePacked(["string"], [claimedSig]));

  // Parse ABI for the event
  const claimedAbi = parseAbi([
    "event Claimed(address indexed token, uint256 index, uint256 amount, address indexed account, uint256 indexed update)",
  ]);

  // Pad the recipient address to 32 bytes for topic filtering
  const paddedRecipient = pad(RECIPIENT as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  // Fetch logs from the blockchain
  const claimedResponse = await ethUtils.getLogsByAddressAndTopics(
    VOTIUM_MERKLE,
    block_min,
    block_max,
    {
      "0": claimedHash,
      "2": paddedRecipient,
    },
    1
  );

  if (
    !claimedResponse ||
    !claimedResponse.result ||
    claimedResponse.result.length === 0
  ) {
    return {};
  }

  // Process the logs to extract token and amount information
  const votiumBounties = claimedResponse.result.map((log: any) => {
    const decodedLog = decodeEventLog({
      abi: claimedAbi,
      data: log.data,
      topics: log.topics,
      strict: true,
    });

    return {
      rewardToken: getAddress(decodedLog.args.token),
      amount: decodedLog.args.amount,
    };
  });

  return { votiumBounties };
};