const { parseAbi } = require("viem");

const MERKLE_ADDRESS = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
const MERKLE_BSC_ADDRESS = "0xd65cE3d391318A35bF6e24A300359eB5436b6A40";
const STASH_CONTROLLER_ADDRESS = "0x2f18e001B44DCc1a1968553A2F32ab8d45B12195";

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";
const ENDPOINT_DELEGATORS = "https://api.thegraph.com/subgraphs/name/snapshot-labs/snapshot";
const ENDPOINT_DELEGATORS_BSC = "https://api.thegraph.com/subgraphs/name/snapshot-labs/snapshot-binance-smart-chain";

// Auto Voter
const AUTO_VOTER_DELEGATION_ADDRESS = "0x0657C6bEe67Bb96fae96733D083DAADE0cb5a179";
const AUTO_VOTER_CONTRACT = "0x619eDEF2d18Ec9758E96D8FF2c7DcbFb58DD5A5C";

// Delegation
const DELEGATION_ADDRESS = "0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC";

// Agnostic
const AGNOSTIC_ENDPOINT = "https://proxy.eu-02.agnostic.engineering/query";
const AGNOSTIC_API_KEY = "Fr2LXSVvKCfmXse8JQJiJBLHY9ujU3YZf8Kr6TDDh4Sw";

// Networks
const ETHEREUM = "ethereum";
const ETH_CHAIN_ID = "1";
const BSC = "bsc";
const BSC_CHAIN_ID = "56";

const SDCRV_SPACE = "sdcrv.eth";
const SDBAL_SPACE = "sdbal.eth";
const SDFXS_SPACE = "sdfxs.eth";
const SDANGLE_SPACE = "sdangle.eth";
const SDPENDLE_SPACE = "sdpendle.eth";
const SDCAKE_SPACE = "sdcake.eth";
const SDFXN_SPACE = "sdfxn.eth";

const SPACES = [SDCRV_SPACE, SDBAL_SPACE, SDFXS_SPACE, SDANGLE_SPACE, SDPENDLE_SPACE, SDFXN_SPACE];

const LABELS_TO_SPACE = {
    "frax": SDFXS_SPACE,
    "curve": SDCRV_SPACE,
    "balancer": SDBAL_SPACE,
    "angle": SDANGLE_SPACE,
    "pendle": SDPENDLE_SPACE,
    "cake": SDCAKE_SPACE,
    "fxn": SDFXN_SPACE,
};

const SUBGRAP_BY_CHAIN = {
    [BSC]: ENDPOINT_DELEGATORS_BSC,
    [ETHEREUM]: ENDPOINT_DELEGATORS
};

const SPACE_TO_NETWORK = {
    [SDFXS_SPACE]: ETHEREUM,
    [SDCRV_SPACE]: ETHEREUM,
    [SDBAL_SPACE]: ETHEREUM,
    [SDANGLE_SPACE]: ETHEREUM,
    [SDPENDLE_SPACE]: ETHEREUM,
    [SDFXN_SPACE]: ETHEREUM,
    [SDCAKE_SPACE]: BSC,
}

const SPACE_TO_CHAIN_ID = {
    [SDFXS_SPACE]: ETH_CHAIN_ID,
    [SDCRV_SPACE]: ETH_CHAIN_ID,
    [SDBAL_SPACE]: ETH_CHAIN_ID,
    [SDANGLE_SPACE]: ETH_CHAIN_ID,
    [SDPENDLE_SPACE]: ETH_CHAIN_ID,
    [SDFXN_SPACE]: ETH_CHAIN_ID,
    [SDCAKE_SPACE]: BSC_CHAIN_ID,
}

const NETWORK_TO_STASH = {
    [ETHEREUM]: STASH_CONTROLLER_ADDRESS,
    [BSC]: MERKLE_BSC_ADDRESS,
}

const NETWORK_TO_MERKLE = {
    [ETHEREUM]: MERKLE_ADDRESS,
    [BSC]: MERKLE_BSC_ADDRESS,
}

