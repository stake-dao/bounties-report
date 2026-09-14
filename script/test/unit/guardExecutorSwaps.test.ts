import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex } from "viem";
import { fetchGuardExecutorSwaps } from "../../utils/reportUtils";
import actualSwaps from "../fixtures/fxn-atomic-swaps-1788998400.json";

const { getLogs } = vi.hoisted(() => ({ getLogs: vi.fn() }));
vi.mock("../../utils/explorerUtils", () => ({
  createBlockchainExplorerUtils: () => ({ getLogsByAddressesAndTopics: getLogs }),
}));

const ATOMIC = "0xb3619b30910df374965A6169082d2597a1Cf15dc";
const LEGACY = "0xCE1d84E654DB546e3EdFf1481bA3d4c9394ba1C5";
const LANE = "0xb47ff6b6acbeb1889cd35f85691ba66fa3aa69d4b8ca79c2e9ceae71005cb304";
const FXN = "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09";
const SDEX = "0x5DE8ab7E27f6E7A1fFf3E5B337584Aa43961BEeF";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const ROUTER = "0x0000000000000000000000000000000000000001";
const ATOMIC_TOPIC = keccak256(toHex("Swapped(bytes32,bytes32,address,address,address,uint256,uint256)"));
const LEGACY_TOPIC = keccak256(toHex("Swapped(address,address,address,uint256,uint256)"));

const atomicLog = {
  blockNumber: "0x102", logIndex: "0x7", transactionHash: "0xatomic",
  topics: [ATOMIC_TOPIC, pad("0x01"), LANE, pad(SDEX)],
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [FXN, ROUTER, 645350898832760518502959n, 9500000000000000000n],
  ),
};
const legacyLog = {
  blockNumber: "0x101", logIndex: "0x3", transactionHash: "0xlegacy",
  topics: [LEGACY_TOPIC, pad(SDEX), pad(FXN), pad(ROUTER)],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [123n, 45n]),
};

beforeEach(() => { getLogs.mockReset(); });

describe("guard executor report events", () => {
  it("recovers both real September 14 sales omitted from the FXN report", async () => {
    getLogs.mockImplementation(async ([address]) => ({ result: address === ATOMIC ? actualSwaps : [] }));
    const events = await fetchGuardExecutorSwaps(1, 25978361, 25978361, FXN);
    expect(events.map((event) => [event.sellToken, event.amountIn, event.amountOut])).toEqual([
      [SDEX.toLowerCase(), 645350898832760518502959n, 9394703885349516256n],
      ["0xdbdb4d16eda451d0503b854cf79d55697f90c8df", 6581336683683855914n, 476420682104229554n],
    ]);
    expect(events.reduce((sum, event) => sum + event.amountOut, 0n)).toBe(9871124567453745810n);
  });

  it("includes atomic FXN sales with the pinned lane and retains historical sales", async () => {
    getLogs.mockImplementation(async ([address]) => ({
      result: address === ATOMIC ? [atomicLog] : [legacyLog],
    }));
    const events = await fetchGuardExecutorSwaps(1, 100, 1000, FXN);
    expect(events.map((event) => [event.transactionHash, event.sellToken, event.amountIn, event.amountOut])).toEqual([
      ["0xlegacy", SDEX.toLowerCase(), 123n, 45n],
      ["0xatomic", SDEX.toLowerCase(), 645350898832760518502959n, 9500000000000000000n],
    ]);
    expect(getLogs).toHaveBeenCalledWith([ATOMIC], 100, 1000, { "0": ATOMIC_TOPIC, "2": LANE }, 1);
    expect(getLogs).toHaveBeenCalledWith([LEGACY], 100, 1000, { "0": LEGACY_TOPIC, "2": pad(FXN).toLowerCase() }, 1);
  });

  it("filters the atomic buy token decoded from data", async () => {
    getLogs.mockImplementation(async ([address]) => ({
      result: address === ATOMIC ? [{ ...atomicLog, data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [CRV, ROUTER, 123n, 45n],
      ) }] : [],
    }));
    expect(await fetchGuardExecutorSwaps(1, 100, 1000, FXN)).toEqual([]);
  });

  it("keeps the legacy Curve scan unchanged", async () => {
    getLogs.mockResolvedValue({ result: [] });
    await fetchGuardExecutorSwaps(1, 100, 1000, CRV);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith([LEGACY], 100, 1000, { "0": LEGACY_TOPIC, "2": pad(CRV).toLowerCase() }, 1);
  });

  it("fails when the atomic event request fails", async () => {
    getLogs.mockImplementation(async ([address]) => {
      if (address === ATOMIC) throw new Error("explorer unavailable");
      return { result: [] };
    });
    await expect(fetchGuardExecutorSwaps(1, 100, 1000, FXN)).rejects.toThrow("explorer unavailable");
  });
});
