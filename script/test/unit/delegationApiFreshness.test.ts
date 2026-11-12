import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { getClient } from "../../utils/getClients";
import {
  clearAPICache,
  fetchAllDelegationEventsFromGraphQL,
} from "../../utils/delegationAPIUtils";

vi.mock("axios", () => ({
  default: { post: vi.fn(), isAxiosError: () => false },
}));
vi.mock("../../utils/getClients", () => ({ getClient: vi.fn() }));
vi.mock("../../utils/cacheUtils", () => ({
  fetchAllDelegators: async () => {},
  processAllDelegators: async () => [],
}));

const PERIOD = 1794441600;
const INDEXED = 26247263n;
const FINALIZED = 26399808n;
const events = [{
  id: "old-event-1",
  space: "sdcrv.eth",
  delegator: "0x1111111111111111111111111111111111111111",
  delegate: "0x2222222222222222222222222222222222222222",
  event: "Set",
  timestamp: "1792572527",
  block: "26239879",
}];

const response = (indexed = INDEXED) => ({
  data: { data: {
    DelegationEvent: events,
    chain_metadata: [{ chain_id: 1, latest_processed_block: Number(indexed) }],
  } },
});

beforeEach(() => {
  clearAPICache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(axios.post).mockResolvedValue(response());
  vi.mocked(getClient).mockResolvedValue({
    getBlock: async ({ blockTag }: { blockTag?: string }) => blockTag
      ? { number: FINALIZED, timestamp: 1794480000n }
      : { number: INDEXED, timestamp: 1793170000n },
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Snapshot delegation source coverage", () => {
  it("rejects an indexer behind the requested period even if it returns events", async () => {
    await expect(fetchAllDelegationEventsFromGraphQL(PERIOD))
      .rejects.toThrow(/indexer.*26247263.*1794441600/i);
  });

  it("still permits historical reads covered by the indexed block", async () => {
    await expect(fetchAllDelegationEventsFromGraphQL(1793169999))
      .resolves.toEqual(events);
  });

  it("does not mistake a quiet event history for a stale indexer", async () => {
    vi.mocked(axios.post).mockResolvedValue(response(FINALIZED));
    await expect(fetchAllDelegationEventsFromGraphQL(1794480012))
      .resolves.toEqual(events);
  });

  it("does not reuse a historical cache for a later uncovered period", async () => {
    await fetchAllDelegationEventsFromGraphQL(1793169999);
    await expect(fetchAllDelegationEventsFromGraphQL(PERIOD))
      .rejects.toThrow(/indexer/i);
  });

  it("rejects responses without an indexing watermark", async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { data: { DelegationEvent: events } },
    });
    await expect(fetchAllDelegationEventsFromGraphQL(PERIOD))
      .rejects.toThrow(/metadata|watermark/i);
  });
});
