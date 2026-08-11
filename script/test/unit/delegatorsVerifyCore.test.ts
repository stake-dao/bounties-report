/**
 * Unit tests for the pure comparison core of the post-cutover delegator
 * verification legs: chain-file merging, wei-exact attribution comparison,
 * delegate-set findings, and artifact coherence.
 */
import { describe, expect, it } from "vitest";
import { VLCVX_POOLED_DELEGATES } from "../../utils/constants";
import {
  artifactCoherenceIssues,
  compareDelegateAttribution,
  delegateSetIssues,
  mergeDelegationChainFiles,
} from "../../vlCVX/verify/delegatorsVerifyCore";

const POOLED = VLCVX_POOLED_DELEGATES[0].toLowerCase();
const OTHER = "0xde1e000000000000000000000000000000000049";
const TOK1 = "0xaaaa000000000000000000000000000000000001";
const TOK2 = "0xbbbb000000000000000000000000000000000002";
const A = "0xa000000000000000000000000000000000000001";
const B = "0xb000000000000000000000000000000000000002";
const C = "0xc000000000000000000000000000000000000003";
const D = "0xd000000000000000000000000000000000000004";

/** Coherent one-token fixture: pooled delegate P (A fwd / B non-fwd) and
 *  third-party delegate U (C fwd / D non-fwd), 100 wei pool each. */
const mkSummary = () => ({
  totalTokens: { [TOK1]: "200" },
  totalPerGroup: { [TOK1]: { forwarders: "60", nonForwarders: "140" } },
  totalForwardersShare: "0.45",
  totalNonForwardersShare: "0.55",
  forwarders: { [A]: "0.6", [C]: "0.4" },
  nonForwarders: { [B]: "0.3", [D]: "0.7" },
  perDelegate: {
    [POOLED]: {
      poolTokens: { [TOK1]: "100" },
      forwarders: { [A]: { [TOK1]: "60" } },
      nonForwarders: { [B]: { [TOK1]: "40" } },
    },
    [OTHER]: {
      poolTokens: { [TOK1]: "100" },
      forwarders: { [C]: { [TOK1]: "30" } },
      nonForwarders: { [D]: { [TOK1]: "70" } },
    },
  },
});

describe("mergeDelegationChainFiles", () => {
  it("sums disjoint token columns across chain files, lowercased", () => {
    const base = {
      totalTokens: { [TOK2.toUpperCase().replace("0X", "0x")]: "7" },
      totalPerGroup: { [TOK2]: { forwarders: "7", nonForwarders: "0" } },
      perDelegate: {
        [POOLED.toUpperCase().replace("0X", "0x")]: {
          poolTokens: { [TOK2]: "7" },
          forwarders: { [A.toUpperCase().replace("0X", "0x")]: { [TOK2]: "7" } },
          nonForwarders: {},
        },
      },
    };
    const merged = mergeDelegationChainFiles([mkSummary(), base]);

    expect(Object.keys(merged).sort()).toEqual([OTHER, POOLED].sort());
    expect(merged[POOLED].poolTokens).toEqual({ [TOK1]: 100n, [TOK2]: 7n });
    expect(merged[POOLED].forwarders[A]).toEqual({ [TOK1]: 60n, [TOK2]: 7n });
    expect(merged[OTHER].nonForwarders[D]).toEqual({ [TOK1]: 70n });
  });

  it("throws when a token column appears in two files", () => {
    expect(() =>
      mergeDelegationChainFiles([mkSummary(), mkSummary()])
    ).toThrow(/two chain files/);
  });
});

