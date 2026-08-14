/**
 * Unit tests for the address-level cross-merkle exclusivity invariant:
 * platform-split auto-clearing, every fail-closed path, the weekly
 * attribution loader, and the "*"-token waiver flow.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  WeeklyAttribution,
  checkAddressDeltaExclusivity,
  loadWeeklyAttribution,
} from "../../verify/invariants/addressExclusivity";
import { applyWaivers, loadWaivers } from "../../verify/invariants/waivers";
import { PairMap, Violation } from "../../verify/invariants/types";
import { VLCVX_POOLED_DELEGATES } from "../../utils/constants";

const ACCT = getAddress("0x1732951b80c737dbb8f367e83e530623bb612e54");
const OTHER_ACCT = getAddress("0x2222000000000000000000000000000000000022");
const SCRVUSD = getAddress("0x0655977FEb2f289A4aB78af67BAB0d17aAb84367");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");

function pairs(entries: [string, string, bigint][]): PairMap {
  const m: PairMap = new Map();
  for (const [account, token, amount] of entries) {
    if (!m.has(account)) m.set(account, new Map());
    m.get(account)!.set(token, amount);
  }
  return m;
}

const attribution = (
  overrides: Partial<WeeklyAttribution> = {}
): WeeklyAttribution => ({
  tuesdaySources: new Map([[ACCT.toLowerCase(), new Set(["fxn" as const])]]),
  thursdaySources: new Map([[ACCT.toLowerCase(), new Set(["curve" as const])]]),
  thursdayLoaded: true,
  votiumPaid: new Set(),
  ...overrides,
});

const run = (attr: WeeklyAttribution, votersEntries?: [string, string, bigint][]) => {
  const violations: Violation[] = [];
  const stats = checkAddressDeltaExclusivity(
    1,
    pairs(votersEntries ?? [[ACCT, USDC, 100n]]),
    pairs([[ACCT, SCRVUSD, 17n]]),
    attr,
    violations
  );
  return { violations, stats };
};

describe("checkAddressDeltaExclusivity", () => {
  it("clears the platform split (Tuesday fxn vs Thursday curve)", () => {
    const { violations, stats } = run(attribution());
    expect(violations).toEqual([]);
    expect(stats.overlaps).toBe(1);
    expect(stats.cleared).toEqual([
      { account: ACCT, tuesday: ["fxn"], thursday: ["curve"] },
    ]);
  });

  it("ignores accounts present in only one tree", () => {
    const { violations, stats } = run(
      attribution(),
      [[OTHER_ACCT, USDC, 100n]]
    );
    expect(violations).toEqual([]);
    expect(stats.overlaps).toBe(0);
  });

  it("flags a same-platform double payment as CRITICAL", () => {
    const { violations } = run(
      attribution({
        thursdaySources: new Map([
          [ACCT.toLowerCase(), new Set(["fxn" as const, "curve" as const])],
        ]),
      })
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("CRITICAL");
    expect(violations[0].detail).toMatch(/BOTH trees/);
    expect(violations[0].subject).toBe(`${ACCT} / *`);
    expect(violations[0].deficit).toBe(17n);
  });

  it("fails closed when the breakdown lacks per-platform sources", () => {
    const { violations } = run(attribution({ tuesdaySources: null }));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("CRITICAL");
    expect(violations[0].detail).toMatch(/attribution is unavailable/);
  });

  it("fails closed when the repartition inputs were unreadable", () => {
    const { violations } = run(attribution({ thursdayLoaded: false }));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("CRITICAL");
  });

  it("fails closed on a Tuesday delta with no recorded source", () => {
    const { violations } = run(attribution({ tuesdaySources: new Map() }));
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toMatch(/no recorded Tuesday platform source/);
  });

  it("demands manual review (HIGH) when a Votium leg is involved", () => {
    const { violations } = run(
      attribution({ votiumPaid: new Set([ACCT.toLowerCase()]) })
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("HIGH");
    expect(violations[0].detail).toMatch(/Votium leg/);
  });

  it("flags an unattributable voters delta as CRITICAL", () => {
    const { violations } = run(attribution({ thursdaySources: new Map() }));
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toMatch(/not attributable to any current-week source/);
  });
});

describe("EXCL_ADDR_DELTA_OVERLAP waivers", () => {
  const violationFor = (deficit: bigint): Violation => ({
    invariant: "EXCL_ADDR_DELTA_OVERLAP",
    severity: "HIGH",
    target: "delegators",
    chainId: 1,
    subject: `${ACCT} / *`,
    detail: "manual review",
    deficit,
  });

  const waiver = {
    invariant: "EXCL_ADDR_DELTA_OVERLAP" as const,
    chainId: 1,
    target: "delegators" as const,
    account: ACCT,
    token: "*",
    maxDeficit: "1000",
    reason: "reviewed platform-ambiguous Votium leg",
    addedBy: "test",
    addedAt: "2026-08-11",
  };

  it("waives with a '*' token up to the deficit cap", () => {
    const { active, waived } = applyWaivers([violationFor(999n)], [waiver]);
    expect(active).toEqual([]);
    expect(waived).toHaveLength(1);
  });

  it("keeps the violation active beyond the cap", () => {
    const { active, waived } = applyWaivers([violationFor(1001n)], [waiver]);
    expect(waived).toEqual([]);
    expect(active).toHaveLength(1);
  });

  it("loadWaivers accepts the '*' token without checksumming it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waivers-"));
    const file = path.join(dir, "waivers.json");
    fs.writeFileSync(file, JSON.stringify([waiver]));
    const loaded = loadWaivers(file);
    expect(loaded[0].token).toBe("*");
    expect(loaded[0].account).toBe(ACCT);
  });
});

describe("loadWeeklyAttribution", () => {
  const POOLED = VLCVX_POOLED_DELEGATES[0].toLowerCase();
  const T = "0xaaaa000000000000000000000000000000000001";
  const A = "0xa000000000000000000000000000000000000001";
  const B = "0xb000000000000000000000000000000000000002";
  const C = "0xc000000000000000000000000000000000000003";
  const D = "0xd000000000000000000000000000000000000004";
  const V1 = "0xe000000000000000000000000000000000000005";

  const delegationSummary = {
    totalTokens: { [T]: "200" },
    totalPerGroup: { [T]: { forwarders: "60", nonForwarders: "140" } },
    totalForwardersShare: "0.3",
    totalNonForwardersShare: "0.7",
    forwarders: { [A]: "0.6", [C]: "0.4" },
    nonForwarders: { [B]: "0.3", [D]: "0.7" },
    perDelegate: {
      [POOLED]: {
        poolTokens: { [T]: "100" },
        forwarders: { [A]: { [T]: "60" } },
        nonForwarders: { [B]: { [T]: "40" } },
      },
      "0xde1e000000000000000000000000000000000049": {
        poolTokens: { [T]: "100" },
        forwarders: { [C]: { [T]: "30" } },
        nonForwarders: { [D]: { [T]: "70" } },
      },
    },
  };

  const writeFixture = (breakdownPerWallet: unknown) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attr-"));
    const ts = 1785974400;
    const curveDir = path.join(root, String(ts), "vlCVX", "curve");
    fs.mkdirSync(curveDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, String(ts), "vlCVX", "delegators_split_breakdown.json"),
      JSON.stringify({ period: ts, perWallet: breakdownPerWallet })
    );
    fs.writeFileSync(
      path.join(curveDir, "repartition.json"),
      JSON.stringify({
        distribution: {
          [V1]: { tokens: { [T]: "5" } },
          [A]: { tokens: { [T]: "0" } }, // zero amounts are not a source
        },
      })
    );
    fs.writeFileSync(
      path.join(curveDir, "repartition_delegation.json"),
      JSON.stringify({ distribution: delegationSummary })
    );
    fs.writeFileSync(
      path.join(curveDir, "votium_forwarders_log.json"),
      JSON.stringify({ timestamp: ts, addressesPaid: [getAddress(V1)] })
    );
    return { root, ts };
  };

  it("builds Tuesday sources from the breakdown and Thursday sources from the routed files", () => {
    const { root, ts } = writeFixture({
      [getAddress(A)]: {
        valuePico: "1",
        total: "1",
        sources: { curve: "123", fxn: "0" },
      },
    });
    const attr = loadWeeklyAttribution(root, ts);

    expect(attr.tuesdaySources).not.toBeNull();
    expect(attr.tuesdaySources!.get(A)).toEqual(new Set(["curve"]));
    expect(attr.thursdayLoaded).toBe(true);
    // direct voter V1 + raw-routed B (pooled non-fwd) and C, D (non-pooled delegate)
    expect(attr.thursdaySources.get(V1)).toEqual(new Set(["curve"]));
    expect(attr.thursdaySources.get(B)).toEqual(new Set(["curve"]));
    expect(attr.thursdaySources.get(C)).toEqual(new Set(["curve"]));
    expect(attr.thursdaySources.get(D)).toEqual(new Set(["curve"]));
    // pooled forwarder A is Tuesday-routed, not a Thursday source
    expect(attr.thursdaySources.has(A)).toBe(false);
    expect(attr.votiumPaid).toEqual(new Set([V1]));
  });

  it("returns null Tuesday sources for a pre-upgrade breakdown (fail closed)", () => {
    const { root, ts } = writeFixture({
      [getAddress(A)]: { valuePico: "1", total: "1" }, // no `sources`
    });
    expect(loadWeeklyAttribution(root, ts).tuesdaySources).toBeNull();
  });

  it("marks Thursday unloaded when a repartition input is unreadable", () => {
    const { root, ts } = writeFixture({});
    fs.writeFileSync(
      path.join(root, String(ts), "vlCVX", "curve", "repartition_delegation.json"),
      "{not json"
    );
    expect(loadWeeklyAttribution(root, ts).thursdayLoaded).toBe(false);
  });

  it("fails closed when the week folder is entirely absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attr-empty-"));
    const attr = loadWeeklyAttribution(root, 1785974400);
    expect(attr.tuesdaySources).toBeNull();
    expect(attr.thursdayLoaded).toBe(false);
  });
});
