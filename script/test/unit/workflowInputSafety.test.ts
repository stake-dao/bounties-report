import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * A `${{ ... }}` expression from a dispatch or PR context inside a `run:` block
 * is shell injection: GitHub substitutes it into the script before bash sees it.
 * Dispatch inputs are free text unless declared `type: choice`, and a `choice`
 * can be widened later, so the rule is absolute: pass them through `env:`.
 */
const UNSAFE = /\$\{\{\s*(?:inputs\.|github\.event\.inputs\.|github\.head_ref|github\.event\.pull_request\.)/;

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return yamlFiles(full);
    return /\.ya?ml$/.test(name) ? [full] : [];
  });
}

/** Every `run:` scalar body in a workflow or composite action. */
export function runBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    // A job may be named `run:` (the key then holds a nested mapping, so the
    // value is empty). Only a non-empty value is a shell step.
    if (!inline) continue;
    if (!/^[|>][+-]?$/.test(inline)) {
      blocks.push(inline);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) {
        body.push(line);
        continue;
      }
      if (line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

const files = [
  ...yamlFiles(path.join(ROOT, ".github/workflows")),
  ...yamlFiles(path.join(ROOT, ".github/actions")),
];

describe("workflow shell safety", () => {
  it("finds workflows to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s keeps dispatch inputs out of run blocks", (file) => {
    const offending = runBlocks(readFileSync(file, "utf8")).filter((block) => UNSAFE.test(block));
    expect(offending, `${path.relative(ROOT, file)} interpolates a dispatch or PR value into a run block`).toEqual([]);
  });
});
