/* Simple debug logger for report generation. Enable by setting DEBUG_REPORTS=1 */

const DEBUG_ENABLED = (() => {
  const v = process.env.DEBUG_REPORTS || process.env.DEBUG || "";
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
})();

function ts() {
  const d = new Date();
  return d.toISOString();
}

export function debug(...args: any[]) {
  if (!DEBUG_ENABLED) return;
  try {
    // Avoid circular structures breaking JSON.stringify
    const safeArgs = args.map((a) => (typeof a === "object" ? safeStringify(a) : a));
    // eslint-disable-next-line no-console
    console.log(`[DEBUG ${ts()}]`, ...safeArgs);
  } catch {
    // eslint-disable-next-line no-console
    console.log(`[DEBUG ${ts()}]`, ...args);
  }
}

export function info(...args: any[]) {
  // eslint-disable-next-line no-console
  console.log(`[INFO  ${ts()}]`, ...args);
}

export function warn(...args: any[]) {
  // eslint-disable-next-line no-console
  console.warn(`[WARN  ${ts()}]`, ...args);
}

export function error(...args: any[]) {
  // eslint-disable-next-line no-console
  console.error(`[ERROR ${ts()}]`, ...args);
}

export function sampleArray<T>(arr: T[] | undefined, n = 3): T[] {
  if (!arr || arr.length === 0) return [];
  return arr.slice(0, Math.max(0, Math.min(n, arr.length)));
}

export function safeStringify(obj: any, maxLen = 10000): string {
  try {
    const cache = new Set<any>();
    const str = JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (cache.has(value)) return "[Circular]";
          cache.add(value);
        }
        if (typeof value === "bigint") return value.toString();
        return value;
      },
      2
    );
    if (str.length > maxLen) return str.slice(0, maxLen) + "...<truncated>";
    return str;
  } catch (e) {
    return String(obj);
  }
}

export const isDebugEnabled = () => DEBUG_ENABLED;

