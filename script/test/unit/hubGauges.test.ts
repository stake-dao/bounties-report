import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addGaugeNamesToBounties, getGaugesInfos } from "../../utils/reportUtils";

const ROOT = "0xE40DeF1147775411Ce8Bd5a169dA0303200D438A";
const CHILD = "0xf2f6a4261DE8DB55de31DBfC2b7b92A267BEA3e2";
const MAINNET = "0xbB05Ca38069d14eD34930Cb37F5C04438Df8C3f4";
const FXN = "0xf0A3ECed42Dbd8353569639c0eaa833857aA0A75";
const GAUGES = [
  { gauge: ROOT, childGauge: CHILD, shortName: "ava-frxUSD+USDp (pool)", name: "USDp/frxUSD", inController: true, weight: "0", isKilled: true },
  { gauge: MAINNET, childGauge: MAINNET.toLowerCase(), name: "frxUSD/sUSDat", inController: true },
  { gauge: FXN, childGauge: FXN, name: "Not votable", inController: false },
];

afterEach(() => vi.restoreAllMocks());

describe("hub gauge metadata", () => {
  it("preserves child and root aliases, including zero-weight and killed gauges", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { gauges: GAUGES } });
    const gauges = await getGaugesInfos("curve");
    expect(gauges).toEqual([
      { name: "ava-frxUSD+USDp ", address: CHILD.toLowerCase() },
      { name: "ava-frxUSD+USDp ", address: ROOT.toLowerCase(), actualGauge: CHILD.toLowerCase() },
      { name: "frxUSD/sUSDat", address: MAINNET.toLowerCase() },
    ]);
    expect(get).toHaveBeenCalledExactlyOnceWith("https://hub.stakedao.org/v1/votemarket/curve/gauges");
  });

  it("keeps report amounts and resolves both claim-address forms to the child", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { gauges: GAUGES } });
    const gauges = await getGaugesInfos("curve");
    const bounties = [ROOT, CHILD].map((gauge, index) => ({
      bountyId: String(index), gauge, amount: "123456789012345678901", rewardToken: FXN,
    }));
    const result = addGaugeNamesToBounties(bounties, gauges);
    expect(result.map((bounty) => bounty.gauge.toLowerCase())).toEqual([CHILD.toLowerCase(), CHILD.toLowerCase()]);
    expect(result.map((bounty) => bounty.amount)).toEqual(bounties.map((bounty) => bounty.amount));
    expect(result.every((bounty) => bounty.gaugeName === "ava-frxUSD+USDp ")).toBe(true);
  });

  it("loads FXN names and canonical addresses from the hub", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200, data: { gauges: [{ gauge: FXN, name: "GHO+fxUSD" }] },
    });
    expect(await getGaugesInfos("fxn")).toEqual([{ name: "GHO+fxUSD", address: FXN.toLowerCase() }]);
    expect(get).toHaveBeenCalledExactlyOnceWith("https://hub.stakedao.org/v1/votemarket/fxn/gauges");
  });

  it.each(["curve", "fxn"])("%s preserves empty results without a stale fallback", async (protocol) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: { gauges: [] } });
    expect(await getGaugesInfos(protocol)).toEqual([]);
    get.mockResolvedValue({ status: 200, data: { message: "unavailable" } });
    expect(await getGaugesInfos(protocol)).toEqual([]);
    get.mockRejectedValue(new Error("503"));
    expect(await getGaugesInfos(protocol)).toEqual([]);
    expect(get.mock.calls.every(([url]) => String(url).startsWith("https://hub.stakedao.org/"))).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
  });
});
