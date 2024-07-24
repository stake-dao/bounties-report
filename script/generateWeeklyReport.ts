import fs from 'fs';
import { createPublicClient, formatUnits, http } from "viem";
import { mainnet } from 'viem/chains'
import { getAddress } from 'viem'
import { getTimestampsBlocks, fetchSwapInEvents, fetchSwapOutEvents, transformSwapEvents, PROTOCOLS_TOKENS, matchWethInWithRewardsOut, getTokenInfo } from './utils/reportUtils';
import dotenv from 'dotenv';
import { ALL_MIGHT, BOTMARKET } from "./utils/claimedBountiesUtils";

dotenv.config();

const WETH_ADDRESS = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

const WEEK = 604800; // One week in seconds
const currentDate = new Date();

const currentTimestamp = Math.floor(currentDate.getTime() / 1000);
const currentPeriod = Math.floor(currentTimestamp / WEEK) * WEEK;


interface BountyInfo {
    bountyId: string;
    gauge: string;
    amount: string;
    rewardToken: string;
}

interface ProtocolBounties {
    [key: string]: BountyInfo;
}

interface ClaimedBounties {
    timestamp1: number;
    timestamp2: number;
    blockNumber1: number;
    blockNumber2: number;
    votemarket: {
        frax: ProtocolBounties;
        curve: ProtocolBounties;
        balancer: ProtocolBounties;
        fxn: ProtocolBounties;
    };
    warden: {
        frax: ProtocolBounties;
        balancer: ProtocolBounties;
        curve: ProtocolBounties;
        fxn: ProtocolBounties;
    };
    hiddenhand: {
        frax: ProtocolBounties;
        curve: ProtocolBounties;
        balancer: ProtocolBounties;
        fxn: ProtocolBounties;
    };
}


interface RewardSwap {
    token: string;
    symbol: string;
    amount: number;
}

interface SwapData {
    sdTokenIn?: number[];
    nativeIn?: number[];
    nativeOut?: number[];
    wethOut?: number[];
    wethIn?: number[];
    rewardsOut?: RewardSwap[];
}

interface SwapsData {
    [protocol: string]: {
        [blockNumber: number]: SwapData;
    };
}

const publicClient = createPublicClient({
    chain: mainnet,
    transport: http("https://rpc.flashbots.net")
});

const tokenInfos: { [token: string]: { symbol: string, decimals: number } } = {};

async function fetchAllTokenInfos(allTokens: string[]) {
    for (const token of allTokens) {
        tokenInfos[token] = await getTokenInfo(publicClient, token);
    }
}


/**
 * Main function to execute the weekly report generation.
 */
