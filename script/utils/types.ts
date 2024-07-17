interface Bounty {
    rewardToken: string,
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

interface HiddenHandBounty extends Bounty {
    gauge: string,
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


export { Bounty, VotemarketBounty, WardenBounty, HiddenHandBounty, GaugeShare, SwapEvent };