import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The two Codex install arms an ordinary case can run under; run.py reads the same `generic` tag. */
export type CodexArm = "provider" | "generic";
/** One Codex arm's eval run: its cases, output directory and runner arguments, and the process result once it ran. */
export type CodexArmRun = {
  arm: CodexArm;
  ids: string[];
  output: string;
  args: string[];
  process: { status: number; stdout: string; stderr: string } | null;
};

const TAGS_LINE = /^tags:\s*\[([^\]]*)\]/m;

/** A case tagged `generic` runs in the generic arm; every other case models the provider's repository. */
function codexArmOf(vibeDir: string, caseId: string): CodexArm {
  const prompt = readFileSync(join(vibeDir, "evals", caseId, "prompt.md"), "utf8");
  const header = prompt.split("---", 3)[1] ?? "";
  const tags = (TAGS_LINE.exec(header)?.[1] ?? "").split(",").map((tag) => tag.trim());
  return tags.includes("generic") ? "generic" : "provider";
}

/** Split ordinary case ids by the arm that runs them: run.py rejects a case its `--arm` does not run. */
export function splitCodexArms(vibeDir: string, caseIds: readonly string[]): Record<CodexArm, string[]> {
  const arms: Record<CodexArm, string[]> = { provider: [], generic: [] };
  for (const id of caseIds) arms[codexArmOf(vibeDir, id)].push(id);
  return arms;
}
