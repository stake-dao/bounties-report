import { WEEK } from "../../utils/constants";

export const VALID_TARGETS = ["voters", "delegators", "both"] as const;
export type Target = (typeof VALID_TARGETS)[number];

export function parseTarget(raw: string | undefined): Target {
  const target = raw ?? "both";
  if (!VALID_TARGETS.includes(target as Target)) {
    // Fail closed: an unrecognized target must never yield an empty, passing run.
    throw new Error(
      `invalid --target "${target}" (expected ${VALID_TARGETS.join("|")})`
    );
  }
  return target as Target;
}

export function parseCliArgs(argv: string[]): {
  timestamp: number;
  target: Target;
  jsonOut: string | undefined;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const now = Math.floor(Date.now() / 1000);
  const timestamp = parseInt(
    get("--timestamp") ?? String(Math.floor(now / WEEK) * WEEK),
    10
  );
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new Error("invalid --timestamp");
  }
  return { timestamp, target: parseTarget(get("--target")), jsonOut: get("--json") };
}
