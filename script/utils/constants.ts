import * as dotenv from "dotenv";
import { parseAbi } from "viem";

dotenv.config();

export const MERKLE_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
export const MERKLE_BSC_ADDRESS = "0xd65cE3d391318A35bF6e24A300359eB5436b6A40";
export const STASH_CONTROLLER_ADDRESS =
  "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";

export const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";

// Auto Voter
export const AUTO_VOTER_DELEGATION_ADDRESS =
  "0x0657C6bEe67Bb96fae96733D083DAADE0cb5a179";
export const AUTO_VOTER_CONTRACT = "0x619eDEF2d18Ec9758E96D8FF2c7DcbFb58DD5A5C";

// Delegation
export const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";

// Agnostic
export const AGNOSTIC_ENDPOINT =
  "https://proxy.eu-02.agnostic.engineering/query";
export const AGNOSTIC_API_KEY = "Fr2LXSVvKCfmXse8JQJiJBLHY9ujU3YZf8Kr6TDDh4Sw";

// Networks
export const ETHEREUM = "ethereum";
export const ETH_CHAIN_ID = "1";
export const BSC = "bsc";
export const BSC_CHAIN_ID = "56";

export const SDCRV_SPACE = "sdcrv.eth";
export const SDBAL_SPACE = "sdbal.eth";
export const SDFXS_SPACE = "sdfxs.eth";
export const SDANGLE_SPACE = "sdangle.eth";
export const SDPENDLE_SPACE = "sdpendle.eth";
export const SDCAKE_SPACE = "sdcake.eth";
export const SDFXN_SPACE = "sdfxn.eth";
export const CVX_SPACE = "cvx.eth";

export const VLCVX_RECIPIENT = "0xAe86A3993D13C8D77Ab77dBB8ccdb9b7Bc18cd09";

export const SPACES: string[] = [
  SDCRV_SPACE,
  SDBAL_SPACE,
  SDFXS_SPACE,
  SDANGLE_SPACE,
  SDPENDLE_SPACE,
  SDFXN_SPACE,
  SDCAKE_SPACE,
];

export const LABELS_TO_SPACE: Record<string, string> = {
  frax: SDFXS_SPACE,
  curve: SDCRV_SPACE,
  balancer: SDBAL_SPACE,
  angle: SDANGLE_SPACE,
  pendle: SDPENDLE_SPACE,
  cake: SDCAKE_SPACE,
  fxn: SDFXN_SPACE,
};

export const SPACE_TO_NETWORK: Record<string, string> = {
  [SDFXS_SPACE]: ETHEREUM,
  [SDCRV_SPACE]: ETHEREUM,
  [SDBAL_SPACE]: ETHEREUM,
  [SDANGLE_SPACE]: ETHEREUM,
  [SDPENDLE_SPACE]: ETHEREUM,
  [SDFXN_SPACE]: ETHEREUM,
  [SDCAKE_SPACE]: BSC,
};

export const SPACE_TO_CHAIN_ID: Record<string, string> = {
  [SDFXS_SPACE]: ETH_CHAIN_ID,
  [SDCRV_SPACE]: ETH_CHAIN_ID,
  [SDBAL_SPACE]: ETH_CHAIN_ID,
  [SDANGLE_SPACE]: ETH_CHAIN_ID,
  [SDPENDLE_SPACE]: ETH_CHAIN_ID,
  [SDFXN_SPACE]: ETH_CHAIN_ID,
  [SDCAKE_SPACE]: BSC_CHAIN_ID,
};

export const NETWORK_TO_STASH: Record<string, string> = {
  [ETHEREUM]: STASH_CONTROLLER_ADDRESS,
  [BSC]: MERKLE_BSC_ADDRESS,
};

export const NETWORK_TO_MERKLE: Record<string, string> = {
  [ETHEREUM]: MERKLE_ADDRESS,
  [BSC]: MERKLE_BSC_ADDRESS,
};

export const SPACES_TOKENS: Record<string, string> = {
  [SDCRV_SPACE]: "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5",
  [SDBAL_SPACE]: "0xF24d8651578a55b0C119B9910759a351A3458895",
  [SDFXS_SPACE]: "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36",
  [SDANGLE_SPACE]: "0x752B4c6e92d96467fE9b9a2522EF07228E00F87c",
  [SDPENDLE_SPACE]: "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9",
  [SDFXN_SPACE]: "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD",
  [SDCAKE_SPACE]: "0x6a1c1447F97B27dA23dC52802F5f1435b5aC821A",
};

export const SPACES_SYMBOL: Record<string, string> = {
  [SDCRV_SPACE]: "sdCRV",
  [SDBAL_SPACE]: "sdBAL",
  [SDFXS_SPACE]: "sdFXS",
  [SDANGLE_SPACE]: "sdANGLE",
  [SDPENDLE_SPACE]: "sdPENDLE",
  [SDCAKE_SPACE]: "sdCAKE",
  [SDFXN_SPACE]: "sdFXN",
};

export const BOTMARKETS: Record<string, string> = {
  [ETHEREUM]: "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF",
  [BSC]: "0x1F18E2A3fB75D5f8d2a879fe11D7c30730236B8d",
};

export const SPACES_IMAGE: Record<string, string> = {
  [SDCRV_SPACE]:
    "https://assets.coingecko.com/coins/images/27756/small/scCRV-2.png?1665654580",
  [SDBAL_SPACE]:
    "https://assets.coingecko.com/coins/images/11683/small/Balancer.png?1592792958",
  [SDFXS_SPACE]:
    "https://assets.coingecko.com/coins/images/13423/small/Frax_Shares_icon.png?1679886947",
  [SDANGLE_SPACE]:
    "https://assets.coingecko.com/coins/images/19060/small/ANGLE_Token-light.png?1666774221",
  [SDPENDLE_SPACE]: "https://beta.stakedao.org/assets/pendle.svg",
  [SDCAKE_SPACE]:
    "https://cdn.stamp.fyi/space/sdcake.eth?s=96&cb=cd2ea5c12296e731",
  [SDFXN_SPACE]:
    "https://cdn.jsdelivr.net/gh/curvefi/curve-assets/images/assets/0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad.png",
};

export const SPACES_UNDERLYING_TOKEN: Record<string, string> = {
  [SDCRV_SPACE]: "0xd533a949740bb3306d119cc777fa900ba034cd52",
  [SDBAL_SPACE]: "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56", //80BAL instead of bal
  [SDFXS_SPACE]: "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0",
  [SDANGLE_SPACE]: "0x31429d1856ad1377a8a0079410b297e1a9e214c2",
  [SDPENDLE_SPACE]: "0x808507121b80c02388fad14726482e061b8da827",
  [SDCAKE_SPACE]: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  [SDFXN_SPACE]: "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09",
};

export const abi = parseAbi([
  "function multiFreeze(address[] tokens) public",
  "function multiSet(address[] tokens, bytes32[] roots) public",
  "function multiUpdateMerkleRoot(address[] tokens, bytes32[] roots) public",
  "function isClaimed(address token, uint256 index) public view returns (bool)",
]);

export const WEEK = 604800;

export const AGNOSTIC_MAINNET_TABLE = "evm_events_ethereum_mainnet";
export const AGNOSTIC_BSC_TABLE = "evm_events_bsc_mainnet";

// Stake DAO locker
export const STAKE_DAO_LOCKER = "0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6";
// Convex locker
export const CONVEX_LOCKER = "0x989AEb4d175e16225E39E87d0D97A3360524AD80";
