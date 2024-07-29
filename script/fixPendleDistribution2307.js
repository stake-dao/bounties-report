const axios = require('axios').default;
const { MERKLE_ADDRESS, AGNOSTIC_ENDPOINT, AGNOSTIC_API_KEY } = require('./utils/constants');
const lastMerkle = require('../history/merkle-09-07-2024.json');
const currentMerkle = require('../merkle.json');
const { parseAbi, encodeFunctionData, formatUnits, parseEther, createPublicClient, http } = require("viem");
const { utils, BigNumber } = require("ethers");
const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const fs = require('fs');
const path = require('path');

const ALL_CLAIMED_SDPENDLE_QUERY = () => `
  SELECT
      input_3_value_address as user,
      input_2_value_uint256 as amount
  FROM evm_events_ethereum_mainnet
  WHERE
      address = '${MERKLE_ADDRESS}' and
      input_0_value_address = '0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)' and
      block_number >= 20068270
  ORDER BY timestamp DESC
`;

const ALL_CLAIMED_SDPENDLE_BEFORE_LAST_DISTRIBUTION_QUERY = () => `
  SELECT
      input_3_value_address as user,
      input_2_value_uint256 as amount
  FROM evm_events_ethereum_mainnet
  WHERE
      address = '${MERKLE_ADDRESS}' and
      input_0_value_address = '0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9' and
      signature = 'Claimed(address,uint256,uint256,address,uint256)' and
      block_number < 20068270 and block_number > 19667039
  ORDER BY timestamp DESC
`;

const getAllPendleClaim = async () => {
    const resp = {};

    const allClaimed = await agnosticFetch(ALL_CLAIMED_SDPENDLE_QUERY());
    if (!allClaimed) {
        return resp;
    }

    for (const row of allClaimed) {
        resp[row[0].toLowerCase()] = parseFloat(formatUnits(BigInt(row[1]), 18));
    }

    return resp
}

const getAllPendleClaimBeforeLastDistri = async () => {
    const resp = {};

    const allClaimed = await agnosticFetch(ALL_CLAIMED_SDPENDLE_BEFORE_LAST_DISTRIBUTION_QUERY());
    if (!allClaimed) {
        return resp;
    }

    for (const row of allClaimed) {
        resp[row[0].toLowerCase()] = parseFloat(formatUnits(BigInt(row[1]), 18));
    }

    return resp
}

const agnosticFetch = async (query) => {
    try {
        const response = await axios.post(AGNOSTIC_ENDPOINT, query, {
            headers: {
                'Authorization': `${AGNOSTIC_API_KEY}`,
                "Cache-Control": "max-age=300"
            }
        });

        return response.data.rows;
    }
    catch (e) {
        console.error(e);
        return [];
    }
}

const main = async() => {
    const claimed = await getAllPendleClaim();
    
    const lastSdPendleMerkle = lastMerkle.find((merkle) => merkle.address.toLowerCase() === "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9".toLowerCase());
    if(!lastSdPendleMerkle) {
        console.log("last sdpendle merkle not found");
        return;
    }

    let currentSdPendleMerkle = currentMerkle.find((merkle) => merkle.address.toLowerCase() === "0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9".toLowerCase());
    if(!currentSdPendleMerkle) {
        console.log("current sdpendle merkle not found");
        return;
    }

    const newAmounts = {};
    for(const userAddress of Object.keys(currentSdPendleMerkle.merkle)) {
        const isClaimed = claimed[userAddress.toLowerCase()];
        if(isClaimed) {
            let amount = 0;
            let found = false;
            for(const userAddressLastMerkle of Object.keys(lastSdPendleMerkle.merkle)) {
                if(userAddressLastMerkle.toLowerCase() === userAddress.toLowerCase()) {
                    const leaf = lastSdPendleMerkle.merkle[userAddressLastMerkle];
                    amount = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18));
                    found = true;
                    break;
                }
            }

            if(!found) {
                const leaf = currentSdPendleMerkle.merkle[userAddress];
                newAmounts[userAddress.toLowerCase()] = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18))
            } else {
                const leaf = currentSdPendleMerkle.merkle[userAddress];
                newAmounts[userAddress.toLowerCase()] = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18)) - amount;
            }
            
        } else {
            const leaf = currentSdPendleMerkle.merkle[userAddress];
            newAmounts[userAddress.toLowerCase()] = parseFloat(formatUnits(BigNumber.from(leaf.amount), 18))
        }
    }

    console.log(newAmounts)
    console.log("total", Object.values(newAmounts).reduce((acc, a) => acc + a, 0))

    const userRewardAddresses = Object.keys(newAmounts);

    const elements = [];
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];

      const amount = parseEther(newAmounts[userAddress.toLowerCase()].toString());

      elements.push(utils.solidityKeccak256(["uint256", "address", "uint256"], [i, userAddress.toLowerCase(), BigNumber.from(amount)]));
    }

    const merkleTree = new MerkleTree(elements, keccak256, { sort: true });

    currentSdPendleMerkle.merkle = {};
    let totalAmount = BigNumber.from(0);
    for (let i = 0; i < userRewardAddresses.length; i++) {
      const userAddress = userRewardAddresses[i];
      const amount = BigNumber.from(parseEther(newAmounts[userAddress.toLowerCase()].toString()));
      totalAmount = totalAmount.add(amount);

      currentSdPendleMerkle.merkle[userAddress.toLowerCase()] = {
        index: i,
        amount,
        proof: merkleTree.getHexProof(elements[i]),
      };
    }

    currentSdPendleMerkle.total = totalAmount;
    currentSdPendleMerkle.root = merkleTree.getHexRoot(),

    fs.writeFileSync(`./merkle.json`, JSON.stringify(currentMerkle));
}

main();