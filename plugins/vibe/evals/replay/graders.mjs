// Reads the existing evals/<case>/graders/*.md format (front matter between
// `---` lines: `type: regex|llm`, regex `match`, `flags`, `pattern`, llm
// `criteria`) and scores text against it. Regex graders run offline; an llm
// grader needs an injected `judge` and is BLOCKED without one.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ReplayResult } from "./results.mjs";

export function parseGrader(text, id = "grader") {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`${id}: no front matter`);
  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(\w+):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    const [, key, rest] = field;
    if (rest === "|") {
      const block = [];
      while (index + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[index + 1])) block.push(lines[(index += 1)].replace(/^ {2}/, ""));
      meta[key] = block.join("\n").trim();
    } else {
      meta[key] = rest.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
    }
  }
  if (meta.type !== "regex" && meta.type !== "llm") throw new Error(`${id}: unknown grader type ${JSON.stringify(meta.type)}`);
  return { id, ...meta };
}

export function loadGraders(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort()
    .map((name) => parseGrader(readFileSync(path.join(dir, name), "utf8"), path.basename(name, ".md")));
}

/** One evidence entry per grader for `text`. */
export async function gradeText(graders, text, { judge } = {}) {
  const entries = [];
  for (const grader of graders) {
    if (grader.type === "regex") {
      const found = new RegExp(grader.pattern, grader.flags ?? "").test(text);
      const pass = grader.match === "not_contains" ? !found : found;
      entries.push({ id: grader.id, result: pass ? ReplayResult.Pass : ReplayResult.Fail });
    } else if (typeof judge === "function") {
      entries.push({ id: grader.id, result: (await judge({ criteria: grader.criteria, text })) ? ReplayResult.Pass : ReplayResult.Fail });
    } else {
      entries.push({ id: grader.id, result: ReplayResult.Blocked, reason: "llm grader needs a judge" });
    }
  }
  return entries;
}
