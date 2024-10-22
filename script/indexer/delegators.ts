import { AUTO_VOTER_DELEGATION_ADDRESS, DELEGATION_ADDRESS } from "../utils/constants";
import { getAllDelegators } from "../utils/utils";




/*
* Index delegators for all spaces on Stake DAO delegation + Autovoter
*/
const indexDelegators = async () => {
    const allSpaces = [
        'cvx.eth',
        'sdcrv.eth',
        'sdbal.eth',
        'sdfxs.eth',
        'sdfxn.eth',
        'sdpendle.eth',
        'sdcake.eth'
    ]
    console.log("Fetching Stake DAO delegation logs for Ethereum...");
    const allDelegationLogsEth = await getAllDelegators(DELEGATION_ADDRESS, "1", allSpaces.filter(space => space !== 'sdcake.eth'));
    console.log("Fetching Stake DAO delegation logs for BSC...");
    const allDelegationLogsBSC = await getAllDelegators(DELEGATION_ADDRESS, "56", ['sdcake.eth']);
    console.log("Fetching Autovoter delegation logs for Ethereum...");
    const allDelegationLogsAutoVoter = await getAllDelegators(AUTO_VOTER_DELEGATION_ADDRESS, "1", allSpaces.filter(space => space !== 'sdcake.eth'));
}

indexDelegators();