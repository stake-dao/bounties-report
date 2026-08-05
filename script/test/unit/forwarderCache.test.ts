import { describe, expect, it } from "vitest";
import {
	activeForwardersAt,
	type ForwarderData,
} from "../../utils/forwarderCacheUtils";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const EPOCH = 1_750_000_000;

const row = (partial: Partial<ForwarderData>): ForwarderData => ({
	event: "Set",
	from: A,
	to: "0xae86a3993d13c8d77ab77dbb8ccdb9b7bc18cd09",
	start: 0,
	expiration: 0,
	timestamp: 0,
	blockNumber: 0,
	...partial,
});

describe("activeForwardersAt", () => {
	it("treats BigInt parquet rows like numbers (0n expiration means active)", () => {
		// hyparquet returns INT64 columns as BigInt; 0n === 0 is false, which
		// used to classify every never-expired registration as inactive.
		const events = [
			row({ from: A, start: 1_700_000_000n, expiration: 0n, timestamp: 1_699_000_000n }),
			row({ from: B, start: 1_700_000_000n, expiration: 0n, timestamp: 1_699_000_000n }),
		];

		expect(activeForwardersAt(events, EPOCH).sort()).toEqual([A, B]);
	});

	it("applies start, expiration, and re-registration chronologically", () => {
		const events = [
			// A: registered then expired before the epoch
			row({ from: A, start: 1_700_000_000, timestamp: 1_699_000_000 }),
			row({ event: "Expire", from: A, expiration: 1_710_000_000, timestamp: 1_705_000_000 }),
			// B: expired, then re-registered (Set resets the expiration)
			row({ from: B, start: 1_700_000_000, timestamp: 1_699_000_000 }),
			row({ event: "Expire", from: B, expiration: 1_710_000_000, timestamp: 1_705_000_000 }),
			row({ from: B, start: 1_720_000_000, timestamp: 1_715_000_000 }),
			row({ event: "EndBlock", from: "", to: "" }),
		];

		expect(activeForwardersAt(events, EPOCH)).toEqual([B]);
		// Not started yet at an earlier epoch
		expect(activeForwardersAt(events, 1_699_500_000)).toEqual([]);
	});

	it("ignores events after the epoch", () => {
		const events = [
			row({ from: A, start: 1_700_000_000, timestamp: 1_699_000_000 }),
			row({ event: "Expire", from: A, expiration: 1_710_000_000, timestamp: EPOCH + 1 }),
		];

		expect(activeForwardersAt(events, EPOCH)).toEqual([A]);
	});
});
