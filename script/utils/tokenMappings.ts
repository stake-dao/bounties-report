// Common token symbol to address mappings for Ethereum mainnet
export const TOKEN_SYMBOL_TO_ADDRESS: Record<string, string> = {
  // Stablecoins
  "DAI": "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  
  // Major tokens
  "WETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "WBTC": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  
  // DeFi tokens
  "CRV": "0xD533a949740bb3306d119CC777fa900bA034cd52",
  "CVX": "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B",
  "FXS": "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0",
  "FXN": "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09",
  "BAL": "0xba100000625a3754423978a60c9317c58a424e3D",
  "AURA": "0xC0c293ce456fF0ED870ADd98a0828Dd4d2903DBF",
  
  // Other common tokens
  "ALCX": "0xdBdb4d16EdA451D0503b854CF79D55697F90c8DF",
  "INV": "0x41D5D79431A913C4aE7d69a668ecdfE5fF9DFB68",
  "SPELL": "0x090185f2135308BaD17527004364eBcC2D37e5F6",
  "MIM": "0x99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3",
  "FRAX": "0x853d955aCEf822Db058eb8505911ED77F175b99e",
  "LUSD": "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
  "SUSD": "0x57Ab1ec28D129707052df4dF418D58a2D46d5f51",
  "TUSD": "0x0000000000085d4780B73119b644AE5ecd22b376",
  "BUSD": "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
  "GUSD": "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd",
  "USDP": "0x8E870D67F660D95d5be530380D0eC0bd388289E1",
  "RAI": "0x03ab458634910AaD20eF5f1C8ee96F1D6ac54919",
  "EURS": "0xdB25f211AB05b1c97D595516F45794528a807ad8",
  "EURT": "0xC581b735A1688071A1746c968e0798D642EDE491",
  "AGEUR": "0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8",
  
  // Governance tokens
  "MKR": "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
  "COMP": "0xc00e94Cb662C3520282E6f5717214004A7f26888",
  "UNI": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  "SUSHI": "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
  "YFI": "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
  "SNX": "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
  "AAVE": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  "LDO": "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32",
  "RPL": "0xD33526068D116cE69F19A9ee46F0bd304F21A51f",
  
  // Wrapped tokens
  "WSTETH": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  "STETH": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  "RETH": "0xae78736Cd615f374D3085123A210448E74Fc6393",
  "CBETH": "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
  "SFRXETH": "0xac3E018457B222d93114458476f3E3416Abbe38F",
  "FRXETH": "0x5E8422345238F34275888049021821E8E08CAa1f",
  
  // Other tokens that might appear
  "LINK": "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  "MATIC": "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0",
  "GRT": "0xc944E90C64B2c07662A292be6244BDf05Cda44a7",
  "ENS": "0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72",
  "1INCH": "0x111111111117dC0aa78b770fA6A738034120C302",
  "SAND": "0x3845badAde8e6dFF049820680d1F14bD3903a5d0",
  "MANA": "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942",
  "APE": "0x4d224452801ACEd8B2F0aebE155379bb5D594381",
  "SHIB": "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
  "FTM": "0x4E15361FD6b4BB609Fa63C81A2be19d873717870",
  "LRC": "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD",
  "OCEAN": "0x967da4048cD07aB37855c090aAF366e4ce1b9F48",
  "ANKR": "0x8290333ceF9e6D528dD5618Fb97a76f268f3EDD4",
  "BNT": "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
  "ZRX": "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
  "BAT": "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
  "KNC": "0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202",
  "REN": "0x408e41876cCCDC0F92210600ef50372656052a38",
  "BAND": "0xBA11D00c5f74255f56a5E366F4F77f5A186d7f55",
  "NMR": "0x1776e1F26f98b1A5dF9cD347953a26dd3Cb46671",
  "RLC": "0x607F4C5BB672230e8672085532f7e901544a7375",
  "CELR": "0x4f9254C83EB525f9FCf346490bbb3ed28a81C667",
  "UMA": "0x04Fa0d235C4abf4BcF4787aF4CF447DE572eF828",
  "BADGER": "0x3472A5A71965499acd81997a54BBA8D852C6E53d",
  "DYDX": "0x92D6C1e31e14520e676a687F0a93788B716BEff5",
  "PERP": "0xbC396689893D065F41bc2C6EcbeE5e0085233447",
  "RARI": "0xFca59Cd816aB1eaD66534D82bc21E7515cE441CF",
  "TRIBE": "0xc7283b66Eb1EB5FB86327f08e1B5816b0720212B",
  "BOND": "0x0391D2021f89DC339F60Fff84546EA23E337750f",
  "ILV": "0x767FE9EDC9E0dF98E07454847909b5E959D7ca0E",
  "GTC": "0xDe30da39c46104798bB5aA3fe8B9e0e1F348163F",
  "API3": "0x0b38210ea11411557c13457D4dA7dC6ea731B88a",
  "POOL": "0x0cEC1A9154Ff802e7934Fc916Ed7Ca50bDE6844e",
  "FEI": "0x956F47F50A910163D8BF957Cf5846D573E7f87CA",
  "RNDR": "0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24",
  "AXS": "0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b",
  "SLP": "0xCC8Fa225D80b9c7D42F96e9570156c65D6cAAa25",
  "GALA": "0x15D4c048F83bd7e37d49eA4C83a07267Ec4203dA",
  "IMX": "0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF",
  "METIS": "0x9E32b13ce7f2E80A01932B42553652E053D6ed8e",
  "AURORA": "0xaaaaaa20d9e0e2461697782ef11675f668207961",
  "BOBA": "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc",
  "OMG": "0xd26114cd6EE289AccF82350c8d8487fedB8A0C07",
  "POLY": "0x9992eC3cF6A55b00978cdDF2b27BC6882d88D1eC",
  "CTSI": "0x491604c0FDF08347Dd1fa4Ee062a822A5DD06B5D",
  "ALICE": "0xAC51066d7bEC65Dc4589368da368b212745d63E8",
  "DODO": "0x43Dfc4159D86F3A37A5A4B3D4580b888ad7d4DDd",
  "SUPER": "0xe53EC727dbDEB9E2d5456c3be40cFF031AB40A55",
  "RUNE": "0x3155BA85D5F96b2d030a4966AF206230e46849cb",
  "FTT": "0x50D1c9771902476076eCFc8B2A83Ad6b9355a4c9",
  "SRM": "0x476c5E26a75bd202a9683ffD34359C0CC15be0fF",
  "RAY": "0xE5bC420217101303Aeb6Da3518E15a9e14DfD5C0",
  "ALPHA": "0xa1faa113cbE53436Df28FF0aEe54275c13B40975",
  "COVER": "0x4688a8b1F292FDaB17E9a90c8Bc379dC1DBd8713",
  "SWISE": "0x48C3399719B582dD63eB5AADf12A40B4C3f52FA2",
  "BTRFLY": "0xC0d4Ceb216B3BA9C3701B291766fDCbA977ceC3A",
  "TOKE": "0x2e9d63788249371f1DFC918a52f8d799F4a38C94",
  "FOX": "0xc770EEfAd204B5180dF6a14Ee197D99d808ee52d",
  "MASK": "0x69af81e73A73B40adF4f3d4223Cd9b1ECE623074",
  "KEEP": "0x85Eee30c52B0b379b046Fb0F85F4f3Dc3009aFEC",
  "NU": "0x4fE83213D56308330EC302a8BD641f1d0113A4Cc",
  "T": "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
  "VISR": "0xF938424F7210f31dF2Aee3011291b658f872e91e",
  "QNT": "0x4a220E6096B25EADb88358cb44068A3248254675",
  "XYO": "0x55296f69f40Ea6d20E478533C15A6B08B654E758",
  "NKN": "0x5Cf04716BA20127F1E2297AdDCf4B5035000c9eb",
  "OXT": "0x4575f41308EC1483f3d399aa9a2826d74Da13Deb",
  "ZCN": "0xb9EF770B6A5e12E45983C5D80545258aA38F3B78",
  "GLM": "0x7DD9c5Cba05E151C895FDe1CF355C9A1D5DA6429",
  "UPP": "0xC86D054809623432210c107af2e3F619DcFbf652",
  "IOTX": "0x6fB3e0A217407EFFf7Ca062D46c26E5d60a14d69",
  "QUICK": "0x6c28AeF8977c9B773996d0e8376d2EE379446F2f",
  "AMP": "0xfF20817765cB7f73d4bde2e66e067E58D11095C2",
  "PLA": "0x3a4f40631a4f906c2BaD353Ed06De7A5D3fCb430",
  "REQ": "0x8f8221aFbB33998d8584A2B05749bA73c37a938a",
  "WLUNA": "0xd2877702675e6cEb975b4A1dFf9fb7BAF4C91ea9",
  "UST": "0xa693B19d2931d498c5B318dF961919BB4aee87a5",
  "PAXG": "0x45804880De22913dAFE09f4980848ECE6EcbAf78",
  "NEST": "0x04abEdA201850aC0124161F037Efd70c74ddC74C",
  "ARMOR": "0x1337DEF16F9B486fAEd0293eb623Dc8395dFE46a",
  "ARMORV2": "0x1337DEF18C680aF1f9f45cBcab6309562975b1dD",
  "INDEX": "0x0954906da0Bf32d5479e25f46056d22f08464cab",
  "DPI": "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b",
  "MVI": "0x72e364F2ABdC788b7E918bc238B21f109Cd634D7",
  "BED": "0x2aF1dF3AB0ab157e1E2Ad8F88A7D04fbea0c7dc6",
  "DATA": "0x8f693ca8D21b157107184d29D398A8D082b38b76",
  "FLI": "0xAa6E8127831c9DE45ae56bB1b0d4D4Da6e5665BD",
  "IDLE": "0x875773784Af8135eA0ef43b5a374AaD105c5D39e",
  "PICKLE": "0x429881672B9AE42b8EbA0E26cD9C73711b891Ca5",
  "CORN": "0xa456b515303B2Ce344E9d2601f91270f8c2Fea5E",
  "SWRV": "0xB8BAa0e4287890a5F79863aB62b7F175ceCbD433",
  "SDEFI": "0xe1aFe1Fd76Fd88f78cBf599ea1846231B8bA3B6B",
  "COMBO": "0xfFffFffF2ba8F66D4e51811C5190992176930278",
  "BAS": "0x44564d0bd94343f72E3C8a0D22308B7Fa71DB0Bb",
  "BAC": "0x3449FC1Cd036255BA1EB19d65fF4BA2b8903A69a",

  "FLOAT": "0xb05097849BCA421A3f51B249BA6CCa4aF4b97cb9",
  "BANK": "0x2d94AA3e47d9D5024503Ca8491fcE9A2fB4DA198",
  "BANK2": "0x24A6A37576377F63f194Caa5F518a60f45b42921",
  "RSUP": "0xb794Ad95317f75c44090f64955954C3849315fFe",
  "SDEX": "0x5DE8ab7E27f6E7A1fFf3E5B337584Aa43961BEeF",
  
  // Add more mappings as needed
};

// Reverse mapping for convenience
export const TOKEN_ADDRESS_TO_SYMBOL: Record<string, string> = Object.entries(
  TOKEN_SYMBOL_TO_ADDRESS
).reduce((acc, [symbol, address]) => {
  acc[address.toLowerCase()] = symbol;
  return acc;
}, {} as Record<string, string>);

/**
 * Get token address from symbol
 */
export function getTokenAddress(symbol: string): string | undefined {
  return TOKEN_SYMBOL_TO_ADDRESS[symbol.toUpperCase()];
}

/**
 * Get token symbol from address
 */
export function getTokenSymbolFromAddress(address: string): string | undefined {
  return TOKEN_ADDRESS_TO_SYMBOL[address.toLowerCase()];
}