import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";

const PULL_REQUEST_EVENTS = ["pull_request", "pull_request_target"];
const patternList = z.union([z.string(), z.array(z.string())]).optional();
const eventFilter = z.object({ paths: patternList, "paths-ignore": patternList }).passthrough().nullable();
const step = z.object({ run: z.unknown().optional(), uses: z.unknown().optional(), if: z.unknown().optional(), "continue-on-error": z.unknown().optional() }).passthrough();
// Actions that only fetch the source, set up a tool or move files; any other action in a job may be its check.
const SETUP_ACTION = /^(?:actions\/(?:checkout|setup-[\w-]+|cache|upload-artifact|download-artifact)|pnpm\/action-setup|\.\/\.github\/actions\/setup-[\w-]+)(?:@|$)/;
const runDefaults = z.object({ run: z.object({ "working-directory": z.unknown().optional() }).passthrough().optional() }).passthrough().optional();
const job = z.object({ steps: z.array(step).optional(), if: z.unknown().optional(), defaults: runDefaults }).passthrough();
const workflow = z.object({ on: z.unknown(), jobs: z.record(job).optional(), defaults: runDefaults }).passthrough();

type PathFilteredWorkflow = { path: string; matchedFiles: string[]; commands: string[]; jobChecks: { job: string; command: string | null }[] };

/**
 * The workflows triggered on pull_request (or pull_request_target) through a `paths` or `paths-ignore` filter that the
 * changed files satisfy, with the files that matched and every `run` command their jobs hold. A workflow with no path
 * filter is the repository's general CI, which the lane report already covers, so it is not listed. GitHub's rules: a
 * `paths` list runs when a changed file's last matching pattern is not `!`-negated; `paths-ignore` runs when some changed
 * file matches none of its patterns. `jobChecks` holds every run step of every job that can run on a passing pull
 * request, and one `command: null` entry for such a job with no run step (a reusable workflow) or with an action that
 * may be its check (any action but checkout, tool setup, cache or artifacts): only a job or step
 * that is certainly off there (`certainlyOffOnPassingPullRequest`) is left out, so a condition this cannot read keeps
 * its step required rather than letting an earlier step stand in for the check. A file that is not valid YAML is an error naming the file.
 */
export function pathFilteredPullRequestWorkflows(workflows: { path: string; text: string }[], changedFiles: string[]): PathFilteredWorkflow[] {
  const matched: PathFilteredWorkflow[] = [];
  for (const file of workflows) {
    let parsed;
    try { parsed = workflow.parse(parse(file.text, { maxAliasCount: 0 })); }
    catch (error) { throw new Error(`${file.path}: not a readable workflow (${error instanceof Error ? error.message : String(error)})`); }
    for (const filter of pullRequestFilters(parsed.on)) {
      const files = filteredFiles(filter, changedFiles);
      if (files === null || files.length === 0) continue;
      matched.push({ path: file.path, matchedFiles: files, commands: runCommands(parsed.jobs ?? {}),
        jobChecks: jobChecks(parsed.jobs ?? {}, parsed.defaults?.run?.["working-directory"]) });
      break;
    }
  }
  return matched;
}

function pullRequestFilters(on: unknown): z.infer<typeof eventFilter>[] {
  if (typeof on === "string" || Array.isArray(on)) return [];
  if (!on || typeof on !== "object") return [];
  return PULL_REQUEST_EVENTS.filter((event) => event in on).map((event) => eventFilter.parse((on as Record<string, unknown>)[event] ?? null));
}

/** The changed files that make a filtered event fire, or null when the event has no path filter. */
function filteredFiles(filter: z.infer<typeof eventFilter>, changedFiles: string[]): string[] | null {
  const list = (value: string | string[] | undefined) => (value === undefined ? undefined : [value].flat());
  const paths = list(filter?.paths);
  const ignored = list(filter?.["paths-ignore"]);
  if (paths === undefined && ignored === undefined) return null;
  if (paths !== undefined) {
    // A pattern whose GitHub meaning differs from picomatch's (`?` and `+` repeat the character before them, `**` inside
    // a segment crosses `/`) is read so the workflow runs: it matches every file and never negates one.
    const rules = paths.map((pattern) => {
      const negated = pattern.startsWith("!");
      const body = pattern.replace(/^!/, "");
      return { negated, test: githubOnlyGlob(body) ? () => !negated : picomatch(body, { dot: true }) };
    });
    return changedFiles.filter((changed) => {
      let included = false;
      for (const rule of rules) if (rule.test(changed)) included = !rule.negated;
      return included;
    });
  }
  const tests = (ignored ?? []).filter((pattern) => !githubOnlyGlob(pattern)).map((pattern) => picomatch(pattern, { dot: true }));
  return changedFiles.filter((changed) => !tests.some((test) => test(changed)));
}

function runCommands(jobs: Record<string, z.infer<typeof job>>): string[] {
  const commands = Object.values(jobs).flatMap((entry) => (entry.steps ?? []).map((item) => item.run))
    .filter((run): run is string => typeof run === "string" && run.trim() !== "")
    .map((run) => run.trim());
  return [...new Set(commands)];
}

function jobChecks(jobs: Record<string, z.infer<typeof job>>, workflowDirectory: unknown): { job: string; command: string | null }[] {
  return Object.entries(jobs).filter(([, entry]) => !certainlyOffOnPassingPullRequest(entry)).flatMap(([name, entry]) => {
    const jobDirectory = entry.defaults?.run?.["working-directory"] ?? workflowDirectory;
    const commands = (entry.steps ?? []).filter((item) => !stepCertainlyOff(item)).flatMap((item) => {
      if (typeof item.run !== "string" || item.run.trim() === "") return [];
      const directory = item["working-directory"] ?? jobDirectory;
      return [{ job: name, command: typeof directory === "string" && directory.trim() !== "" && directory.trim() !== "."
        ? `cd ${directory.trim()} && ${item.run.trim()}` : item.run.trim() }];
    });
    const checkingAction = (entry.steps ?? []).some((item) => !stepCertainlyOff(item)
      && typeof item.uses === "string" && !SETUP_ACTION.test(item.uses));
    return commands.length > 0 && !checkingAction ? commands : [...commands, { job: name, command: null }];
  });
}

/** A glob whose GitHub meaning differs from picomatch's: `?` or `+` anywhere, or `**` inside a path segment. */
function githubOnlyGlob(pattern: string): boolean {
  return /[?+]/.test(pattern) || /[^/]\*\*|\*\*[^/]/.test(pattern);
}

// The exact `if:` forms that are false on a passing pull_request run; any other condition may be true there.
const OFF_CONDITIONS = [/^failure\(\)$/, /^cancelled\(\)$/, /^false$/, /^github\.event_name\s*==\s*'(?!pull_request(?:_target)?')[a-z_]+'$/];

/** Whether a step certainly does not run on a passing pull request. A `continue-on-error` step stays required: a later
 * step can read its outcome and fail the job. */
function stepCertainlyOff(item: { if?: unknown }): boolean {
  return conditionCertainlyOff(item.if);
}

/** Whether a job certainly does not run, or cannot fail the workflow, on a passing pull request. */
function certainlyOffOnPassingPullRequest(item: { if?: unknown; "continue-on-error"?: unknown }): boolean {
  return item["continue-on-error"] === true || conditionCertainlyOff(item.if);
}

function conditionCertainlyOff(condition: unknown): boolean {
  if (condition === false) return true;
  if (typeof condition !== "string") return false;
  const text = condition.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1").replace(/"/g, "'").trim();
  return OFF_CONDITIONS.some((pattern) => pattern.test(text));
}
