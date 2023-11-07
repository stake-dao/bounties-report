const { MerkleTree } = require("merkletreejs");
const keccak256 = require("keccak256");
const fs = require('fs');
const axios = require('axios').default;
const { utils, BigNumber } = require("ethers");
const { formatUnits, parseEther, encodeFunctionData } = require("viem");
const { parseAbi } = require("viem");
const { createPublicClient, http, isAddress } = require('viem');
const { mainnet } = require('viem/chains');
require('dotenv').config()

const MERKLE_ADDRESS = "0x414CbB5c7cf637b7030965B5ee84504C64C10c29";
const CVX_PRISMA_ADDRESS = "0x34635280737b5BFe6c7DC2FC3065D60d66e78185";
const SDCRV_GAUGE = "0x7f50786A0b15723D741727882ee99a0BF34e3466";
const BLOCK_AIRDROP = 17919607;
const MAX_CALLS = 200;
const PRISMA_AMOUNT = 263045000000000000000000n;

const AGNOSTIC_ENDPOINT = "https://proxy.eu-02.agnostic.engineering/query";
const AGNOSTIC_API_KEY = process.env.AGNOSTIC_KEY;

const abi = parseAbi([
    'function updateMerkleRoot(address token, bytes32 root) public',
    'function working_balances(address user) public returns(uint256)',
    'function balanceOf(address user) public returns(uint256)',
]);

