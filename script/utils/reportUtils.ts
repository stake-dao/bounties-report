import axios from 'axios';
import { getAddress } from 'viem';

const getClosestBlockTimestamp = async (chain: string, timestamp: number): Promise<number> => {
    const response = await axios.get(`https://coins.llama.fi/block/${chain}/${timestamp}`);

    if (response.status !== 200) {
        console.error(response.data);
        throw new Error("Failed to get closest block timestamp");
    }

    const result = response.data;
    return result.height;
}


const MAINNET_VM_PLATFORMS: { [key: string]: { platform: string, locker: string } } = {
    "curve": { platform: getAddress("0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c"), locker: getAddress("0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6") },
    "balancer": { platform: getAddress("0x0000000446b28e4c90DbF08Ead10F3904EB27606"), locker: getAddress("0xea79d1A83Da6DB43a85942767C389fE0ACf336A5") },
    "frax": { platform: getAddress("0x000000060e56DEfD94110C1a9497579AD7F5b254"), locker: getAddress("0xCd3a267DE09196C48bbB1d9e842D7D7645cE448f") },
    "fxn": { platform: getAddress("0x00000007D987c2Ea2e02B48be44EC8F92B8B06e8"), locker: getAddress("0x75736518075a01034fa72D675D36a47e9B06B2Fb") },
}

const WARDEN_PATHS: { [key: string]: string } = {
    "curve": "crv",
    "balancer": "bal",
    "frax": "frax",
    "fxn": "fxn"
}


export { getClosestBlockTimestamp, MAINNET_VM_PLATFORMS, WARDEN_PATHS };