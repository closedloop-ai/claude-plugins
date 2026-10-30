import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EvalSkill } from "./eval-policy.ts";

export interface EvalCaseDefinition {
  id: string;
  skill: EvalSkill;
  contentHash: string;
}

function filesBelow(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return filesBelow(path);
    if (entry.isFile()) return [path];
    return [];
  }).sort();
}

/** Hash all case inputs so a changed or added case is never compared with main. */
export function evalCaseContentHash(caseDir: string): string {
  const hash = createHash("sha256");
  for (const path of filesBelow(caseDir)) {
    hash.update(relative(caseDir, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Derive the canonical skill tag from the actual invocation in a case prompt. */
export function skillFromPrompt(prompt: string): EvalSkill {
  const found = [...prompt.matchAll(/vibe:(vibe|handoff|fleet-orchestrator)/g)]
    .map((match) => match[1] as EvalSkill);
  const unique = [...new Set(found)];
  if (unique.length !== 1) throw new Error("eval-case-skill-invocation-invalid");
  return unique[0];
}

/** Discover the complete case catalog and its derived `skill:<name>` ownership. */
export function evalCaseCatalog(vibeDir: string): EvalCaseDefinition[] {
  const evals = join(vibeDir, "evals");
  const catalog = readdirSync(evals, { withFileTypes: true }).flatMap((entry) => {
    const caseDir = join(evals, entry.name);
    const prompt = join(caseDir, "prompt.md");
    if (!entry.isDirectory() || !existsSync(prompt)) return [];
    return [{ id: entry.name, skill: skillFromPrompt(readFileSync(prompt, "utf8")),
      contentHash: evalCaseContentHash(caseDir) }];
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (!catalog.length || new Set(catalog.map((item) => item.id)).size !== catalog.length) {
    throw new Error("eval-case-catalog-invalid");
  }
  return catalog;
}

function gitLines(repo: string, args: string[]): string[] {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Compare the complete push-ready tree with main, including untracked files.
 *
 * A PR may be tested while main is staged as an uncommitted merge. Comparing
 * the index with HEAD would incorrectly select every file brought in by main.
 * Comparing the working tree directly with the base keeps only the final PR
 * diff that the eventual merge commit will contain.
 */
export function evalChangedFiles(repo: string, baseRef: string): string[] {
  const paths = [
    ...gitLines(repo, ["diff", "--name-only", baseRef]),
    ...gitLines(repo, ["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(paths)].sort();
}