const main = async () => {

    const client = createPublicClient({
        batch: {
            multicall: true,
        },
        chain: mainnet,
        transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`)
    });

    let sdCrvGaugeHolders = await getSdCrvGaugeHolders();
    sdCrvGaugeHolders = sdCrvGaugeHolders.flat().filter((addr) => isAddress(addr));

    console.log("Nb sdCRV holders : ", sdCrvGaugeHolders.length);

    let calls = [];
    let balances = [];
    for (const user of sdCrvGaugeHolders) {
        calls.push({
            address: SDCRV_GAUGE,
            abi,
            functionName: 'balanceOf',
            args: [user]
        });

        if (calls.length === MAX_CALLS) {
            const results = await client.multicall({ contracts: calls, blockNumber: BLOCK_AIRDROP });
            checkError(results);
            balances = balances.concat(results);
            calls = [];
        }
    }

    if (calls.length > 0) {
        const results = await client.multicall({ contracts: calls, blockNumber: BLOCK_AIRDROP });
        checkError(results);
        balances = balances.concat(results);
    }

    // Filter balance > 0
    let newSdCrvGaugeHolders = [];
    let userBalances = [];
    for (const user of sdCrvGaugeHolders) {
        const balance = balances.shift();
        if (balance?.result > 0n) {
            newSdCrvGaugeHolders.push(user);
        }

        userBalances.push({
            user,
            balance: Number(balance?.result)
        });
    }

    fs.writeFileSync(`./prisma/merklePrismaUserBalances.json`, JSON.stringify(userBalances));

    sdCrvGaugeHolders = newSdCrvGaugeHolders;

    console.log("Nb sdCRV holders with balance > 0 at block airdrop : ", sdCrvGaugeHolders.length);

    // Get working balance
    calls = [];
    let workingBalances = [];
    for (const user of sdCrvGaugeHolders) {
        calls.push({
            address: SDCRV_GAUGE,
            abi,
            functionName: 'working_balances',
            args: [user]
        });

        if (calls.length === MAX_CALLS) {
            const results = await client.multicall({ contracts: calls, blockNumber: BLOCK_AIRDROP });
            checkError(results);
            workingBalances = workingBalances.concat(results);
            calls = [];
        }
    }

    if (calls.length > 0) {
        const results = await client.multicall({ contracts: calls, blockNumber: BLOCK_AIRDROP });
        checkError(results);
        workingBalances = workingBalances.concat(results);
    }

    calls = [];

    const sumWorkingBalance = workingBalances.reduce((acc, b) => acc + parseFloat(formatUnits(b.result, 18)), 0);
    const shareUsers = [];

    for (const user of sdCrvGaugeHolders) {
        const userWithReplace = replaceUserAddress(user);
        const workingBalance = parseFloat(formatUnits(workingBalances.shift()?.result, 18));
        const share = workingBalance * 100 / sumWorkingBalance;
        let amount = parseFloat(formatUnits(PRISMA_AMOUNT, 18)) * share / 100;

        // Search if already added (Concentrator case)
        let find = false;
        for (const shareUser of shareUsers) {
            if (shareUser.user.toLowerCase() === userWithReplace.toLowerCase()) {
                shareUser.amount += amount;
                shareUser.share += share;
                find = true;
                break;
            }
        }

        if (!find) {
            shareUsers.push({
                user: userWithReplace,
                share,
                amount
            });
        }
    }

    fs.writeFileSync(`./prisma/merklePrisma.json`, JSON.stringify(shareUsers.sort(({ share: a }, { share: b }) => b - a)));

    const elements = [];
    for (let i = 0; i < shareUsers.length; i++) {
        const shareUser = shareUsers[i];
        let amount = 0n;
        try {
            amount = parseEther(shareUser.amount.toString());
        }
        catch (e) {

        }
        elements.push(utils.solidityKeccak256(["uint256", "address", "uint256"], [i, shareUser.user.toLowerCase(), BigNumber.from(amount)]));
    }

    const merkleTree = new MerkleTree(elements, keccak256, { sort: true });

    const merkle = {};
    let totalAmount = BigNumber.from(0);
    for (let i = 0; i < shareUsers.length; i++) {
        const shareUser = shareUsers[i];
        let amount = 0n;
        try {
            amount = parseEther(shareUser.amount.toString());
        }
        catch (e) {

        }
        totalAmount = totalAmount.add(amount);

        merkle[shareUser.user.toLowerCase()] = {
            index: i,
            amount: BigNumber.from(amount),
            proof: merkleTree.getHexProof(elements[i]),
        };
    }

    const { data: lastMerkles } = await axios.get("https://raw.githubusercontent.com/stake-dao/bounties-report/main/newMerkle.json");

    const root = merkleTree.getHexRoot();
    lastMerkles.push({
        "symbol": "cvxPrisma",
        "address": CVX_PRISMA_ADDRESS,
        "image": "https://etherscan.io/token/images/prismagov_32.png",
        "merkle": merkle,
        root,
        "total": totalAmount
    });

    fs.writeFileSync(`./newMerkle.json`, JSON.stringify(lastMerkles));

    const multiSetData = encodeFunctionData({
        abi,
        functionName: 'updateMerkleRoot',
        args: [CVX_PRISMA_ADDRESS, root],
    });

    console.log("New roots :");
    console.log("Contract : " + MERKLE_ADDRESS);
    console.log("Data : ");
    console.log(multiSetData);
}

const getSdCrvGaugeHolders = async () => {
    try {
        const response = await axios.post(AGNOSTIC_ENDPOINT, `
    SELECT 
        distinct(wallet_address)
    FROM token_balances_ethereum_mainnet_v1
    WHERE 
        token_address IN ( '${SDCRV_GAUGE}')
        and block_number <= ${BLOCK_AIRDROP}
    GROUP BY wallet_address, token_address
    `, {
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

const checkError = (results) => {
    for (const r of results) {
        if (r.status !== "success") {
            console.log(r);
            throw new Error("Error rpc");
        }
    }
}

const replaceUserAddress = (address) => {
    switch (address.toLowerCase()) {
        case "0x3216d2a52f0094aa860ca090bc5c335de36e6273".toLowerCase():
            return "0x9e2b6378ee8ad2a4a95fe481d63caba8fb0ebbf9".toLowerCase();
        case "0x1c0D72a330F2768dAF718DEf8A19BAb019EEAd09".toLowerCase():
            return "0xA0FB1b11ccA5871fb0225B64308e249B97804E99".toLowerCase();
        default:
            return address.toLowerCase();
    }
}

main();