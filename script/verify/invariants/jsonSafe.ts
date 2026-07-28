/**
 * Duplicate-key-aware JSON parsing.
 *
 * `JSON.parse` silently keeps the LAST occurrence of a duplicated object key,
 * which would let a duplicated (account, token) entry shadow another one
 * before any structural check can see it. This walks the raw text with a
 * minimal tokenizer and records every object path where a key repeats.
 */

export interface DuplicateKey {
  /** JSON-pointer-ish path of the object owning the duplicate key. */
  path: string;
  key: string;
}

export function findDuplicateKeys(text: string): DuplicateKey[] {
  const duplicates: DuplicateKey[] = [];
  // Stack of containers: for objects we track seen keys, arrays push null.
  const stack: (Set<string> | null)[] = [];
  const pathStack: string[] = [];
  let i = 0;
  const n = text.length;
  let pendingKey: string | null = null;

  const readString = (): string => {
    // text[i] === '"' on entry; returns the DECODED string so that escape
    // spellings (e.g. "\\u0061" vs "a") cannot evade duplicate detection.
    const start = ++i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x5c /* \ */) i += 2;
      else if (c === 0x22 /* " */) break;
      else i++;
    }
    const raw = text.slice(start, i);
    i++; // consume closing quote
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw; // malformed escape — JSON.parse of the doc will throw anyway
    }
  };

  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const s = readString();
      // A string is a key iff the next non-space char is ':' and the
      // enclosing container is an object.
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      const container = stack[stack.length - 1];
      if (text[j] === ":" && container instanceof Set) {
        if (container.has(s)) {
          duplicates.push({ path: "/" + pathStack.join("/"), key: s });
        }
        container.add(s);
        pendingKey = s;
      }
      continue;
    }
    if (ch === "{") {
      stack.push(new Set());
      pathStack.push(pendingKey ?? String(pathStack.length));
      pendingKey = null;
    } else if (ch === "[") {
      stack.push(null);
      pathStack.push(pendingKey ?? "[]");
      pendingKey = null;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      pathStack.pop();
    }
    i++;
  }
  return duplicates;
}

/** Parse JSON after asserting there are no duplicate object keys. */
export function parseJsonRejectingDuplicates<T>(
  text: string
): { value: T; duplicates: DuplicateKey[] } {
  const duplicates = findDuplicateKeys(text);
  return { value: JSON.parse(text) as T, duplicates };
}
