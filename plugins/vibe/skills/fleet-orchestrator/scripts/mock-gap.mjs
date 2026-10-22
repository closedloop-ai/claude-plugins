#!/usr/bin/env node
// Finds module mocks that leave out an export the code under test reads. Each
// `vi.mock("<module>", ...)` block is judged on its own: a scan that passed a
// whole file because some block spread `importOriginal()` once missed a hook
// mock in the same file that lacked a newly read field, and main broke.
//
// Usage: mock-gap.mjs --module <specifier> --exports <name>[,<name>...] <test file>...
//
// A block passes when it spreads the real module (`...(await importOriginal())`,
// or a spread of a variable assigned from importOriginal inside the block) or
// names every export. Prints `MOCK-GAP <file>:<line> <module> lacks <names>` per
// failing block and exits 1; exits 0 when every block passes.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MOCK_CALL = /\bvi\.mock\(\s*(["'`])([^"'`]+)\1/g;

/** The text of each `vi.mock` call for `specifier`, with its line, by paren matching. */
export function mockBlocks(text, specifier) {
  const blocks = [];
  for (const match of text.matchAll(MOCK_CALL)) {
    if (match[2] !== specifier) continue;
    const open = text.indexOf("(", match.index);
    let depth = 0;
    let end = open;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    blocks.push({ line: text.slice(0, match.index).split("\n").length, body: text.slice(open, end + 1) });
  }
  return blocks;
}

/** Exports a mock block leaves out; none when it spreads the real module. */
export function blockGaps(body, exports) {
  const original = /(\w+)\s*=\s*(?:await\s+)?importOriginal\b/.exec(body)?.[1];
  if (/\.\.\.\s*\(?\s*(?:await\s+)?importOriginal\b/.test(body) || (original && new RegExp(`\\.\\.\\.\\s*${original}\\b`).test(body))) {
    return [];
  }
  return exports.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
}

function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { module: { type: "string" }, exports: { type: "string" } } });
  const exports = (values.exports ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!values.module || exports.length === 0 || positionals.length === 0) {
    throw new Error("Usage: mock-gap.mjs --module <specifier> --exports <a,b> <test file>...");
  }
  let gaps = 0;
  for (const file of positionals) {
    for (const block of mockBlocks(readFileSync(file, "utf8"), values.module)) {
      const missing = blockGaps(block.body, exports);
      if (missing.length > 0) {
        gaps += 1;
        process.stdout.write(`MOCK-GAP ${file}:${block.line} ${values.module} lacks ${missing.join(", ")}\n`);
      }
    }
  }
  return gaps === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
