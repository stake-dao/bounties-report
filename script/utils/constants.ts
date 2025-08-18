import * as dotenv from "dotenv";
import {
  getAddress,
} from "viem";

import { PlatformConfigs } from "./types";


dotenv.config();

export const MERKLE_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
export const MERKLE_BSC_ADDRESS = "0xd65cE3d391318A35bF6e24A300359eB5436b6A40";
export const MERKLE_CREATION_BLOCK_ETH = 14872510;
export const MERKLE_CREATION_BLOCK_BSC = 34176144;

export const STASH_CONTROLLER_ADDRESS =
  "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";

export const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";

// Auto Voter
export const AUTO_VOTER_DELEGATION_ADDRESS =
  "0x0657C6bEe67Bb96fae96733D083DAADE0cb5a179";
export const AUTO_VOTER_CONTRACT = "0x619eDEF2d18Ec9758E96D8FF2c7DcbFb58DD5A5C";

// Delegation
export const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";
export const SD_FRAX_DELEG_TEST = "0x5180db0237291A6449DdA9ed33aD90a38787621c";
export const DELEGATE_REGISTRY = "0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446";
export const VOTIUM_FORWARDER = "0xAe86A3993D13C8D77Ab77dBB8ccdb9b7Bc18cd09"; // 0xCC2a0F5e95C88AAbD7b8E0Db5C5252820Cd47f91 => The Union
export const VOTIUM_FORWARDER_REGISTRY =
  "0x92e6E43f99809dF84ed2D533e1FD8017eb966ee2";

export const DELEGATE_REGISTRY_CREATION_BLOCK_ETH = 11225329;
export const DELEGATE_REGISTRY_CREATION_BLOCK_BSC = 10963355;
export const DELEGATE_REGISTRY_CREATION_BLOCK_BASE = 17894724;

// Networks
export const ETHEREUM = "ethereum";
export const ETH_CHAIN_ID = "1";
export const BASE = "base";
export const BASE_CHAIN_ID = "8453";
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
export const CVX_FXN_SPACE = "cvx_fxn.eth";
export const SPECTRA_SPACE = "sdspectra.eth";

export const VLCVX_RECIPIENT = "0x0000000095310137125f82f37FBe5D2F99279947";
export const VLCVX_DELEGATORS_RECIPIENT =
  "0x00000000b0FF0700adf86A929df3aC3f88E48583";
export const VLCVX_DELEGATORS_MERKLE =
  "0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380";
export const VLCVX_NON_DELEGATORS_MERKLE =
  "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db";
export const SPECTRA_SAFE_MODULE =
  "0xA3ec797267Ad92199a11125FE31B94fac4A06C38" as `0x${string}`;
export const SDFXS_UNIVERSAL_MERKLE =
  "0x0000000000000000000000000000000000000000"; // TODO: Deploy and update this address
export const WEEK = 604800;
export const TWOWEEKS = WEEK * 2;



// Stake DAO locker
export const STAKE_DAO_LOCKER = "0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6";
// Convex locker
export const CONVEX_LOCKER = "0x989AEb4d175e16225E39E87d0D97A3360524AD80";

// Balancer Stake DAO locker
export const BALANCER_STAKE_DAO_LOCKER =
  "0xea79d1A83Da6DB43a85942767C389fE0ACf336A5";

// FXN Stake DAO locker
export const FXN_STAKE_DAO_LOCKER =
  "0x75736518075a01034fa72D675D36a47e9B06B2Fb";

// FXN Convex locker
export const FXN_CONVEX_LOCKER = "0xd11a4Ee017cA0BECA8FA45fF2abFe9C6267b7881";

// Tokens
export const SD_CRV = getAddress("0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5");
export const SD_BAL = getAddress("0xF24d8651578a55b0C119B9910759a351A3458895");
export const SD_FXS = getAddress("0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36");
export const SD_ANGLE = getAddress(
  "0x752B4c6e92d96467fE9b9a2522EF07228E00F87c"
);
export const SD_PENDLE = getAddress(
  "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9"
);
export const SD_FXN = getAddress("0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD");
export const SD_CAKE = getAddress("0x6a1c1447F97B27dA23dC52802F5f1435b5aC821A");

export const CRVUSD = getAddress("0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E");
export const SDT = getAddress("0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F");
export const CVX = getAddress("0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B");

export const FRAXTAL_SD_FXS = getAddress("0x1AEe2382e05Dc68BDfC472F1E46d570feCca5814")

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
  cvx: CVX_SPACE,
  cvx_fxn: CVX_FXN_SPACE,
  spectra: SPECTRA_SPACE,
};

