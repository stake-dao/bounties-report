export interface DelegationEvent {
  delegator: string;
  space: string;
  delegate: string;
  blockNumber: bigint;
  eventType: "Set" | "Clear";
  timestamp?: number;
}

export interface DelegationSnapshot<TKey extends string> {
  key: TKey;
  snapshotBlock: bigint;
}

/**
 * Reconstruct the active delegation state at a specific block.
 */
export function reconstructDelegationState(
  events: readonly DelegationEvent[],
  atBlock: bigint
): string[] {
  const relevantEvents = events
    .filter((event) => event.blockNumber <= atBlock)
    .sort((a, b) => Number(a.blockNumber - b.blockNumber));

  const delegatorState = new Map<string, boolean>();
  for (const event of relevantEvents) {
    delegatorState.set(event.delegator, event.eventType === "Set");
  }

  return [...delegatorState.entries()]
    .filter(([, isDelegating]) => isDelegating)
    .map(([delegator]) => delegator);
}

/**
 * Fetch one shared registry history through the latest requested block, then
 * reconstruct each gauge at its own proposal snapshot.
 */
export async function loadDelegationStatesAtSnapshots<TKey extends string>(
  snapshots: readonly DelegationSnapshot<TKey>[],
  fetchEvents: (toBlock: bigint) => Promise<DelegationEvent[]>
): Promise<Map<TKey, string[]>> {
  const states = new Map<TKey, string[]>();
  if (snapshots.length === 0) return states;

  const latestBlock = snapshots.reduce(
    (latest, snapshot) =>
      snapshot.snapshotBlock > latest ? snapshot.snapshotBlock : latest,
    snapshots[0].snapshotBlock
  );
  const events = await fetchEvents(latestBlock);

  for (const snapshot of snapshots) {
    states.set(
      snapshot.key,
      reconstructDelegationState(events, snapshot.snapshotBlock)
    );
  }

  return states;
}
