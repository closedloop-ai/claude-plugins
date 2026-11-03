import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { EvalSkill } from "./eval-policy.ts";

export interface EvalCaseDefinition {
  id: string;
  skill: EvalSkill;
  contentHash: string;
  deterministic?: true;
  kind?: "upgrade-resume";
  definition?: "unchanged" | "changed";
  nightlyPrior?: ReleaseReference;
  transitions?: UpgradeTransition[];
}

/** One immutable vibe release selected by exact commit and manifest version. */
export interface ReleaseReference {
  version: string;
  ref: string;
}

/** Fixed historical proof transition for one writer-definition relation. */
export interface UpgradeTransition {
  target: ReleaseReference;
  prior: ReleaseReference;
  /** Historical outcome fixed by the release proof; omitted legacy manifests mean pass. */
  expected?: { claude: "pass" | "fail"; codex: "pass" | "fail" };
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
  const found = [...prompt.matchAll(/vibe:(vibe|handoff|fleet-orchestrator|pr-takeover)/g)]
    .map((match) => match[1] as EvalSkill);
  const unique = [...new Set(found)];
  if (unique.length !== 1) throw new Error("eval-case-skill-invocation-invalid");
  return unique[0];
}

function releaseReference(value: unknown, field: string): ReleaseReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`eval-stateful-${field}-invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "ref,version" ||
      typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version) ||
      typeof record.ref !== "string" || !/^[a-f0-9]{40}$/.test(record.ref)) {
    throw new Error(`eval-stateful-${field}-invalid`);
  }
  return { version: record.version, ref: record.ref };
}

/** Parse the dependency-free JSON subset of YAML used by stateful case manifests. */
export function statefulCaseDefinition(caseDir: string, id: string): EvalCaseDefinition | null {
  const manifest = join(caseDir, "case.yaml");
  if (!existsSync(manifest)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifest, "utf8")) as unknown; }
  catch { throw new Error("eval-stateful-manifest-malformed"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("eval-stateful-manifest-invalid");
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "definition,deterministic,kind,nightlyPrior,schemaVersion,skill,transitions" ||
      value.schemaVersion !== 1 || value.kind !== "upgrade-resume" || value.skill !== "vibe" ||
      value.deterministic !== true || (value.definition !== "unchanged" && value.definition !== "changed") ||
      !Array.isArray(value.transitions) || value.transitions.length < 2) {
    throw new Error("eval-stateful-manifest-invalid");
  }
  const transitions = value.transitions.map((item, index): UpgradeTransition => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        !["prior,target", "expected,prior,target"].includes(
          Object.keys(item as Record<string, unknown>).sort().join(","))) {
      throw new Error(`eval-stateful-transition-${index}-invalid`);
    }
    const record = item as Record<string, unknown>;
    const expected = record.expected;
    if (expected !== undefined && (!expected || typeof expected !== "object" ||
        Array.isArray(expected) || Object.keys(expected).sort().join(",") !== "claude,codex" ||
        !["pass", "fail"].includes((expected as Record<string, unknown>).claude as string) ||
        !["pass", "fail"].includes((expected as Record<string, unknown>).codex as string))) {
      throw new Error(`eval-stateful-transition-${index}-expected-invalid`);
    }
    return { target: releaseReference(record.target, `target-${index}`),
      prior: releaseReference(record.prior, `prior-${index}`),
      ...(expected ? { expected: expected as UpgradeTransition["expected"] } : {}) };
  });
  if (new Set(transitions.map((item) => item.target.ref)).size !== transitions.length ||
      transitions.some((item) => item.target.ref === item.prior.ref)) {
    throw new Error("eval-stateful-transitions-invalid");
  }
  return { id, skill: "vibe", contentHash: evalCaseContentHash(caseDir), deterministic: true,
    kind: "upgrade-resume", definition: value.definition, nightlyPrior:
      releaseReference(value.nightlyPrior, "nightly-prior"), transitions };
}

/** Discover the complete case catalog and its derived `skill:<name>` ownership. */
export function evalCaseCatalog(vibeDir: string): EvalCaseDefinition[] {
  const evals = join(vibeDir, "evals");
  const catalog = readdirSync(evals, { withFileTypes: true }).flatMap((entry) => {
    const caseDir = join(evals, entry.name);
    const prompt = join(caseDir, "prompt.md");
    if (!entry.isDirectory()) return [];
    if (existsSync(prompt)) return [{ id: entry.name,
      skill: skillFromPrompt(readFileSync(prompt, "utf8")), contentHash: evalCaseContentHash(caseDir) }];
    const stateful = statefulCaseDefinition(caseDir, entry.name);
    return stateful ? [stateful] : [];
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
