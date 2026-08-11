/**
 * Pure comparison logic for the post-cutover delegator verification legs
 * (verifyDelegators.ts = artifact coherence, delegators-rpc.ts = on-chain
 * recomputation). No RPC in this module — callers fetch, this compares —
 * so every check is unit-testable.
 *
 * Model under verification (see 2_repartition/delegators.ts):
 * repartition_delegation.json carries a perDelegate section per delegate
 * voter: pool token totals plus the wei-exact attribution of that pool to
 * ITS OWN delegators, grouped by Votium-forwarding registry fact. The
 * top-level forwarders/nonForwarders maps are membership data (contributing
 * weight > 0, flattened across delegates). Chain files
 * (repartition_delegation_<chainId>.json) hold disjoint token columns of the
 * same summary.
 */

import fs from "fs";
import path from "path";
import {
  DelegationSummaryLike,
  getExactGroupAmounts,
  hasPerDelegateAttribution,
} from "../../utils/delegationExact";

export type TokenAmounts = Record<string, bigint>;
export type WalletTokenAmounts = Record<string, TokenAmounts>;

export interface MergedDelegateLeg {
  poolTokens: TokenAmounts;
  forwarders: WalletTokenAmounts;
  nonForwarders: WalletTokenAmounts;
}

const addAmounts = (
  target: TokenAmounts,
  tokens: Record<string, string>
): void => {
  for (const [token, amountStr] of Object.entries(tokens)) {
    const t = token.toLowerCase();
    target[t] = (target[t] ?? 0n) + BigInt(amountStr);
  }
};

/**
 * Reconstructs the full per-delegate attribution from the mainnet file plus
 * any chain-split files. Token columns are disjoint across files (each token
 * belongs to exactly one chain), so summing rebuilds the whole summary;
 * a token appearing in two files is a splitter bug and throws.
 * All keys (delegate, wallet, token) lowercase.
 */
export const mergeDelegationChainFiles = (
  summaries: DelegationSummaryLike[]
): Record<string, MergedDelegateLeg> => {
  const merged: Record<string, MergedDelegateLeg> = {};
  const tokenOwner: Record<string, number> = {};

  summaries.forEach((summary, fileIdx) => {
    for (const token of Object.keys(summary.totalTokens ?? {})) {
      const t = token.toLowerCase();
      if (tokenOwner[t] !== undefined && tokenOwner[t] !== fileIdx) {
        throw new Error(
          `mergeDelegationChainFiles: token ${t} appears in two chain files — ` +
            `chain splitting must keep token columns disjoint`
        );
      }
      tokenOwner[t] = fileIdx;
    }

    for (const [delegate, section] of Object.entries(
      summary.perDelegate ?? {}
    )) {
      const d = delegate.toLowerCase();
      const leg = (merged[d] ??= {
        poolTokens: {},
        forwarders: {},
        nonForwarders: {},
      });
      addAmounts(leg.poolTokens, section.poolTokens ?? {});
      for (const group of ["forwarders", "nonForwarders"] as const) {
        for (const [wallet, tokens] of Object.entries(section[group] ?? {})) {
          const w = wallet.toLowerCase();
          addAmounts((leg[group][w] ??= {}), tokens);
        }
      }
    }
  });

  return merged;
};

const fmtWallet = (w: string): string => `${w.slice(0, 10)}…`;

/**
 * Compares one delegate's file leg against the recomputed exact attribution
 * (splitAmountByWeights over the pool with the on-chain contributing weights)
 * and the Votium-forwarding registry facts at the proposal-end block.
 * Wei-exact both directions; wallets must sit in the group their registry
 * fact dictates. Returns human-readable issues, empty = exact match.
 */