const main = async () => {
    const { timestamp1, timestamp2, blockNumber1, blockNumber2 } = await getTimestampsBlocks(publicClient, 0); // Past week

    // In weekly-bounties/{period}/claimed_bounties.json
    const claimedBountiesPath = `weekly-bounties/${currentPeriod}/claimed_bounties.json`;
    const claimedBounties: ClaimedBounties = JSON.parse(fs.readFileSync(claimedBountiesPath, 'utf8'));

    const votemarketBounties = claimedBounties.votemarket;
    const wardenBounties = claimedBounties.warden;
    const hiddenhandBounties = claimedBounties.hiddenhand;


    let curveBounties = [
        ...Object.values(votemarketBounties.curve || {}),
        ...Object.values(wardenBounties.curve || {}),
        ...Object.values(hiddenhandBounties.curve || {})
    ];

    let balancerBounties = [
        ...Object.values(votemarketBounties.balancer || {}),
        ...Object.values(wardenBounties.balancer || {}),
        ...Object.values(hiddenhandBounties.balancer || {})
    ];


    let fxnBounties = [
        ...Object.values(votemarketBounties.fxn || {}),
        ...Object.values(wardenBounties.fxn || {}),
        ...Object.values(hiddenhandBounties.fxn || {})
    ];


    let fraxBounties = [
        ...Object.values(votemarketBounties.frax || {}),
        ...Object.values(wardenBounties.frax || {}),
        ...Object.values(hiddenhandBounties.frax || {})
    ];





    const allCurveRewardTokens = Object.values(curveBounties).map(bounty => bounty.rewardToken);
    const allBalancerRewardTokens = Object.values(balancerBounties).map(bounty => bounty.rewardToken);
    const allFxnRewardTokens = Object.values(fxnBounties).map(bounty => bounty.rewardToken);
    const allFraxRewardTokens = Object.values(fraxBounties).map(bounty => bounty.rewardToken);


    const allTokens = new Set<string>([...allCurveRewardTokens, ...allBalancerRewardTokens, ...allFxnRewardTokens, ...allFraxRewardTokens]);
    allTokens.add(WETH_ADDRESS);


    for (const protocolInfos of Object.values(PROTOCOLS_TOKENS)) {
        const native = protocolInfos.native;
        const sdToken = protocolInfos.sdToken;

        // Put everything to fetch data
        allTokens.add(native);
        allTokens.add(sdToken);
    }


    await fetchAllTokenInfos(Array.from(allTokens));

    const normalizedTokenInfos = Object.entries(tokenInfos).reduce((acc, [key, value]) => {
        acc[key.toLowerCase()] = value;
        return acc;
    }, {} as typeof tokenInfos);


    // Fetch everything; to be able to compute swaps
    /*
    const swapIn = await fetchSwapInEvents(blockNumber1, blockNumber2, Array.from(allTokens), ALL_MIGHT);

    const swapOut = await fetchSwapOutEvents(blockNumber1, blockNumber2, Array.from(allTokens), ALL_MIGHT);
    */

    // Drop out when coming from Botmarket (withdraws)
    const swapInFiltered = swapIn
        .filter(swap => swap.from.toLowerCase() !== BOTMARKET.toLowerCase())
        .map(swap => {
            const tokenInfo = normalizedTokenInfos[swap.token.toLowerCase()];
            let formattedAmount: number;
            if (!tokenInfo) {
                console.warn(`No info found for token ${swap.token}. Using 18 decimals as default.`);
                formattedAmount = Number(formatUnits(swap.amount, 18));
            } else {
                formattedAmount = Number(formatUnits(swap.amount, tokenInfo.decimals));
            }
            return {
                ...swap,
                amount: formattedAmount,
                symbol: tokenInfo ? tokenInfo.symbol : 'UNKNOWN'
            };
        });

    const swapOutFiltered = swapOut
        .filter(swap => swap.from.toLowerCase() !== BOTMARKET.toLowerCase())
        .map(swap => {
            const tokenInfo = normalizedTokenInfos[swap.token.toLowerCase()];
            let formattedAmount: number;
            if (!tokenInfo) {
                console.warn(`No info found for token ${swap.token}. Using 18 decimals as default.`);
                formattedAmount = Number(formatUnits(swap.amount, 18));
            } else {
                formattedAmount = Number(formatUnits(swap.amount, tokenInfo.decimals));
            }
            return {
                ...swap,
                amount: formattedAmount,
                symbol: tokenInfo ? tokenInfo.symbol : 'UNKNOWN'
            };
        });



    const swapsData: SwapsData = {};

    // First pass: add sdToken swaps
    for (const [key, protocolInfos] of Object.entries(PROTOCOLS_TOKENS)) {
        const sdToken = protocolInfos.sdToken;

        swapsData[key] = {};

        for (const swap of swapInFiltered) {
            if (swap.token.toLowerCase() === sdToken.toLowerCase()) {
                if (!swapsData[key][swap.blockNumber]) {
                    swapsData[key][swap.blockNumber] = { sdTokenIn: [] };
                }
                swapsData[key][swap.blockNumber].sdTokenIn!.push(Number(swap.amount));
            }
        }
    }

    // Second pass: add native token swaps, weth and rewards only for blocks where sdToken was swapped
    for (const [key, protocolInfos] of Object.entries(PROTOCOLS_TOKENS)) {
        const native = protocolInfos.native;
        const sdToken = protocolInfos.sdToken;

        for (const swap of swapInFiltered) {
            if (swap.token.toLowerCase() === native.toLowerCase() && swapsData[key][swap.blockNumber]) {
                if (!swapsData[key][swap.blockNumber].nativeIn) {
                    swapsData[key][swap.blockNumber].nativeIn = [];
                }
                swapsData[key][swap.blockNumber].nativeIn!.push(Number(swap.amount));
            }
            if (swap.token.toLowerCase() === WETH_ADDRESS.toLowerCase() && swapsData[key][swap.blockNumber]) {
                if (!swapsData[key][swap.blockNumber].wethIn) {
                    swapsData[key][swap.blockNumber].wethIn = [];
                }
                swapsData[key][swap.blockNumber].wethIn!.push(Number(swap.amount));
            }
        }
        for (const swap of swapOutFiltered) {
            if (swap.token.toLowerCase() === native.toLowerCase() && swapsData[key][swap.blockNumber]) {
                if (!swapsData[key][swap.blockNumber].nativeOut) {
                    swapsData[key][swap.blockNumber].nativeOut = [];
                }
                swapsData[key][swap.blockNumber].nativeOut!.push(Number(swap.amount));
            }
            if (swap.token.toLowerCase() === WETH_ADDRESS.toLowerCase() && swapsData[key][swap.blockNumber]) {
                if (!swapsData[key][swap.blockNumber].wethOut) {
                    swapsData[key][swap.blockNumber].wethOut = [];
                }
                swapsData[key][swap.blockNumber].wethOut!.push(Number(swap.amount));
            }

            if (swapsData[key] && swapsData[key][swap.blockNumber]) {
                // Handle case when already in WETH or native or sdToken => Not swapped to WETH
                if (swap.token.toLowerCase() === WETH_ADDRESS.toLowerCase() ||
                    swap.token.toLowerCase() === native.toLowerCase() ||
                    swap.token.toLowerCase() === sdToken.toLowerCase()) {
                    continue;
                }

                if (!swapsData[key][swap.blockNumber].rewardsOut) {
                    swapsData[key][swap.blockNumber].rewardsOut = [];
                }

                const amount = Number(swap.amount);

                // Check if this specific swap has already been added
                const existingSwapIndex = swapsData[key][swap.blockNumber].rewardsOut!.findIndex(
                    rewardSwap => rewardSwap.token.toLowerCase() === swap.token.toLowerCase() &&
                        rewardSwap.amount === amount
                );

                if (existingSwapIndex === -1) {
                    // Add a new entry for this reward swap only if it doesn't exist
                    swapsData[key][swap.blockNumber].rewardsOut!.push({
                        token: swap.token,
                        symbol: normalizedTokenInfos[swap.token.toLowerCase()]?.symbol,
                        amount: amount
                    });
                }
            }
        }



        //console.log(JSON.stringify(swapsData, null, 2));

        const allMatches = Object.entries(swapsData).flatMap(([protocol, blocks]) =>
            Object.entries(blocks).flatMap(([blockNumber, blockData]) => {
                const matches = matchWethInWithRewardsOut(blockData);
                if (matches.length > 0) {
                    return [{
                        protocol,
                        blockNumber: parseInt(blockNumber),
                        matches
                    }];
                }
                return [];
            })
        );

        console.log(JSON.stringify(allMatches, null, 2));
    }
}

