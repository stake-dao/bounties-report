interface Bounty {
    rewardToken: string,
    gauge: string,
    amount: BigInt
}

interface VotemarketBounty extends Bounty {
    bountyId: BigInt,
}

interface WardenBounty extends Bounty {
    questID: BigInt,
    period: BigInt,
    distributor: string
}

interface GaugeShare {
    voted: number;
    share: number;
    gaugeAddress?: string;
    stakeVote?: number;
}

interface SwapEvent {
    blockNumber: number;
    logIndex: number;
    token: string;
    amount: bigint;
}


export { Bounty, VotemarketBounty, WardenBounty, GaugeShare, SwapEvent };