export const compareDelegateAttribution = (input: {
  delegate: string;
  fileLeg: MergedDelegateLeg;
  recomputed: WalletTokenAmounts;
  forwarderFlags: Record<string, boolean>;
}): string[] => {
  const { delegate, fileLeg, recomputed, forwarderFlags } = input;
  const issues: string[] = [];
  const d = fmtWallet(delegate);

  const fileWallets: Record<string, { group: "forwarders" | "nonForwarders"; tokens: TokenAmounts }> =
    {};
  for (const group of ["forwarders", "nonForwarders"] as const) {
    for (const [wallet, tokens] of Object.entries(fileLeg[group])) {
      if (fileWallets[wallet]) {
        issues.push(
          `delegate ${d}: wallet ${fmtWallet(wallet)} present in BOTH groups`
        );
        continue;
      }
      fileWallets[wallet] = { group, tokens };
    }
  }

  for (const [wallet, tokens] of Object.entries(recomputed)) {
    const inFile = fileWallets[wallet];
    if (!inFile) {
      issues.push(
        `delegate ${d}: wallet ${fmtWallet(wallet)} earned on-chain but is MISSING from the file`
      );
      continue;
    }
    const allTokens = new Set([
      ...Object.keys(tokens),
      ...Object.keys(inFile.tokens),
    ]);
    for (const token of allTokens) {
      const expected = tokens[token] ?? 0n;
      const actual = inFile.tokens[token] ?? 0n;
      if (expected !== actual) {
        issues.push(
          `delegate ${d}: wallet ${fmtWallet(wallet)} token ${fmtWallet(token)} — ` +
            `file ${actual} != recomputed ${expected}`
        );
      }
    }
    const expectedGroup = forwarderFlags[wallet]
      ? "forwarders"
      : "nonForwarders";
    if (inFile.group !== expectedGroup) {
      issues.push(
        `delegate ${d}: wallet ${fmtWallet(wallet)} filed under ${inFile.group} ` +
          `but the Votium registry says ${expectedGroup}`
      );
    }
  }

  for (const wallet of Object.keys(fileWallets)) {
    if (!recomputed[wallet]) {
      issues.push(
        `delegate ${d}: wallet ${fmtWallet(wallet)} in file but earned NOTHING in the recomputation`
      );
    }
  }

  return issues;
};

/**
 * Delegate-set findings. A delegate in the file that is not an on-chain
 * delegate voter means the file invents a delegation. The reverse — an
 * on-chain delegate voter absent from the file — is only a problem when it
 * EARNED rewards (present in repartition.json) with delegated weight applied
 * (adjustedWeight > 0): its pool then had to be split to its delegators
 * (the epoch-230 0x52ea… incident class). A delegate voter that earned
 * nothing, or voted purely with own weight, is legitimately absent.
 */
export const delegateSetIssues = (input: {
  fileDelegates: string[];
  delegateVoters: string[];
  repartitionVoters: Set<string>;
  adjustedWeights: Record<string, bigint>;
}): string[] => {
  const issues: string[] = [];
  const voters = new Set(input.delegateVoters.map((a) => a.toLowerCase()));
  const inFile = new Set(input.fileDelegates.map((a) => a.toLowerCase()));

  for (const d of inFile) {
    if (!voters.has(d)) {
      issues.push(
        `delegate ${fmtWallet(d)} is in the file but is NOT an on-chain delegate voter this round`
      );
    }
  }
  for (const d of voters) {
    if (inFile.has(d)) continue;
    if (!input.repartitionVoters.has(d)) continue;
    if ((input.adjustedWeights[d] ?? 0n) > 0n) {
      issues.push(
        `delegate voter ${fmtWallet(d)} earned rewards with delegated weight ` +
          `(adjustedWeight > 0) but was paid as a plain voter — its pool was never split`
      );
    }
  }
  return issues;
};

export interface ArtifactFile {
  name: string;
  summary: DelegationSummaryLike & {
    forwarders?: Record<string, string>;
    nonForwarders?: Record<string, string>;
  };
  proposalId?: string;
  snapshotBlock?: number;
}

/**
 * Loads a protocol's delegation artifact set: repartition_delegation.json
 * (mainnet, first) plus every repartition_delegation_<chainId>.json.
 * Returns [] when the main file is absent.
 */
export const loadDelegationArtifacts = (dirAbs: string): ArtifactFile[] => {
  const mainPath = path.join(dirAbs, "repartition_delegation.json");
  if (!fs.existsSync(mainPath)) return [];

  const chainFiles = fs
    .readdirSync(dirAbs)
    .filter((f) => /^repartition_delegation_\d+\.json$/.test(f))
    .sort();

  return ["repartition_delegation.json", ...chainFiles].map((name) => {
    const raw = JSON.parse(fs.readFileSync(path.join(dirAbs, name), "utf-8"));
    return {
      name,
      summary: raw.distribution ?? {},
      proposalId:
        raw.proposalId !== undefined ? String(raw.proposalId) : undefined,
      snapshotBlock:
        raw.snapshotBlock !== undefined ? Number(raw.snapshotBlock) : undefined,
    };
  });
};

/**
 * Union of voter keys across repartition.json and every
 * repartition_<chainId>.json (lowercase). Empty set when none exists.
 */