main()



const swapIn = [
    {
        blockNumber: 20339315,
        logIndex: 1022,
        from: '0x2903dbec58d193c34708de22f89fd7a42b6d0eb0',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        amount: 2078806n
    },
    {
        blockNumber: 20344929,
        logIndex: 709,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0',
        amount: 438869374530884539305n
    },
    {
        blockNumber: 20344929,
        logIndex: 714,
        from: '0x71c91b173984d3955f7756914bbf9a7332538595',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x402f878bdd1f5c66fdaf0fababcf74741b68ac36',
        amount: 494527933597523659246n
    },
    {
        blockNumber: 20345053,
        logIndex: 336,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f',
        amount: 833496114415282125703n
    },
    {
        blockNumber: 20345053,
        logIndex: 337,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        amount: 3891239639n
    },
    {
        blockNumber: 20345053,
        logIndex: 338,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc0c293ce456ff0ed870add98a0828dd4d2903dbf',
        amount: 3380450351179689323677n
    },
    {
        blockNumber: 20345053,
        logIndex: 339,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 45223779691127426n
    },
    {
        blockNumber: 20345053,
        logIndex: 340,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xcdf7028ceab81fa0c6971208e83fa7872994bee5',
        amount: 30942770741909188119729n
    },
    {
        blockNumber: 20345053,
        logIndex: 341,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xba100000625a3754423978a60c9317c58a424e3d',
        amount: 107611193997635820816n
    },
    {
        blockNumber: 20345053,
        logIndex: 349,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 65503865212418106n
    },
    {
        blockNumber: 20345053,
        logIndex: 352,
        from: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 1110428659620464923n
    },
    {
        blockNumber: 20345053,
        logIndex: 363,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 716106208044764908n
    },
    {
        blockNumber: 20345053,
        logIndex: 372,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 219015300941175040n
    },
    {
        blockNumber: 20345053,
        logIndex: 398,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xba100000625a3754423978a60c9317c58a424e3d',
        amount: 2752797538502020734378n
    },
    {
        blockNumber: 20345053,
        logIndex: 408,
        from: '0xba12222222228d8ba445958a75a0704d566bf2c8',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xf24d8651578a55b0c119b9910759a351a3458895',
        amount: 783155586638108834690n
    },
    {
        blockNumber: 20345086,
        logIndex: 387,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f',
        amount: 819576008416667666233n
    },
    {
        blockNumber: 20345086,
        logIndex: 388,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x090185f2135308bad17527004364ebcc2d37e5f6',
        amount: 1005502343378708083507200n
    },
    {
        blockNumber: 20345086,
        logIndex: 389,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x41d5d79431a913c4ae7d69a668ecdfe5ff9dfb68',
        amount: 68286354547008672411n
    },
    {
        blockNumber: 20345086,
        logIndex: 397,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 64049137155224654n
    },
    {
        blockNumber: 20345086,
        logIndex: 403,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 198745330220525291n
    },
    {
        blockNumber: 20345086,
        logIndex: 412,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 549796036152342733n
    },
    {
        blockNumber: 20345086,
        logIndex: 419,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x365accfca291e7d3914637abf1f7635db165bb09',
        amount: 37350136987580117719n
    },
    {
        blockNumber: 20345086,
        logIndex: 422,
        from: '0x28ca243dc0ac075dd012fcf9375c25d18a844d96',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad',
        amount: 36844843670413648478n
    },
    {
        blockNumber: 20362634,
        logIndex: 394,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0',
        amount: 512488867223661786134n
    },
    {
        blockNumber: 20362634,
        logIndex: 395,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x090185f2135308bad17527004364ebcc2d37e5f6',
        amount: 9985809172007105882572544n
    },
    {
        blockNumber: 20362634,
        logIndex: 418,
        from: '0x111111125421ca6dc452d289314280a0f8842a65',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 374726395175228541n
    },
    {
        blockNumber: 20362634,
        logIndex: 428,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 1992952869672482780n
    },
    {
        blockNumber: 20362634,
        logIndex: 438,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
        amount: 29432376058997153460937n
    },
    {
        blockNumber: 20362634,
        logIndex: 449,
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 28843824085213885853849n
    },
    {
        blockNumber: 20362651,
        logIndex: 205,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x30d20208d987713f46dfd34ef128bb16c404d10f',
        amount: 1040338537327145847845n
    },
    {
        blockNumber: 20362651,
        logIndex: 206,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x41d5d79431a913c4ae7d69a668ecdfe5ff9dfb68',
        amount: 735613691467147518839n
    },
    {
        blockNumber: 20362651,
        logIndex: 220,
        from: '0x22f9dcf4647084d6c31b2765f6910cd85c178c18',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 182418748269104040n
    },
    {
        blockNumber: 20362651,
        logIndex: 261,
        from: '0x111111125421ca6dc452d289314280a0f8842a65',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 6148240619619774726n
    },
    {
        blockNumber: 20362651,
        logIndex: 271,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
        amount: 78684927138354083080229n
    },
    {
        blockNumber: 20362651,
        logIndex: 279,
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 77111228595587002662912n
    },
    {
        blockNumber: 20362656,
        logIndex: 234,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xdbdb4d16eda451d0503b854cf79d55697f90c8df',
        amount: 110458376415579630086n
    },
    {
        blockNumber: 20362656,
        logIndex: 243,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 544235146852606498n
    },
    {
        blockNumber: 20362656,
        logIndex: 250,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
        amount: 6784260838868939511483n
    },
    {
        blockNumber: 20362656,
        logIndex: 258,
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 6648575622091560189952n
    },
    {
        blockNumber: 20362675,
        logIndex: 767,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x6b5204b0be36771253cc38e88012e02b752f0f36',
        amount: 14947942343536946481526n
    },
    {
        blockNumber: 20362675,
        logIndex: 768,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee',
        amount: 281609324951613946n
    },
    {
        blockNumber: 20362675,
        logIndex: 772,
        from: '0x9dbcfc09e651c040ee68d6dbeb8a09f8dd0caa77',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 1029681181318889988n
    },
    {
        blockNumber: 20362675,
        logIndex: 777,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 293772305078569178n
    },
    {
        blockNumber: 20362675,
        logIndex: 785,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
        amount: 16461776138093519299892n
    },
    {
        blockNumber: 20362675,
        logIndex: 793,
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 16132540615331648897024n
    },
    {
        blockNumber: 20362683,
        logIndex: 387,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x97effb790f2fbb701d88f89db4521348a2b77be8',
        amount: 8583173002189520817782n
    },
    {
        blockNumber: 20362683,
        logIndex: 388,
        from: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0x8207c1ffc5b6804f6024322ccf34f29c3541ae26',
        amount: 66787897968407484451072n
    },
    {
        blockNumber: 20362683,
        logIndex: 393,
        from: '0x004c167d27ada24305b76d80762997fa6eb8d9b2',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 458546018096565503n
    },
    {
        blockNumber: 20362683,
        logIndex: 397,
        from: '0x807cf9a772d5a3f9cefbc1192e939d62f0d9bd38',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        amount: 1891072717550813794n
    },
    {
        blockNumber: 20362683,
        logIndex: 406,
        from: '0x6a000f20005980200259b80c5102003040001068',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
        amount: 29243051941081477299830n
    },
    {
        blockNumber: 20362683,
        logIndex: 414,
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 28658190902259846479872n
    },
    {
        blockNumber: 20363867,
        logIndex: 407,
        from: '0x9cc16bdd233a74646e31100b2f13334810d12cb0',
        to: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
        token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
        amount: 23604000000000000000000n
    }
]

