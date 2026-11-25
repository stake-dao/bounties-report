import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * GitHub substitutes `${{ ... }}` into a `run:` script before bash sees it, so
 * any expression there is a shell-injection surface: dispatch inputs are free
 * text unless declared `type: choice`, and a choice can be widened later. The
 * rule is therefore absolute — a `run:` scalar contains no expression at all;
 * values reach the script through `env:`.
 *
 * Line-based on purpose (the repo has no YAML parser dependency). It handles
 * block headers (`|`, `>`, `|2`, `>-`, with a trailing comment) and the key
 * indentation of a list item; YAML anchors and flow mappings inside a step are
 * not followed.
 */
export function runBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*(?:-\s+)?)(["']?run["']?):\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length;
    const raw = match[3].trim();
    if (!raw) continue; // a job named `run:`, whose value is a nested mapping
    const header = raw.split(/\s+#/)[0].trim();
    if (!/^[|>][0-9+-]*$/.test(header)) {
      blocks.push(raw);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        body.push(line);
        continue;
      }
      if (line.length - line.trimStart().length <= keyIndent) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return yamlFiles(full);
    return /\.ya?ml$/.test(name) ? [full] : [];
  });
}

const files = [
  ...yamlFiles(path.join(ROOT, ".github/workflows")),
  ...yamlFiles(path.join(ROOT, ".github/actions")),
];

describe("workflow shell safety", () => {
  it("finds workflows to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s keeps expressions out of run blocks", (file) => {
    const offending = runBlocks(readFileSync(file, "utf8")).filter((block) => block.includes("${{"));
    expect(offending, `${path.relative(ROOT, file)} interpolates an expression into a run block; pass it through env:`).toEqual([]);
  });
});