export const loadRepartitionVoterKeys = (dirAbs: string): Set<string> => {
  const voters = new Set<string>();
  if (!fs.existsSync(dirAbs)) return voters;
  for (const name of fs.readdirSync(dirAbs)) {
    if (!/^repartition(_\d+)?\.json$/.test(name)) continue;
    const raw = JSON.parse(fs.readFileSync(path.join(dirAbs, name), "utf-8"));
    for (const voter of Object.keys(raw.distribution ?? {})) {
      voters.add(voter.toLowerCase());
    }
  }
  return voters;
};

/**
 * File-only coherence of one protocol's delegation summary across its chain
 * files: per-delegate pool conservation and routed group totals (delegated to
 * the delegationExact accessors — the exact code paths the payers run),
 * totalTokens == Σ per-delegate pools per file, identical top-level
 * membership sets on every chain file, and top-level sets matching the union
 * of the per-delegate sections.
 *
 * `warnings` carries the one legitimate asymmetry: a wallet with contributing
 * weight but a split that rounded to zero everywhere sits in the top-level
 * sets with no per-delegate entry.
 */
export const artifactCoherenceIssues = (
  files: ArtifactFile[]
): { issues: string[]; warnings: string[] } => {
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const { name, summary } of files) {
    if (!hasPerDelegateAttribution(summary)) {
      issues.push(`${name}: no perDelegate section (pre-cutover artifact?)`);
      continue;
    }
    for (const group of ["forwarders", "nonForwarders"] as const) {
      try {
        getExactGroupAmounts(summary, group);
      } catch (error) {
        issues.push(`${name}: ${(error as Error).message}`);
      }
    }

    const poolSums: TokenAmounts = {};
    for (const section of Object.values(summary.perDelegate ?? {})) {
      addAmounts(poolSums, section.poolTokens ?? {});
    }
    const declared: TokenAmounts = {};
    for (const [token, amountStr] of Object.entries(summary.totalTokens ?? {})) {
      declared[token.toLowerCase()] = BigInt(amountStr);
    }
    const tokens = new Set([...Object.keys(poolSums), ...Object.keys(declared)]);
    for (const token of tokens) {
      if ((poolSums[token] ?? 0n) !== (declared[token] ?? 0n)) {
        issues.push(
          `${name}: token ${fmtWallet(token)} — totalTokens ${declared[token] ?? 0n} ` +
            `!= sum of perDelegate pools ${poolSums[token] ?? 0n}`
        );
      }
    }
  }

  const scalarSet = (
    summary: ArtifactFile["summary"],
    group: "forwarders" | "nonForwarders"
  ): Set<string> =>
    new Set(Object.keys(summary[group] ?? {}).map((a) => a.toLowerCase()));

  if (files.length > 0) {
    const [first, ...rest] = files;
    for (const group of ["forwarders", "nonForwarders"] as const) {
      const reference = scalarSet(first.summary, group);
      for (const other of rest) {
        const otherSet = scalarSet(other.summary, group);
        if (
          reference.size !== otherSet.size ||
          [...reference].some((a) => !otherSet.has(a))
        ) {
          issues.push(
            `top-level ${group} membership differs between ${first.name} and ${other.name}`
          );
        }
      }
    }

    const scalarFwd = scalarSet(first.summary, "forwarders");
    const scalarNonFwd = scalarSet(first.summary, "nonForwarders");
    for (const wallet of scalarFwd) {
      if (scalarNonFwd.has(wallet)) {
        issues.push(
          `wallet ${fmtWallet(wallet)} present in BOTH top-level membership sets`
        );
      }
    }

    const unionFwd = new Set<string>();
    const unionNonFwd = new Set<string>();
    for (const { summary } of files) {
      for (const section of Object.values(summary.perDelegate ?? {})) {
        for (const wallet of Object.keys(section.forwarders ?? {})) {
          unionFwd.add(wallet.toLowerCase());
        }
        for (const wallet of Object.keys(section.nonForwarders ?? {})) {
          unionNonFwd.add(wallet.toLowerCase());
        }
      }
    }
    for (const [union, scalar, group] of [
      [unionFwd, scalarFwd, "forwarders"],
      [unionNonFwd, scalarNonFwd, "nonForwarders"],
    ] as const) {
      for (const wallet of union) {
        if (!scalar.has(wallet)) {
          issues.push(
            `wallet ${fmtWallet(wallet)} has ${group} amounts in perDelegate ` +
              `but is missing from the top-level ${group} set`
          );
        }
      }
      for (const wallet of scalar) {
        if (!union.has(wallet)) {
          warnings.push(
            `wallet ${fmtWallet(wallet)} in top-level ${group} but no perDelegate ` +
              `amounts (contributing weight rounded to zero everywhere?)`
          );
        }
      }
    }
  }

  return { issues, warnings };
};
