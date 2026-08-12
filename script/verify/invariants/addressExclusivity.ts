/**
 * Address-level cross-merkle delta exclusivity (mainnet).
 *
 * EXCL_DELTA_OVERLAP compares per (account, token) — but the realistic
 * double-pay shape can NEVER collide on a token: the Tuesday delegators tree
 * pays sCRVUSD while the Thursday voters tree pays raw reward tokens, so a
 * forwarder wrongly present in both trees slips through the per-token check
 * by construction. This module closes that hole at the ADDRESS level while
 * auto-clearing the one legitimate shape: the PLATFORM SPLIT — a wallet that
 * is a pooled delegator-forwarder on one gauge platform (Tuesday sCRVUSD)
 * and a direct voter / raw-routed wallet on the other (Thursday raw tokens),
 * e.g. 0x1732951b… in epoch 230.
 *
 * Decidability is entirely offline, from the week's own artifacts:
 *   - Tuesday platforms: `sources` per wallet in delegators_split_breakdown
 *     (per-platform entitlement value recorded by createDelegatorsMerkle);
 *   - Thursday platforms: address-keyed repartition.json (direct voters) and
 *     the raw "nonForwarders" route of repartition_delegation.json, per
 *     platform (both feed the per-platform merkle that merges into
 *     vlcvx_merkle.json);
 *   - individually attributed Votium legs (votium_forwarders_log addressesPaid)
 *     carry no platform in the log — an overlap involving one demands manual
 *     review (HIGH) rather than silent clearing.
 *
 * Every unattributable state fails closed: missing breakdown provenance
 * (pre-upgrade artifact), unreadable repartition inputs, or a delta with no
 * recorded source is a CRITICAL violation, never a pass.
 */

import fs from "fs";
import path from "path";
import { getExactGroupAmounts } from "../../utils/delegationExact";
import { PairMap, Violation } from "./types";

export type PlatformKey = "curve" | "fxn";
const PLATFORMS: PlatformKey[] = ["curve", "fxn"];

export interface WeeklyAttribution {
  /**
   * lowercase wallet -> platforms whose pooled-forwarder entitlement funded
   * its Tuesday payment. `null` when the breakdown is absent or predates the
   * per-platform `sources` field — callers must then fail closed.
   */
  tuesdaySources: Map<string, Set<PlatformKey>> | null;
  /** lowercase wallet -> platforms that paid it in the Thursday tree this week. */
  thursdaySources: Map<string, Set<PlatformKey>>;
  /** false when the repartition inputs were absent or unreadable — fail closed. */
  thursdayLoaded: boolean;
  /** Wallets paid an individually attributed Votium leg (platform not recorded). */
  votiumPaid: Set<string>;
}

const addSource = (
  map: Map<string, Set<PlatformKey>>,
  wallet: string,
  platform: PlatformKey
): void => {
  const key = wallet.toLowerCase();
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(platform);
};

/**
 * Loads the week's attribution inputs. Never throws: every failure mode is
 * encoded in the returned flags so the check can fail closed with a precise
 * violation instead of crashing the gate.
 */
export const loadWeeklyAttribution = (
  reportsRoot: string,
  timestamp: number
): WeeklyAttribution => {
  const base = path.join(reportsRoot, String(timestamp), "vlCVX");

  // --- Tuesday side: split breakdown with per-platform sources ---
  let tuesdaySources: Map<string, Set<PlatformKey>> | null = null;
  try {
    const bdPath = path.join(base, "delegators_split_breakdown.json");
    if (fs.existsSync(bdPath)) {
      const breakdown = JSON.parse(fs.readFileSync(bdPath, "utf8"));
      const perWallet: Record<string, { sources?: Record<string, string> }> =
        breakdown.perWallet ?? {};
      const entries = Object.entries(perWallet);
      if (entries.every(([, v]) => v && typeof v.sources === "object")) {
        const map = new Map<string, Set<PlatformKey>>();
        for (const [wallet, v] of entries) {
          for (const platform of PLATFORMS) {
            if (BigInt(v.sources?.[platform] ?? "0") > 0n) {
              addSource(map, wallet, platform);
            }
          }
        }
        tuesdaySources = map;
      }
      // entries lacking `sources` (pre-upgrade artifact) leave null → fail closed
    }
  } catch {
    tuesdaySources = null;
  }

  // --- Thursday side: per-platform repartition + raw-routed delegation ---
  const thursdaySources = new Map<string, Set<PlatformKey>>();
  const votiumPaid = new Set<string>();
  let sawAnyPlatform = false;
  let loadError = false;

  for (const platform of PLATFORMS) {
    const dir = path.join(base, platform);
    if (!fs.existsSync(dir)) continue;
    sawAnyPlatform = true;
    try {
      const repPath = path.join(dir, "repartition.json");
      if (fs.existsSync(repPath)) {
        const rep = JSON.parse(fs.readFileSync(repPath, "utf8"));
        for (const [wallet, entry] of Object.entries<any>(
          rep.distribution ?? {}
        )) {
          const tokens: Record<string, string> = entry?.tokens ?? {};
          if (Object.values(tokens).some((a) => BigInt(a) > 0n)) {
            addSource(thursdaySources, wallet, platform);
          }
        }
      }
      const delegPath = path.join(dir, "repartition_delegation.json");
      if (fs.existsSync(delegPath)) {
        const summary = JSON.parse(fs.readFileSync(delegPath, "utf8"))
          .distribution;
        // The exact accessor re-validates conservation and applies the
        // pooled-delegate routing — the same code path the Thursday payer runs.
        const rawRouted = getExactGroupAmounts(summary, "nonForwarders");
        for (const [wallet, tokens] of Object.entries(rawRouted)) {
          if (Object.values(tokens).some((a) => a > 0n)) {
            addSource(thursdaySources, wallet, platform);
          }
        }
      }
    } catch {
      loadError = true;
    }
  }

  try {
    const logPath = path.join(base, "curve", "votium_forwarders_log.json");
    if (fs.existsSync(logPath)) {
      const log = JSON.parse(fs.readFileSync(logPath, "utf8"));
      for (const wallet of log.addressesPaid ?? []) {
        votiumPaid.add(String(wallet).toLowerCase());
      }
    }
  } catch {
    loadError = true;
  }

  return {
    tuesdaySources,
    thursdaySources,
    thursdayLoaded: sawAnyPlatform && !loadError,
    votiumPaid,
  };
};

