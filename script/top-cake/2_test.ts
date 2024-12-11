/**
 * Have a fork with the merkle contract funded with required SDT
 */
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi } from "viem";
import { generateMerkles, SDT_ADDRESS } from "./1_merkles";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const FORK_URL = "https://rpc.tenderly.co/fork/171cd8b1-9317-4425-bece-f6ec63a9a57b";

// Merkle
const MERKLE_CONTRACT = "0x14199d5116632318Aba6b4a972f6154101A09Ef0" as `0x${string}`;
const MERKLE_ABI = parseAbi([
    'function setRoot(bytes32,bytes32) external',
    'function claim(address,address,uint256,bytes32[]) external',
])
const DEFAULT_IPFS = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

const runTest = async () => {
    // Create the public client
    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http(FORK_URL)
    })

    // Create the rpc wallet client
    const account = privateKeyToAccount(process.argv[2] as `0x${string}`)

    const client = createWalletClient({
        account,
        chain: mainnet,
        transport: http(FORK_URL)
    });

    const [address] = await client.getAddresses()

    console.log(`Wallet address : ${address}`)

    // Get merkle data
    const merkleData = await generateMerkles();

    // Set a merkle root
    const setRootData = encodeFunctionData({
        abi: MERKLE_ABI,
        functionName: 'setRoot',
        args: [merkleData.merkleRoot as `0x${string}`, DEFAULT_IPFS]
    })

    const hash = await client.sendTransaction({
        account: address,
        to: MERKLE_CONTRACT,
        data: setRootData,
        chain: mainnet
    });

    const transaction = await publicClient.waitForTransactionReceipt({ hash });
    if (transaction.status === 'reverted') {
        throw new Error("setRoot reverted");
    }

    // The merkle should have enough SDT (funded with Tenderly)
    // Fetch all user balances
    const userAddresses = Object.keys(merkleData.claims) as `0x${string}`[];
    const beforeUserSdtBalances = await publicClient.multicall({
        contracts: userAddresses.map((userAddress) => {
            return {
                address: SDT_ADDRESS,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [userAddress]
            }
        })
    });

    // Claim for all users
    for (const userAddress of userAddresses) {
        const claimData = encodeFunctionData({
            abi: MERKLE_ABI,
            functionName: 'claim',
            args: [userAddress, SDT_ADDRESS, BigInt(merkleData.claims[userAddress].tokens[SDT_ADDRESS].amount), merkleData.claims[userAddress].tokens[SDT_ADDRESS].proof as `0x${string}`[]]
        })

        const hash = await client.sendTransaction({
            account: address,
            to: MERKLE_CONTRACT,
            data: claimData,
            chain: mainnet
        });

        const transaction = await publicClient.waitForTransactionReceipt({ hash });
        if (transaction.status === 'reverted') {
            throw new Error(`Claim for user ${userAddress} reverted`);
        }
    }

    const afterUserSdtBalances = await publicClient.multicall({
        contracts: userAddresses.map((userAddress) => {
            return {
                address: SDT_ADDRESS,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [userAddress]
            }
        })
    });

    for (let i = 0; i < userAddresses.length; i++) {
        if (beforeUserSdtBalances[i].status === 'failure') {
            throw new Error(`Fetch user balance before claim failed`);
        }
        if (afterUserSdtBalances[i].status === 'failure') {
            throw new Error(`Fetch user balance after claim failed`);
        }

        const userAddress = userAddresses[i];
        const beforeUserBalance = beforeUserSdtBalances[i].result as bigint;
        const afterUserSdtBalance = afterUserSdtBalances[i].result as bigint;
        const claimable = BigInt(merkleData.claims[userAddress].tokens[SDT_ADDRESS].amount);

        if (beforeUserBalance + claimable < afterUserSdtBalance) {
            throw new Error(`Balance for user ${userAddress} !==`);
        }
    }

    console.log("All claim done !")
    process.exit(0)
};

runTest().catch(console.error);