describe("compareDelegateAttribution", () => {
  const fileLeg = () => mergeDelegationChainFiles([mkSummary()])[POOLED];
  const recomputed = () => ({ [A]: { [TOK1]: 60n }, [B]: { [TOK1]: 40n } });
  const flags = () => ({ [A]: true, [B]: false });

  it("passes on an exact match", () => {
    expect(
      compareDelegateAttribution({
        delegate: POOLED,
        fileLeg: fileLeg(),
        recomputed: recomputed(),
        forwarderFlags: flags(),
      })
    ).toEqual([]);
  });

  it("flags a 1-wei amount drift", () => {
    const r = recomputed();
    r[A][TOK1] = 61n;
    const issues = compareDelegateAttribution({
      delegate: POOLED,
      fileLeg: fileLeg(),
      recomputed: r,
      forwarderFlags: flags(),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/file 60 != recomputed 61/);
  });

  it("flags a wallet missing from the file and an extra file wallet", () => {
    const r = recomputed();
    delete r[B];
    r[C] = { [TOK1]: 40n };
    const issues = compareDelegateAttribution({
      delegate: POOLED,
      fileLeg: fileLeg(),
      recomputed: r,
      forwarderFlags: { ...flags(), [C]: false },
    });
    expect(issues.some((i) => /MISSING from the file/.test(i))).toBe(true);
    expect(issues.some((i) => /earned NOTHING/.test(i))).toBe(true);
  });

  it("flags a wallet filed under the wrong forwarding group", () => {
    const issues = compareDelegateAttribution({
      delegate: POOLED,
      fileLeg: fileLeg(),
      recomputed: recomputed(),
      forwarderFlags: { [A]: true, [B]: true },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/registry says forwarders/);
  });
});

describe("delegateSetIssues", () => {
  it("flags a file delegate that is not an on-chain delegate voter", () => {
    const issues = delegateSetIssues({
      fileDelegates: [POOLED, OTHER],
      delegateVoters: [POOLED],
      repartitionVoters: new Set(),
      adjustedWeights: {},
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/NOT an on-chain delegate voter/);
  });

  it("flags a delegate voter paid as a plain voter (0x52ea class)", () => {
    const issues = delegateSetIssues({
      fileDelegates: [POOLED],
      delegateVoters: [POOLED, OTHER],
      repartitionVoters: new Set([OTHER]),
      adjustedWeights: { [OTHER]: 1n },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/paid as a plain voter/);
  });

  it("accepts absent delegate voters that earned nothing or used no delegated weight", () => {
    expect(
      delegateSetIssues({
        fileDelegates: [POOLED],
        delegateVoters: [POOLED, OTHER],
        repartitionVoters: new Set(),
        adjustedWeights: {},
      })
    ).toEqual([]);
    expect(
      delegateSetIssues({
        fileDelegates: [POOLED],
        delegateVoters: [POOLED, OTHER],
        repartitionVoters: new Set([OTHER]),
        adjustedWeights: { [OTHER]: 0n },
      })
    ).toEqual([]);
  });
});

describe("artifactCoherenceIssues", () => {
  it("passes a coherent file", () => {
    const { issues, warnings } = artifactCoherenceIssues([
      { name: "mainnet", summary: mkSummary() },
    ]);
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("flags a routed totalPerGroup drift via the exact accessors", () => {
    const summary = mkSummary();
    summary.totalPerGroup[TOK1].forwarders = "61";
    const { issues } = artifactCoherenceIssues([
      { name: "mainnet", summary },
    ]);
    expect(issues.some((i) => /totalPerGroup|per-wallet sum/.test(i))).toBe(true);
  });

  it("flags totalTokens not matching the sum of per-delegate pools", () => {
    const summary = mkSummary();
    summary.totalTokens[TOK1] = "201";
    const { issues } = artifactCoherenceIssues([
      { name: "mainnet", summary },
    ]);
    expect(issues.some((i) => /totalTokens 201/.test(i))).toBe(true);
  });

  it("flags a per-delegate wallet missing from the top-level sets, and warns on the reverse", () => {
    const summary = mkSummary();
    delete (summary.forwarders as Record<string, string>)[C];
    (summary.nonForwarders as Record<string, string>)[
      "0xe000000000000000000000000000000000000005"
    ] = "0.0";
    const { issues, warnings } = artifactCoherenceIssues([
      { name: "mainnet", summary },
    ]);
    expect(issues.some((i) => /missing from the top-level forwarders/.test(i))).toBe(
      true
    );
    expect(warnings.some((w) => /no perDelegate amounts/.test(w))).toBe(true);
  });

  it("flags membership differing between chain files and a pre-cutover file", () => {
    const base = mkSummary();
    delete (base.forwarders as Record<string, string>)[A];
    const { issues } = artifactCoherenceIssues([
      { name: "mainnet", summary: mkSummary() },
      { name: "base", summary: base },
    ]);
    expect(
      issues.some((i) => /forwarders membership differs between mainnet and base/.test(i))
    ).toBe(true);

    const { issues: preCutover } = artifactCoherenceIssues([
      { name: "mainnet", summary: { totalTokens: {}, forwarders: {}, nonForwarders: {} } },
    ]);
    expect(preCutover.some((i) => /no perDelegate section/.test(i))).toBe(true);
  });
});