export interface AddressExclusivityStats {
  /** Accounts with a positive delta in BOTH trees this epoch. */
  overlaps: number;
  /** Overlaps proven to be legitimate platform splits. */
  cleared: {
    account: string;
    tuesday: PlatformKey[];
    thursday: PlatformKey[];
  }[];
}

/**
 * Flags every account receiving value in BOTH mainnet trees this epoch
 * unless the week's artifacts prove a platform split. The violation's
 * deficit is the account's full Tuesday delta (the suspect side), so a
 * waiver stays quantitatively capped.
 */
export function checkAddressDeltaExclusivity(
  chainId: number,
  votersDeltas: PairMap,
  delegatorsDeltas: PairMap,
  attribution: WeeklyAttribution,
  violations: Violation[]
): AddressExclusivityStats {
  const stats: AddressExclusivityStats = { overlaps: 0, cleared: [] };

  for (const [account, delegatorTokens] of delegatorsDeltas) {
    if (!votersDeltas.has(account)) continue;
    stats.overlaps++;
    const acc = account.toLowerCase();
    const deficit = [...delegatorTokens.values()].reduce((a, b) => a + b, 0n);
    const flag = (detail: string, severity: "CRITICAL" | "HIGH") =>
      violations.push({
        invariant: "EXCL_ADDR_DELTA_OVERLAP",
        severity,
        target: "delegators",
        chainId,
        subject: `${account} / *`,
        detail,
        deficit,
      });

    if (attribution.tuesdaySources === null || !attribution.thursdayLoaded) {
      flag(
        `address receives value in BOTH merkles this epoch and the platform ` +
          `attribution is unavailable (missing/pre-upgrade breakdown or ` +
          `unreadable repartition inputs) — cannot prove a platform split`,
        "CRITICAL"
      );
      continue;
    }

    const tuesday = attribution.tuesdaySources.get(acc);
    if (!tuesday || tuesday.size === 0) {
      flag(
        `delegators-merkle delta with no recorded Tuesday platform source in ` +
          `the split breakdown — payment has no provenance`,
        "CRITICAL"
      );
      continue;
    }

    const thursday = attribution.thursdaySources.get(acc) ?? new Set();
    const shared = [...tuesday].filter((p) => thursday.has(p));
    if (shared.length > 0) {
      flag(
        `platform(s) [${shared.join(", ")}] paid this wallet in BOTH trees ` +
          `this epoch (pooled Tuesday entitlement AND Thursday repartition/raw ` +
          `route) — double payment of the same reward source`,
        "CRITICAL"
      );
      continue;
    }

    if (attribution.votiumPaid.has(acc)) {
      flag(
        `wallet holds an individually attributed Votium leg (platform not ` +
          `recorded in votium_forwarders_log) alongside a Tuesday payment — ` +
          `platform split cannot be proven, manual review required`,
        "HIGH"
      );
      continue;
    }

    if (thursday.size === 0) {
      flag(
        `voters-merkle delta not attributable to any current-week source ` +
          `(repartition, raw-routed delegation, or Votium leg) — unexplained ` +
          `payment alongside a Tuesday payment`,
        "CRITICAL"
      );
      continue;
    }

    stats.cleared.push({
      account,
      tuesday: [...tuesday].sort(),
      thursday: [...thursday].sort(),
    });
  }

  return stats;
}
