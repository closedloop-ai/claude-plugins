// Reads a prompt file with its split-out blocks put back where its stubs are (PRD-823 C1 to C4), so a
// contract test reads a skill or reference file whole. A stub is one line,
// `> Read \`references/x.md\` (block \`id\`) ...`; the block it names lives in that file between
// `<!-- block: id -->` and `<!-- end: id -->`, moved without change. The path is relative to the skill folder
// (the nearest folder above the file that holds a SKILL.md). Test support only: nothing at runtime reads it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

/** `file`'s text with every stub replaced by the block it names. */
export function readAssembled(file) {
  const text = readFileSync(file, "utf8");
  if (!new RegExp(STUB.source, "m").test(text)) return text;
  const root = skillRoot(file);
  return text.replace(STUB, (_stub, reference, block) => blockText(root, reference, block));
}
