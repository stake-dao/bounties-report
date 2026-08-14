/**
 * Votium proceeds split across the two weeks of a round (ENG-2105).
 *
 * The swap job sells a whole Votium round in the first Monday window after it
 * ends, so the realized sCRVUSD no longer depends on where the market went
 * over the following fortnight. The two-week payout smoothing delegators see
 * moved here: the merkle that follows the swap distributes half of the
 * Votium-attributable sCRVUSD and carries the rest into the next weekly
 * merkle, through a committed artifact.
 *
 * Two facts make this harder than it sounds and shape everything below:
 *
 * 1. every sCRVUSD deposit into the delegators distributor is a share mint
 *    from the zero address — the VoteMarket swap, the Votium swap, the bridged
 *    Convex-CRV swap and the residual settlements are indistinguishable by
 *    transfer log alone. Votium deposits are therefore identified by the
 *    transaction they ride in: the Votium batch withdraws the vault's reward
 *    tokens to the shared executor in the same transaction that mints the
 *    sCRVUSD;
 * 2. the round phase must not become a third week-parity computation (the swap
 *    job and the claim workflow already have one each, and they only agree
 *    because Votium claims on even weeks). Week A is recognised from the
 *    period's own claim data, week B from an unconsumed carryover artifact.
 */

import fs from "node:fs";
import path from "node:path";
import { encodePacked, keccak256, pad } from "viem";
import {
	ALL_MIGHT_V2,
	VOTIUM_FORWARDER,
	VOTIUM_MERKLE_SPLIT_FROM_PERIOD,
	WEEK,
} from "../utils/constants";
import { sumClaimedAmounts } from "../utils/votiumRawPayouts";

export const VOTIUM_CARRYOVER_FILE = "votium_scrvusd_carryover.json";
export const DELEGATORS_BREAKDOWN_FILE = "delegators_split_breakdown.json";

/** How far back an unconsumed carryover is still picked up. A skipped Tuesday
 *  delays the second half by a week instead of stranding it; beyond this the
 *  round is old enough that a human should be looking at it. */
export const MAX_CARRY_WEEKS_BACK = 4;

const REPORTS_ROOT = "bounties-reports";
const WEEKLY_BOUNTIES_ROOT = "weekly-bounties";

const TRANSFER_TOPIC = keccak256(
	encodePacked(["string"], ["Transfer(address,address,uint256)"]),
).toLowerCase();

export type VotiumCarryover = {
	/** Period that swapped the round; also the directory the file lives in. */
	period: number;
	/** Votium-attributable sCRVUSD minted in that period. */
	votiumScrvUsd: bigint;
	/** Half paid in that period. */
	distributed: bigint;
	/** Half owed to the following distribution. */
	carried: bigint;
	/**
	 * Block range the amount was measured over. Recorded so the next period
	 * re-derives the SAME number: re-scanning "up to now" would also pick up
	 * deposits that landed after that merkle ran and turn a late manual swap
	 * into a hard failure.
	 */
	fromBlock: number;
	toBlock: number;
	/** The classified Votium deposit transactions, for audit. */
	sourceTxs: string[];
};

export type ScrvUsdTransfer = { txHash: string; amount: bigint };

export type VotiumClassification = {
	votiumAmount: bigint;
	nonVotiumAmount: bigint;
	votiumTxs: string[];
};

export type FoundCarryover = { period: number; carry: VotiumCarryover };

export type VotiumPotPlan = {
	/** Votium-attributable sCRVUSD received this period. */
	votiumReceived: bigint;
	/** Everything else received this period (VM, bridged CRV, settlements). */
	nonVotiumReceived: bigint;
	/** Held back from this period's pot for the next distribution. */
	withheld: bigint;
	/** Carried in from earlier periods. */
	carriedIn: bigint;
	/** Periods whose carryover this pot consumes. */
	carriedInFrom: number[];
	/** True when this period holds back half of its Votium proceeds. */
	isRoundWeekA: boolean;
	votiumTxs: string[];
};

/**
 * Half now, half next time — the odd wei stays with the second half so the two
 * halves always add back to the total.
 */
export function splitVotiumProceeds(total: bigint): {
	distributed: bigint;
	carried: bigint;
} {
	if (total < 0n) {
		throw new Error(`Votium proceeds cannot be negative: ${total}`);
	}
	const distributed = total / 2n;
	return { distributed, carried: total - distributed };
}

const parseWei = (value: unknown, label: string): bigint => {
	if (typeof value !== "string" || !/^\d+$/.test(value)) {
		throw new Error(`${label} must be an unsigned integer string`);
	}
	return BigInt(value);
};