const swapOut =
    [
        {
            blockNumber: 20344929,
            logIndex: 712,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x71c91b173984d3955f7756914bbf9a7332538595',
            token: '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0',
            amount: 430091987040266813440n
        },
        {
            blockNumber: 20344929,
            logIndex: 716,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0x402f878bdd1f5c66fdaf0fababcf74741b68ac36',
            amount: 494527933597523659246n
        },
        {
            blockNumber: 20345053,
            logIndex: 344,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xc465c0a16228ef6fe1bf29c04fdb04bb797fd537',
            token: '0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f',
            amount: 833496114415282125703n
        },
        {
            blockNumber: 20345053,
            logIndex: 353,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',
            token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            amount: 3891239639n
        },
        {
            blockNumber: 20345053,
            logIndex: 357,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xc0c293ce456ff0ed870add98a0828dd4d2903dbf',
            amount: 3380450351179689323677n
        },
        {
            blockNumber: 20345053,
            logIndex: 364,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xcdf7028ceab81fa0c6971208e83fa7872994bee5',
            amount: 30942770741909188119729n
        },
        {
            blockNumber: 20345053,
            logIndex: 373,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xd08d0006f00040b400180f9500b00c5026ac0900',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 2156276713068857980n
        },
        {
            blockNumber: 20345053,
            logIndex: 402,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xba12222222228d8ba445958a75a0704d566bf2c8',
            token: '0xba100000625a3754423978a60c9317c58a424e3d',
            amount: 2803200557849663504384n
        },
        {
            blockNumber: 20345053,
            logIndex: 409,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xf24d8651578a55b0c119b9910759a351a3458895',
            amount: 783155586638108834690n
        },
        {
            blockNumber: 20345086,
            logIndex: 392,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xc465c0a16228ef6fe1bf29c04fdb04bb797fd537',
            token: '0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f',
            amount: 819576008416667666233n
        },
        {
            blockNumber: 20345086,
            logIndex: 398,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x5f0000d4780a00d2dce0a00004000800cb0e5041',
            token: '0x090185f2135308bad17527004364ebcc2d37e5f6',
            amount: 1005502343378708083507200n
        },
        {
            blockNumber: 20345086,
            logIndex: 406,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0x41d5d79431a913c4ae7d69a668ecdfe5ff9dfb68',
            amount: 68286354547008672411n
        },
        {
            blockNumber: 20345086,
            logIndex: 413,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 812590493528092656n
        },
        {
            blockNumber: 20345086,
            logIndex: 421,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x28ca243dc0ac075dd012fcf9375c25d18a844d96',
            token: '0x365accfca291e7d3914637abf1f7635db165bb09',
            amount: 36603134247828516864n
        },
        {
            blockNumber: 20345086,
            logIndex: 424,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad',
            amount: 36844843670413648478n
        },
        {
            blockNumber: 20362634,
            logIndex: 400,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xe37e799d5077682fa0a244d46e5649f71457bd09',
            token: '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0',
            amount: 512488867223661786134n
        },
        {
            blockNumber: 20362634,
            logIndex: 419,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xd08d0006f00040b400180f9500b00c5026ac0900',
            token: '0x090185f2135308bad17527004364ebcc2d37e5f6',
            amount: 9985809172007105882572544n
        },
        {
            blockNumber: 20362634,
            logIndex: 429,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xd08d0006f00040b400180f9500b00c5026ac0900',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 2365055433757485005n
        },
        {
            blockNumber: 20362634,
            logIndex: 440,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x52f541764e6e90eebc5c21ff570de0e2d63766b6',
            token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
            amount: 28843728537817209372672n
        },
        {
            blockNumber: 20362634,
            logIndex: 451,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 28843824085213885853849n
        },
        {
            blockNumber: 20362651,
            logIndex: 209,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x22f9dcf4647084d6c31b2765f6910cd85c178c18',
            token: '0x30d20208d987713f46dfd34ef128bb16c404d10f',
            amount: 1040026435765947858944n
        },
        {
            blockNumber: 20362651,
            logIndex: 224,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xe37e799d5077682fa0a244d46e5649f71457bd09',
            token: '0x41d5d79431a913c4ae7d69a668ecdfe5ff9dfb68',
            amount: 735613691467147518839n
        },
        {
            blockNumber: 20362651,
            logIndex: 262,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xd08d0006f00040b400180f9500b00c5026ac0900',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 6330851504591285513n
        },
        {
            blockNumber: 20362651,
            logIndex: 272,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x52f541764e6e90eebc5c21ff570de0e2d63766b6',
            token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
            amount: 77111228595587002662912n
        },
        {
            blockNumber: 20362651,
            logIndex: 281,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 77111228595587002662912n
        },
        {
            blockNumber: 20362656,
            logIndex: 237,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x5f0000d4780a00d2dce0a00004000800cb0e5041',
            token: '0xdbdb4d16eda451d0503b854cf79d55697f90c8df',
            amount: 110458376415579630086n
        },
        {
            blockNumber: 20362656,
            logIndex: 244,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 544235136852606528n
        },
        {
            blockNumber: 20362656,
            logIndex: 251,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x52f541764e6e90eebc5c21ff570de0e2d63766b6',
            token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
            amount: 6648575622091560189952n
        },
        {
            blockNumber: 20362656,
            logIndex: 260,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 6648575622091560189952n
        },
        {
            blockNumber: 20362675,
            logIndex: 769,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x111111125421ca6dc452d289314280a0f8842a65',
            token: '0x6b5204b0be36771253cc38e88012e02b752f0f36',
            amount: 14947942343536946481526n
        },
        {
            blockNumber: 20362675,
            logIndex: 775,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x202a6012894ae5c288ea824cbc8a9bfb26a49b93',
            token: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee',
            amount: 281609324951613946n
        },
        {
            blockNumber: 20362675,
            logIndex: 779,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 1323453476397459140n
        },
        {
            blockNumber: 20362675,
            logIndex: 786,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x52f541764e6e90eebc5c21ff570de0e2d63766b6',
            token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
            amount: 16132540615331648897024n
        },
        {
            blockNumber: 20362675,
            logIndex: 795,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 16132540615331648897024n
        },
        {
            blockNumber: 20362683,
            logIndex: 389,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x111111125421ca6dc452d289314280a0f8842a65',
            token: '0x97effb790f2fbb701d88f89db4521348a2b77be8',
            amount: 8583173002189520817782n
        },
        {
            blockNumber: 20362683,
            logIndex: 398,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x807cf9a772d5a3f9cefbc1192e939d62f0d9bd38',
            token: '0x8207c1ffc5b6804f6024322ccf34f29c3541ae26',
            amount: 66787897968407484451072n
        },
        {
            blockNumber: 20362683,
            logIndex: 400,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x6a000f20005980200259b80c5102003040001068',
            token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            amount: 2349384082460592129n
        },
        {
            blockNumber: 20362683,
            logIndex: 407,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0x52f541764e6e90eebc5c21ff570de0e2d63766b6',
            token: '0xd533a949740bb3306d119cc777fa900ba034cd52',
            amount: 28658190902259846479872n
        },
        {
            blockNumber: 20362683,
            logIndex: 416,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 28658190902259846479872n
        },
        {
            blockNumber: 20363867,
            logIndex: 409,
            from: '0x0000000a3fc396b89e4c11841b39d9dff85a5d05',
            to: '0xadfbfd06633eb92fc9b58b3152fe92b0a24eb1ff',
            token: '0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',
            amount: 23604000000000000000000n
        }
    ]