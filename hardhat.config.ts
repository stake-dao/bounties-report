import '@nomicfoundation/hardhat-toolbox-viem'
import 'dotenv/config'
import { HardhatUserConfig } from 'hardhat/config'


const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      forking: {
        url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
        blockNumber: 20970102,
      },
    },
  },
  solidity: {
    compilers: [
      {
        version: '0.8.20',
        settings: {
          optimizer: {
            enabled: true,
            runs: 100000,
          },
        },
      },
    ],
  },
  paths: {
    sources: 'contracts/',

  }
}

export default config