const SPACES_TOKENS = {
    [SDCRV_SPACE]: "0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5",
    [SDBAL_SPACE]: "0xF24d8651578a55b0C119B9910759a351A3458895",
    [SDFXS_SPACE]: "0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36",
    [SDANGLE_SPACE]: "0x752B4c6e92d96467fE9b9a2522EF07228E00F87c",
    [SDPENDLE_SPACE]: "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9",
    [SDFXN_SPACE]: "0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD",
    [SDCAKE_SPACE]: "0x6a1c1447F97B27dA23dC52802F5f1435b5aC821A"
};

const SPACES_SYMBOL = {
    [SDCRV_SPACE]: "sdCRV",
    [SDBAL_SPACE]: "sdBAL",
    [SDFXS_SPACE]: "sdFXS",
    [SDANGLE_SPACE]: "sdANGLE",
    [SDPENDLE_SPACE]: "sdPENDLE",
    [SDCAKE_SPACE]: "sdCAKE",
    [SDFXN_SPACE]: "sdFXN",
};

const SPACES_IMAGE = {
    [SDCRV_SPACE]: "https://assets.coingecko.com/coins/images/27756/small/scCRV-2.png?1665654580",
    [SDBAL_SPACE]: "https://assets.coingecko.com/coins/images/11683/small/Balancer.png?1592792958",
    [SDFXS_SPACE]: "https://assets.coingecko.com/coins/images/13423/small/Frax_Shares_icon.png?1679886947",
    [SDANGLE_SPACE]: "https://assets.coingecko.com/coins/images/19060/small/ANGLE_Token-light.png?1666774221",
    [SDPENDLE_SPACE]: "https://beta.stakedao.org/assets/pendle.svg",
    [SDCAKE_SPACE]: "https://cdn.stamp.fyi/space/sdcake.eth?s=96&cb=cd2ea5c12296e731",
    [SDFXN_SPACE]: "https://cdn.jsdelivr.net/gh/curvefi/curve-assets/images/assets/0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad.png",
};

const SPACES_UNDERLYING_TOKEN = {
    [SDCRV_SPACE]: "0xd533a949740bb3306d119cc777fa900ba034cd52",
    [SDBAL_SPACE]: "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56", //80BAL instead of bal
    [SDFXS_SPACE]: "0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0",
    [SDANGLE_SPACE]: "0x31429d1856ad1377a8a0079410b297e1a9e214c2",
    [SDPENDLE_SPACE]: "0x808507121b80c02388fad14726482e061b8da827",
    [SDCAKE_SPACE]: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    [SDFXN_SPACE]: "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09",
};

const abi = parseAbi([
    'function multiFreeze(address[] tokens) public',
    'function multiSet(address[] tokens, bytes32[] roots) public',
    'function multiUpdateMerkleRoot(address[] tokens, bytes32[] roots) public',
    'function isClaimed(address token, uint256 index) public view returns (bool)',
]);

module.exports = {
    MERKLE_ADDRESS,
    MERKLE_BSC_ADDRESS,
    STASH_CONTROLLER_ADDRESS,
    SNAPSHOT_ENDPOINT,
    ENDPOINT_DELEGATORS,
    ENDPOINT_DELEGATORS_BSC,
    AUTO_VOTER_DELEGATION_ADDRESS,
    AUTO_VOTER_CONTRACT,
    DELEGATION_ADDRESS,
    AGNOSTIC_ENDPOINT,
    AGNOSTIC_API_KEY,
    ETHEREUM,
    ETH_CHAIN_ID,
    BSC,
    BSC_CHAIN_ID,
    SDCRV_SPACE,
    SDBAL_SPACE,
    SDFXS_SPACE,
    SDANGLE_SPACE,
    SDPENDLE_SPACE,
    SDCAKE_SPACE,
    SDFXN_SPACE,
    SPACES,
    LABELS_TO_SPACE,
    SUBGRAP_BY_CHAIN,
    SPACE_TO_NETWORK,
    SPACE_TO_CHAIN_ID,
    NETWORK_TO_STASH,
    NETWORK_TO_MERKLE,
    SPACES_TOKENS,
    SPACES_SYMBOL,
    SPACES_IMAGE,
    SPACES_UNDERLYING_TOKEN,
    abi
};
