import { describe, expect, it, vi } from "vitest";
import {
  DelegationEvent,
  loadDelegationStatesAtSnapshots,
} from "../../vlCVX/verify/delegationState";

function event(
  delegator: string,
  blockNumber: bigint,
  eventType: "Set" | "Clear"
): DelegationEvent {
  return {
    delegator,
    space: "cvx.eth",
    delegate: "stake-dao",
    blockNumber,
    eventType,
  };
}

describe("shared delegation event scans", () => {
  it("fetches once through the latest block and reconstructs each snapshot independently", async () => {
    const events = [
      event("alice", 90n, "Set"),
      event("alice", 150n, "Clear"),
      event("bob", 175n, "Set"),
    ];
    const fetchEvents = vi.fn(async () => events);

    const states = await loadDelegationStatesAtSnapshots(
      [
        { key: "fxn", snapshotBlock: 200n },
        { key: "curve", snapshotBlock: 100n },
      ],
      fetchEvents
    );

    expect(fetchEvents).toHaveBeenCalledOnce();
    expect(fetchEvents).toHaveBeenCalledWith(200n);
    expect(states.get("curve")).toEqual(["alice"]);
    expect(states.get("fxn")).toEqual(["bob"]);
  });

  it("uses the selected gauge block for a single-gauge verification", async () => {
    const fetchEvents = vi.fn(async () => [event("alice", 90n, "Set")]);

    const states = await loadDelegationStatesAtSnapshots(
      [{ key: "curve", snapshotBlock: 100n }],
      fetchEvents
    );

    expect(fetchEvents).toHaveBeenCalledOnce();
    expect(fetchEvents).toHaveBeenCalledWith(100n);
    expect(states.get("curve")).toEqual(["alice"]);
  });

  it("does not fetch registry events when no proposal was resolved", async () => {
    const fetchEvents = vi.fn(async () => []);

    const states = await loadDelegationStatesAtSnapshots([], fetchEvents);

    expect(fetchEvents).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });
});
