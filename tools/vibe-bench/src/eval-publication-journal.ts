import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync,
  realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { EvalBaselineArtifact } from "./eval-baseline.ts";
import { verifyEvalBaseline } from "./eval-baseline.ts";
import type { PublicEvalResult } from "./eval-public-result.ts";
import { projectPublicEvalResult, readPublicSourceResults,
  validatePublicEvalResult } from "./eval-public-result.ts";
import type { EvalPublishAdapter } from "./eval-publish.ts";
import { publishNightlyEval } from "./eval-publish.ts";

const PENDING_PATTERN = /^eval-public-pending-([a-f0-9]{64})\.json$/;

function fingerprint(result: PublicEvalResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

/** Persist only validated public fields before the first external publication side effect. */
export function queuePublicNightlyResult(store: string, value: PublicEvalResult): string {
  const result = validatePublicEvalResult(value);
  const path = join(store, `eval-public-pending-${fingerprint(result)}.json`);
  const content = `${JSON.stringify(result, null, 2)}\n`;
  mkdirSync(store, { recursive: true });
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== content) {
      throw new Error("eval-publish-pending-conflict");
    }
    return path;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return path;
}

/** Recover completed prior runs from private allowlisted records without paid model work. */
export async function recoverPublicNightlyResults(input: { repo: string;
  runRootParent: string; outputDir: string }, adapter: EvalPublishAdapter,
publish: typeof publishNightlyEval = publishNightlyEval): Promise<string[]> {
  if (!existsSync(input.outputDir)) return [];
  const pending = readdirSync(input.outputDir).filter((name) => PENDING_PATTERN.test(name))
    .map((name) => {
      const file = join(input.outputDir, name);
      if (!lstatSync(file).isFile()) throw new Error("eval-publish-pending-invalid");
      const result = validatePublicEvalResult(JSON.parse(readFileSync(file, "utf8")) as unknown);
      if (fingerprint(result) !== PENDING_PATTERN.exec(name)?.[1]) {
        throw new Error("eval-publish-pending-invalid");
      }
      return { file, result };
    }).sort((left, right) => left.result.runAt.localeCompare(right.result.runAt));
  const outcomes: string[] = [];
  for (const { file, result } of pending) {
    const runRoot = join(input.runRootParent, `publish-${result.runAt.replaceAll(/[:.]/g, "")}-` +
      result.pluginSha.slice(0, 8));
    mkdirSync(runRoot, { recursive: true });
    try {
      const outcome = await publish({ repo: input.repo, runRoot, result }, adapter);
      outcomes.push(`VIBE_NIGHTLY_PUBLISH_${outcome.outcome.toUpperCase().replaceAll("-", "_")} ` +
        `${outcome.ticket} ${outcome.pr}`);
      unlinkSync(file);
    } finally {
      try { rmdirSync(runRoot); }
      catch { /* Retain unclean publication worktrees for exact recovery. */ }
    }
  }
  return outcomes;
}

/** Verify the private result path belongs to this nightly store, then queue its public projection. */
export function queueCompletedNightlyResult(outputDir: string, resultPath: string,
  runAt: string): string {
  if (!isAbsolute(resultPath) || !/^eval-t2-[a-zA-Z0-9.-]+\.json$/.test(basename(resultPath)) ||
      realpathSync(dirname(resultPath)) !== realpathSync(outputDir) ||
      !lstatSync(resultPath).isFile()) throw new Error("eval-publish-input-invalid");
  const baseline = JSON.parse(readFileSync(resultPath, "utf8")) as EvalBaselineArtifact;
  verifyEvalBaseline(baseline);
  const result = projectPublicEvalResult(baseline,
    readPublicSourceResults(outputDir, baseline), runAt);
  return queuePublicNightlyResult(outputDir, result);
}