const parseBlock = (value: unknown, label: string): number => {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a block number`);
	}
	return value;
};

/**
 * A carryover file is an instruction to pay money that arrived in an earlier
 * period, so nothing in it is taken on trust: the amounts must be well formed
 * and conserve the split, and the period must match the directory it was read
 * from. Callers additionally re-derive `votiumScrvUsd` from chain state before
 * spending it (see `assertCarryoverMatchesChain`).
 */
export function parseCarryover(
	raw: unknown,
	expectedPeriod: number,
): VotiumCarryover {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Votium carryover must be an object");
	}
	const data = raw as Record<string, unknown>;

	if (data.period !== expectedPeriod) {
		throw new Error(
			`Votium carryover period ${String(data.period)} does not match the ` +
				`period it was found in (${expectedPeriod})`,
		);
	}

	const votiumScrvUsd = parseWei(data.votiumScrvUsd, "votiumScrvUsd");
	const distributed = parseWei(data.distributed, "distributed");
	const carried = parseWei(data.carried, "carried");

	const expected = splitVotiumProceeds(votiumScrvUsd);
	if (
		distributed !== expected.distributed ||
		carried !== expected.carried
	) {
		throw new Error(
			`Votium carryover for period ${expectedPeriod} does not conserve the ` +
				`split: ${votiumScrvUsd} total, ${distributed} distributed, ` +
				`${carried} carried (expected ${expected.distributed} / ` +
				`${expected.carried})`,
		);
	}

	const fromBlock = parseBlock(data.fromBlock, "fromBlock");
	const toBlock = parseBlock(data.toBlock, "toBlock");
	if (toBlock < fromBlock) {
		throw new Error(
			`Votium carryover block range is inverted: ${fromBlock} → ${toBlock}`,
		);
	}

	if (!Array.isArray(data.sourceTxs)) {
		throw new Error("sourceTxs must be an array");
	}
	const sourceTxs = data.sourceTxs.map((tx, index) => {
		if (typeof tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
			throw new Error(`sourceTxs[${index}] must be a transaction hash`);
		}
		return tx.toLowerCase();
	});

	return {
		period: expectedPeriod,
		votiumScrvUsd,
		distributed,
		carried,
		fromBlock,
		toBlock,
		sourceTxs,
	};
}

export function serializeCarryover(carry: VotiumCarryover): string {
	return JSON.stringify(
		{
			period: carry.period,
			votiumScrvUsd: carry.votiumScrvUsd.toString(),
			distributed: carry.distributed.toString(),
			carried: carry.carried.toString(),
			fromBlock: carry.fromBlock,
			toBlock: carry.toBlock,
			sourceTxs: carry.sourceTxs,
		},
		null,
		2,
	);
}

export function carryoverPath(period: number, reportsRoot = REPORTS_ROOT) {
	return path.join(reportsRoot, String(period), "vlCVX", VOTIUM_CARRYOVER_FILE);
}

export function breakdownPath(period: number, reportsRoot = REPORTS_ROOT) {
	return path.join(
		reportsRoot,
		String(period),
		"vlCVX",
		DELEGATORS_BREAKDOWN_FILE,
	);
}

/** True when a period between the carryover and now already paid it out. */
function isCarryoverConsumed(
	carryPeriod: number,
	currentPeriod: number,
	reportsRoot: string,
): boolean {
	for (let period = carryPeriod + WEEK; period < currentPeriod; period += WEEK) {
		const file = breakdownPath(period, reportsRoot);
		if (!fs.existsSync(file)) continue;
		try {
			const breakdown = JSON.parse(fs.readFileSync(file, "utf8"));
			const consumed = breakdown?.votium?.carriedInFrom;
			if (Array.isArray(consumed) && consumed.includes(carryPeriod)) {
				return true;
			}
		} catch (error) {
			throw new Error(
				`Cannot read the delegators split breakdown for period ${period} ` +
					`while checking whether the ${carryPeriod} Votium carryover was ` +
					`already paid: ${error}`,
			);
		}
	}
	return false;
}

/**
 * Every carryover in the look-back window that no later period has paid out,
 * oldest first. Normally at most one; more than one only after consecutive
 * missed distributions, and paying them together is what keeps them from being
 * stranded.
 */
export function findUnconsumedCarryovers(
	currentPeriod: number,
	reportsRoot = REPORTS_ROOT,
): FoundCarryover[] {
	const found: FoundCarryover[] = [];
	for (let weeksBack = 1; weeksBack <= MAX_CARRY_WEEKS_BACK; weeksBack++) {
		const period = currentPeriod - weeksBack * WEEK;
		const file = carryoverPath(period, reportsRoot);
		if (!fs.existsSync(file)) continue;

		const carry = parseCarryover(
			JSON.parse(fs.readFileSync(file, "utf8")),
			period,
		);
		if (carry.carried === 0n) continue;
		if (isCarryoverConsumed(period, currentPeriod, reportsRoot)) continue;
		found.push({ period, carry });
	}
	return found.sort((a, b) => a.period - b.period);
}

export type PooledVotiumRemainder = {
	/** The period's claim data was found. Its absence is not "no claim". */
	claimDataPresent: boolean;
	/** Something was claimed beyond what the Thursday withdraw earmarks. */
	hasRemainder: boolean;
};

/**
 * Whether this period claimed Votium rewards that the swap job was expected to
 * sell — the round's claim landed here and something was left after the
 * amounts earmarked for the Thursday voters withdraw. This is the week-A
 * marker: file presence alone is not enough, since the claim generator writes
 * its file even for an empty round and a fully attributed round leaves nothing
 * pooled.
 *
 * `claimDataPresent` is reported separately because a missing file means "we
 * cannot tell", not "no claim" — the caller refuses to guess when Votium
 * proceeds are on the table.
 */
export function pooledVotiumRemainder(
	period: number,
	roots: { reportsRoot?: string; weeklyBountiesRoot?: string } = {},
): PooledVotiumRemainder {
	const reportsRoot = roots.reportsRoot ?? REPORTS_ROOT;
	const weeklyBountiesRoot = roots.weeklyBountiesRoot ?? WEEKLY_BOUNTIES_ROOT;

	const claimsFile = path.join(
		weeklyBountiesRoot,
		String(period),
		"votium",
		"claimed_bounties_convex.json",
	);
	if (!fs.existsSync(claimsFile)) {
		return { claimDataPresent: false, hasRemainder: false };
	}

	const claimed = sumClaimedAmounts(
		JSON.parse(fs.readFileSync(claimsFile, "utf8")),
	);

	const withdrawalFile = path.join(
		reportsRoot,
		String(period),
		"vlCVX",
		"votium_thursday_withdrawal.json",
	);
	const reserved: Record<string, bigint> = {};
	if (fs.existsSync(withdrawalFile)) {
		const withdrawal = JSON.parse(fs.readFileSync(withdrawalFile, "utf8"));
		for (const [token, amount] of Object.entries(
			(withdrawal?.tokens ?? {}) as Record<string, string>,
		)) {
			const key = token.toLowerCase();
			reserved[key] = (reserved[key] ?? 0n) + parseWei(
				amount,
				`votium_thursday_withdrawal.tokens.${token}`,
			);
		}
	}

	return {
		claimDataPresent: true,
		hasRemainder: Object.entries(claimed).some(
			([token, amount]) => amount > (reserved[token] ?? 0n),
		),
	};
}

/**
 * The Votium batch's fingerprint: the vault's reward tokens moving to the
 * shared executor. The Thursday voters batch also withdraws from the vault but
 * sends the tokens elsewhere and mints no sCRVUSD to this distributor, so
 * requiring both halves keeps it out.
 */
export function isVotiumSwapReceipt(
	logs: readonly { topics?: readonly (string | null)[] }[],
): boolean {
	const from = pad(VOTIUM_FORWARDER as `0x${string}`, {
		size: 32,
	}).toLowerCase();
	const to = pad(ALL_MIGHT_V2 as `0x${string}`, { size: 32 }).toLowerCase();

	return logs.some((log) => {
		const topics = log.topics ?? [];
		return (
			topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
			topics[1]?.toLowerCase() === from &&
			topics[2]?.toLowerCase() === to
		);
	});
}

/**
 * Split the period's sCRVUSD deposits into the Votium swap's output and
 * everything else, by looking at the transaction each deposit rode in.
 *
 * Deliberately NOT counted as Votium: the residual settlements and orphan
 * recoveries that follow a Votium batch. They are separate transactions that
 * sweep the executor's WETH and never touch the vault, so they read as
 * ordinary deposits and are paid out in full in the week they land. They are
 * the delivery-above-guaranteed spread of the batch — small next to the batch
 * itself, and visible in the breakdown artifact.
 */
export async function classifyVotiumDeposits(
	getReceipt: (
		txHash: string,
	) => Promise<{ logs: readonly { topics?: readonly (string | null)[] }[] }>,
	transfers: readonly ScrvUsdTransfer[],
): Promise<VotiumClassification> {
	const byTx = new Map<string, bigint>();
	for (const transfer of transfers) {
		const key = transfer.txHash.toLowerCase();
		byTx.set(key, (byTx.get(key) ?? 0n) + transfer.amount);
	}

	let votiumAmount = 0n;
	let nonVotiumAmount = 0n;
	const votiumTxs: string[] = [];

	for (const [txHash, amount] of byTx) {
		const receipt = await getReceipt(txHash);
		if (isVotiumSwapReceipt(receipt.logs ?? [])) {
			votiumAmount += amount;
			votiumTxs.push(txHash);
		} else {
			nonVotiumAmount += amount;
		}
	}

	return { votiumAmount, nonVotiumAmount, votiumTxs };
}

/**
 * Re-derive the carryover's total from chain state before spending it, so a
 * hand-edited or stale artifact cannot authorise its own payout. `recompute`
 * re-classifies the deposits over the block range the artifact recorded — the
 * same window the withholding merkle measured, so the answer is stable however
 * long after the fact this runs.
 */
export async function assertCarryoverMatchesChain(
	carry: VotiumCarryover,
	recompute: (
		fromBlock: number,
		toBlock: number,
	) => Promise<VotiumClassification>,
): Promise<void> {
	const onChain = await recompute(carry.fromBlock, carry.toBlock);
	if (onChain.votiumAmount !== carry.votiumScrvUsd) {
		throw new Error(
			`Votium carryover for period ${carry.period} claims ` +
				`${carry.votiumScrvUsd} wei of swap proceeds but the chain shows ` +
				`${onChain.votiumAmount} wei — refusing to distribute it`,
		);
	}
}

export function votiumSplitActivationPeriod(
	env: NodeJS.ProcessEnv = process.env,
): number | null {
	const raw = (env.VOTIUM_MERKLE_SPLIT_FROM ?? "").trim();
	if (!raw) return VOTIUM_MERKLE_SPLIT_FROM_PERIOD;

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`VOTIUM_MERKLE_SPLIT_FROM must be a weekly period timestamp, got "${raw}"`,
		);
	}
	return parsed;
}

/**
 * Whether this period runs the split at all. Until the activation period the
 * merkle behaves exactly as it did before ENG-2105 — which is what lets the
 * merkle side ship while the swap job still halves, and both sides start on
 * the same round.
 */
export function isVotiumSplitActive(
	period: number,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const from = votiumSplitActivationPeriod(env);
	return from !== null && period >= from;
}

/**
 * Decide what this period pays out of what it received and what it owes the
 * next one.
 */
export function planVotiumPot({
	active,
	remainder,
	classification,
	carryovers,
}: {
	active: boolean;
	remainder: PooledVotiumRemainder;
	classification: VotiumClassification;
	carryovers: readonly FoundCarryover[];
}): VotiumPotPlan {
	if (
		active &&
		classification.votiumAmount > 0n &&
		!remainder.claimDataPresent
	) {
		// The swap's proceeds are here but the period's claim data is not, so
		// there is no way to tell a round that must be split from a late swap
		// of an older one. Guessing "not week A" would quietly pay a whole
		// round out in one week and defeat the split.
		throw new Error(
			`Votium swap proceeds (${classification.votiumAmount} wei) received ` +
				"but this period has no claimed_bounties_convex.json to say which " +
				"round they belong to. Pull the claim artifacts (or confirm the " +
				"claim step ran) before generating the delegators merkle.",
		);
	}

	const weekA = active && remainder.hasRemainder;

	if (weekA && classification.votiumAmount === 0n && classification.nonVotiumAmount > 0n) {
		// sCRVUSD arrived in a week whose round was supposed to be swapped, and
		// none of it looks like the Votium batch. Either the classifier no
		// longer recognises that batch (a rotated executor would do it) or the
		// deposit came from somewhere unexpected; both would silently pay a
		// whole round out in one week, so stop instead.
		throw new Error(
			"Votium round claimed and swapped this period, but none of the " +
				`${classification.nonVotiumAmount} wei of sCRVUSD received could be ` +
				"attributed to the Votium swap. Check that the swap ran and that its " +
				"vault withdraw still targets the shared executor before rerunning.",
		);
	}

	const withheld = weekA
		? splitVotiumProceeds(classification.votiumAmount).carried
		: 0n;

	let carriedIn = 0n;
	const carriedInFrom: number[] = [];
	for (const { period, carry } of active ? carryovers : []) {
		carriedIn += carry.carried;
		carriedInFrom.push(period);
	}

	return {
		votiumReceived: classification.votiumAmount,
		nonVotiumReceived: classification.nonVotiumAmount,
		withheld,
		carriedIn,
		carriedInFrom,
		isRoundWeekA: weekA,
		votiumTxs: classification.votiumTxs,
	};
}