export const SPACE_TO_NETWORK: Record<string, string> = {
  [SDFXS_SPACE]: ETHEREUM,
  [SDCRV_SPACE]: ETHEREUM,
  [SDBAL_SPACE]: ETHEREUM,
  [SDANGLE_SPACE]: ETHEREUM,
  [SDPENDLE_SPACE]: ETHEREUM,
  [SDFXN_SPACE]: ETHEREUM,
  [SDCAKE_SPACE]: BSC,
  [SPECTRA_SPACE]: BASE,
};

export const SPACE_TO_CHAIN_ID: Record<string, string> = {
  [SDFXS_SPACE]: ETH_CHAIN_ID,
  [SDCRV_SPACE]: ETH_CHAIN_ID,
  [SDBAL_SPACE]: ETH_CHAIN_ID,
  [SDANGLE_SPACE]: ETH_CHAIN_ID,
  [SDPENDLE_SPACE]: ETH_CHAIN_ID,
  [SDFXN_SPACE]: ETH_CHAIN_ID,
  [SDCAKE_SPACE]: BSC_CHAIN_ID,
  [CVX_SPACE]: ETH_CHAIN_ID,
  [SPECTRA_SPACE]: BASE_CHAIN_ID,
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
  [SDCRV_SPACE]: SD_CRV,
  [SDBAL_SPACE]: SD_BAL,
  [SDFXS_SPACE]: SD_FXS,
  [SDANGLE_SPACE]: SD_ANGLE,
  [SDPENDLE_SPACE]: SD_PENDLE,
  [SDFXN_SPACE]: SD_FXN,
  [SDCAKE_SPACE]: SD_CAKE,
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

export const WETH_CHAIN_IDS: Record<number, `0x${string}`> = {
  1: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"), // Ethereum
  56: getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"), // BSC
  8453: getAddress("0x4200000000000000000000000000000000000006"), // Base
  42161: getAddress("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"), // Arbitrum
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

export const CHAINS_IDS_TO_SHORTS: Record<number, string> = {
  1: "ethereum",
  56: "bsc",
  42161: "arbitrum",
  10: "optimism",
  8453: "base",
  137: "polygon",
  252: "fraxtal",
};

export const abi = [
  {
    name: "multiFreeze",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokens",
        type: "address[]",
        internalType: "address[]"
      }
    ],
    outputs: []
  },
  {
    name: "multiSet",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokens",
        type: "address[]",
        internalType: "address[]"
      },
      {
        name: "roots",
        type: "bytes32[]",
        internalType: "bytes32[]"
      }
    ],
    outputs: []
  },
  {
    name: "multiUpdateMerkleRoot",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "tokens",
        type: "address[]",
        internalType: "address[]"
      },
      {
        name: "roots",
        type: "bytes32[]",
        internalType: "bytes32[]"
      }
    ],
    outputs: []
  },
  {
    name: "isClaimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address"
      },
      {
        name: "index",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool"
      }
    ]
  }
] as const;



export const VOTEMARKET_PLATFORM_CONFIGS: PlatformConfigs = {
  curve: [
    {
      platform: "0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c",
      toAddress: STAKE_DAO_LOCKER,
    },
    {
      platform: "0x000000073D065Fc33a3050C2d0e19C393a5699ba",
      toAddress: STAKE_DAO_LOCKER,
    },
  ],
  balancer: [
    {
      platform: "0x0000000446b28e4c90DbF08Ead10F3904EB27606",
      toAddress: getAddress("0xea79d1A83Da6DB43a85942767C389fE0ACf336A5"),
    },
  ],
  frax: [
    {
      platform: "0x000000060e56DEfD94110C1a9497579AD7F5b254",
      toAddress: getAddress("0xCd3a267DE09196C48bbB1d9e842D7D7645cE448f"),
    },
  ],
  fxn: [
    {
      platform: "0x00000007D987c2Ea2e02B48be44EC8F92B8B06e8",
      toAddress: getAddress("0x75736518075a01034fa72D675D36a47e9B06B2Fb"),
    },
  ],
};

export const VOTEMARKET_CONVEX_LOCKER_CONFIGS: PlatformConfigs = {
  curve: [
    {
      platform: "0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c",
      toAddress: CONVEX_LOCKER,
    },
    {
      platform: "0x000000073D065Fc33a3050C2d0e19C393a5699ba",
      toAddress: CONVEX_LOCKER,
    },
  ],
};

export { getClient, getRedundantClients, clearClientCache } from "./getClients";
