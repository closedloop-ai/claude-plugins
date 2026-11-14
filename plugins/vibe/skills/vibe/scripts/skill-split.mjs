// Reads a prompt file with its split-out blocks put back where its stubs are, so a
// contract test reads a skill or reference file whole. A stub is one line,
// `> Read \`references/x.md\` (block \`id\`) ...`; the block it names lives in that file between
// `<!-- block: id -->` and `<!-- end: id -->`, moved without change. The path is relative to the skill folder
// (the nearest folder above the file that holds a SKILL.md). Provider stubs then assemble as a reader with the
// provider in this repository bound sees them (`provider: false` for a reader with none), the same
// as tools/python/skill_split.py `assembled`. Test support only: nothing at runtime reads it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_BINDING } from "./test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { assembleProviderText } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const STUB = /^> Read `([^`]+)` \(block `([^`]+)`\)[^\n]*$/gm;

function skillRoot(file) {
  let folder = path.dirname(file);
  while (!existsSync(path.join(folder, "SKILL.md"))) {
    const parent = path.dirname(folder);
    if (parent === folder) throw new Error(`no skill folder above ${file}`);
    folder = parent;
  }
  return folder;
}

/** The text of `block` in `reference` under the skill folder `root`. */
export function blockText(root, reference, block) {
  const text = readFileSync(path.join(root, reference), "utf8");
  const found = new RegExp(`<!-- block: ${block} -->\\n([\\s\\S]*?)\\n<!-- end: ${block} -->`).exec(text);
  if (!found) throw new Error(`${reference} has no block ${block}`);
  return found[1];
}

/** `file`'s text with every stub replaced by the block it names, and its provider stubs assembled. */
export function readAssembled(location, { provider = true } = {}) {
  const file = location instanceof URL ? fileURLToPath(location) : location;
  let text = readFileSync(file, "utf8");
  if (new RegExp(STUB.source, "m").test(text)) {
    const root = skillRoot(file);
    text = text.replace(STUB, (_stub, reference, block) => blockText(root, reference, block));
  }
  return assembleProviderText(text, provider ? PROVIDER_BINDING : null);
}
