#!/usr/bin/env node
// The mechanical half of `vibe-environment-worker` (PRD-823, WS3 D2, ISS-13344):
// the flag snapshot, the publish checks and push, the environment request, the
// run polling and the recording, with no model reading `gh` output every 15
// seconds. It wraps `vibe-sessions.mjs` (dispatch-inputs, flag-snapshot,
// main-sync-push, environment-result), `posthog-key.mjs`, `local-plans.mjs`,
// `migration-publish.mjs` and `pr-preflight.mjs`; it re-implements none of
// them. The worker keeps every judgment: it still answers an org choice, writes
// the person's words and updates the ticket. The worker prompt works the same
// without this script.
//
// Usage:
//   env-ctl.mjs flags    --worktree <path> --distinct-id <clerkId> --org-id <orgId> [--replace]
//   env-ctl.mjs request  --worktree <path> --mode create|flags|desktop|redeploy [--person-email <email>]
//                        [--keep-flag-snapshot true|false] [--poll-seconds 15] [--find-seconds 600] [--give-up-seconds 2700]
//   env-ctl.mjs publish  --worktree <path> [--since <sha>]       (checks, then main-sync-push; parent context on stdin)
//   env-ctl.mjs redeploy --worktree <path> [--since <sha>] [--person-email <email>]
//   env-ctl.mjs desktop  --worktree <path> [--person-email <email>]
//   env-ctl.mjs pr       --worktree <path> --branch <vibe/slug> --commit <sha> --title <text> --body-file <file> --base <sha>
//   env-ctl.mjs pr-update --worktree <path> --pr <number> --body-file <file> --title <text>
//
// `identity` (the distinct id and org id) comes from the worker's ClosedLoop
// `get-me`; this script has no credential of its own and never prints the
// public PostHog key. Every command prints one JSON object whose `status` is
// DONE, BLOCKED, NEEDS_PERSON, NEEDS_AGENT or a status `main-sync-push`
// returned (such as NEEDS_DESKTOP_STOP), and exits 0 only for DONE.
// NEEDS_AGENT means the run said something only the worker can decide on
// (an org that could not be chosen, an identity refusal): the evidence is in
// the object, and the script wrote no words for the person.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DISPATCH_WORKFLOW } from "./vibe-session-data.mjs";
import { execCommand, parseJson, tailLines } from "./ws3-exec.mjs";

export const REPO = "closedloop-ai/symphony-alpha";
export const ENVIRONMENT_WORKFLOW = "vibe-environment.yml";
export const RUN_FAILURES = new Set(["failure", "cancelled", "timed_out"]);
// agents/vibe-environment-worker.md, the sentence it returns when no analytics key can be found.
export const NO_ANALYTICS_KEY = "I couldn't find the product's analytics key, so I can't copy your feature flags yet.";
// agents/vibe-environment-worker.md, the sentence it returns when the result artifact is missing or refused.
export const NOT_CONFIRMED_READY = "Your copy of the app could not be confirmed as ready, so I haven't opened it.";
// The files commit-worktree.mjs always leaves out of a commit.
const LEFT_OUT = [/(^|\/)\.env(\.|$)/, /^\.control\//, /^\.closedloop-ai\/vibe-plans\//];
// Evidence for the agent, not a sentence for the person: the launcher's grant did not reach this script's stdin intact.
export const MAIN_SYNC_CONTEXT_MISSING = "The parent-issued main-sync context is missing or invalid: expected { \"context\": <operationContext> } on stdin, copied verbatim from the launch envelope (environment.md, Main-sync before publication).";
export const Status = Object.freeze({
  Done: "DONE", Blocked: "BLOCKED", NeedsPerson: "NEEDS_PERSON", NeedsAgent: "NEEDS_AGENT", NeedsCommit: "NEEDS_COMMIT",
});

const here = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(here, name);
const SESSIONS = script("vibe-sessions.mjs");

/** The inputs a workflow_dispatch declares: every name, and those with `required: true` and no default. */
export function parseWorkflowInputs(yaml) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^\s*workflow_dispatch:\s*$/.test(line));
  const declared = new Set();
  const required = new Set();
  if (start < 0) return { declared, required };
  const indentOf = (line) => line.length - line.trimStart().length;
  const base = indentOf(lines[start]);
  let index = lines.findIndex((line, at) => at > start && /^\s*inputs:\s*$/.test(line));
  if (index < 0 || indentOf(lines[index]) <= base) return { declared, required };
  const inputsIndent = indentOf(lines[index]);
  let current = null;
  let currentIndent = 0;
  let hasDefault = false;
  let isRequired = false;
  const close = () => {
    if (current && isRequired && !hasDefault) required.add(current);
  };
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent <= inputsIndent) break;
    const key = /^(\s*)["']?([A-Za-z0-9_-]+)["']?:\s*$/.exec(line);
    if (key && (current === null || indent <= currentIndent)) {
      close();
      current = key[2];
      currentIndent = indent;
      hasDefault = false;
      isRequired = false;
      declared.add(current);
    } else if (current !== null) {
      if (/^\s*required:\s*true\b/.test(line)) isRequired = true;
      if (/^\s*default:/.test(line)) hasDefault = true;
    }
  }
  close();
  return { declared, required };
}

/** What a failed job's log says: its `##[error]` lines and the org lines the worker's steps 5 to 7 read. */
export function extractFailure(log) {
  const clean = log.replace(/\u001b\[[0-9;]*m/g, "");
  const strip = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "");
  const lines = clean.split("\n").map(strip);
  const errors = lines.filter((line) => line.startsWith("##[error]")).map((line) => line.slice("##[error]".length).trim());
  const refusal = lines.map((line) => /clerk_org_refusal=(\S+)/.exec(line)?.[1]).find(Boolean) ?? null;
  const orgsLine = lines.find((line) => line.includes("clerk_orgs_json="));
  const orgsJson = orgsLine ? orgsLine.slice(orgsLine.indexOf("clerk_orgs_json=") + "clerk_orgs_json=".length).trim() : null;
  const orgs = orgsJson ? parseJson(orgsJson.replace(/^'|'$/g, ""), null) : null;
  const orgLines = lines.filter((line) => /^org:\s/.test(line.trim())).map((line) => line.trim());
  return { errors: errors.slice(0, 8), refusal, orgs, orgLines };
}

/** The run among `runs` whose title carries `(<requestId>)`. */
export function runForRequest(runs, requestId) {
  return (Array.isArray(runs) ? runs : []).find((entry) => typeof entry?.displayTitle === "string" && entry.displayTitle.includes(`(${requestId})`)) ?? null;
}

/** Paths in `porcelain` that a commit would still need to take: everything but local fixes and the always-left-out files. */
export function uncommittedDeliverables(porcelain, localFixes = []) {
  const skip = new Set(localFixes);
  return porcelain.split("\n").filter((line) => line.trim() !== "").map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .filter((file) => !skip.has(file) && !LEFT_OUT.some((pattern) => pattern.test(file)));
}

/**
 * Null when `stdin` is JSON holding a `context` object; otherwise the BLOCKED result. Only the shape is checked:
 * the bytes themselves are always forwarded untouched, and every field is judged by main-sync, never here.
 */
export function mainSyncContextProblem(stdin) {
  const blocked = { status: Status.Blocked, code: "MAIN_SYNC_CONTEXT_MISSING", error: MAIN_SYNC_CONTEXT_MISSING };
  if (typeof stdin !== "string" || stdin.trim() === "") return blocked;
  const parsed = parseJson(stdin, null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.context && typeof parsed.context === "object" && !Array.isArray(parsed.context) ? null : blocked;
}

/** Builds the controller over its commands; tests inject `run`, `sleep` and `now`. */
export function createEnvCtl({
  run = execCommand,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  fetchFn = globalThis.fetch,
  repo = REPO,
  write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
  read = (file) => readFileSync(file, "utf8"),
} = {}) {
  const node = (name, args, options) => run(process.execPath, [script(name), ...args], options);
  const sessions = (args, options) => run(process.execPath, [SESSIONS, ...args], options);
  const gh = (args, options) => run("gh", args, options);
  const gitDir = (worktree) => run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();

  async function flags({ worktree, distinctId, orgId, replace = false }) {
    if (!distinctId || !orgId) return { status: Status.Blocked, error: "--distinct-id and --org-id come from ClosedLoop get-me." };
    const repoOut = parseJson(sessions(["repo"]).stdout, {});
    const checkouts = [worktree, repoOut.repo].filter(Boolean).flatMap((checkout) => ["--checkout", checkout]);
    const key = parseJson(node("posthog-key.mjs", checkouts).stdout, {});
    if (key.ok !== true) return { status: Status.Blocked, message: NO_ANALYTICS_KEY, error: key.error ?? "posthog-key.mjs found no key" };
    let body;
    try {
      const response = await fetchFn(`${key.host}/flags?v=2`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: key.key, distinct_id: distinctId }),
      });
      if (!response.ok) return { status: Status.Blocked, error: `PostHog answered ${response.status}` };
      body = await response.json();
    } catch (error) {
      return { status: Status.Blocked, error: `PostHog request failed: ${error.message}` };
    }
    const evaluated = body?.flags;
    if (!evaluated || typeof evaluated !== "object") return { status: Status.Blocked, error: "PostHog's answer had no flags" };
    const snapshot = {};
    for (const [name, flag] of Object.entries(evaluated)) {
      snapshot[name] = flag?.variant ?? flag?.enabled === true;
    }
    const file = path.join(gitDir(worktree), "vibe-flag-snapshot.new.json");
    write(file, `${JSON.stringify({ takenAt: new Date(now()).toISOString(), distinctId, orgId, flags: snapshot }, null, 2)}\n`);
    const saved = parseJson(sessions(["flag-snapshot", "--worktree", worktree, "--file", file, ...(replace ? ["--replace"] : [])]).stdout, {});
    if (saved.ok !== true) return { status: Status.Blocked, error: saved.error ?? "flag-snapshot refused the snapshot" };
    return { status: Status.Done, flagCount: Object.keys(snapshot).length, replaced: replace };
  }

  async function findRun(workflow, requestId, { pollSeconds, findSeconds }) {
    const deadline = now() + findSeconds * 1000;
    for (;;) {
      const listed = gh(["run", "list", "--repo", repo, "--workflow", workflow, "--limit", "20", "--json", "displayTitle,databaseId,status,conclusion"]);
      const found = runForRequest(parseJson(listed.stdout, []), requestId);
      if (found) return found;
      if (now() >= deadline) return null;
      await sleep(pollSeconds * 1000);
    }
  }

  function failedJobEvidence(job) {
    const log = gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
    return { job: job.name ?? String(job.databaseId), conclusion: job.conclusion, ...extractFailure(log.stdout), logTail: tailLines(log.stdout, 6) };
  }

  /** Follows one run job by job; returns { ok: true } or { ok: false, failure | giveUp }. */
  async function followRun(id, { pollSeconds, giveUpSeconds }) {
    const deadline = now() + giveUpSeconds * 1000;
    for (;;) {
      const view = parseJson(gh(["run", "view", String(id), "--repo", repo, "--json", "status,conclusion,jobs"]).stdout, null);
      const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
      const failed = jobs.find((job) => RUN_FAILURES.has(job.conclusion));
      if (failed) return { ok: false, failure: failedJobEvidence(failed) };
      if (view?.status === "completed") {
        return view.conclusion === "success" ? { ok: true } : { ok: false, failure: { job: null, conclusion: view.conclusion, errors: [], refusal: null, orgs: null, orgLines: [] } };
      }
      if (now() >= deadline) {
        return { ok: false, giveUp: jobs.filter((job) => job.status !== "completed").map((job) => job.name).slice(0, 3) };
      }
      await sleep(pollSeconds * 1000);
    }
  }

  function failureStatus(failure) {
    if (failure.refusal || failure.orgs || failure.orgLines?.length) return { status: Status.NeedsAgent, reason: "org-or-identity-refusal", ...failure };
    return { status: Status.Blocked, ...failure };
  }

  async function request({ worktree, mode, personEmail, keepFlagSnapshot, pollSeconds = 15, findSeconds = 600, giveUpSeconds = 2700, stdin }) {
    const noContext = mainSyncContextProblem(stdin);
    if (noContext) return noContext;
    const yaml = gh(["workflow", "view", DISPATCH_WORKFLOW, "--repo", repo, "--yaml"]);
    const workflowInputs = parseWorkflowInputs(yaml.stdout);
    const keep = workflowInputs.declared.has("keep_flag_snapshot") ? (keepFlagSnapshot ?? (mode === "flags" ? "false" : "true")) : undefined;
    const out = path.join(gitDir(worktree), "vibe-dispatch-inputs.json");
    const args = ["dispatch-inputs", "--worktree", worktree, "--out", out, ...(personEmail ? ["--person-email", personEmail] : []), ...(keep ? ["--keep-flag-snapshot", keep] : [])];
    const dispatched = parseJson(sessions(args, { input: stdin }).stdout, {});
    if (dispatched.mainSync) return { ...dispatched.mainSync, status: dispatched.mainSync.status ?? Status.Done, requested: false };
    if (dispatched.ok !== true) return { status: dispatched.status ?? Status.Blocked, error: dispatched.error ?? "dispatch-inputs refused", ...(dispatched.problems ? { problems: dispatched.problems } : {}) };
    const missing = [...workflowInputs.required].filter((name) => !dispatched.inputNames.includes(name));
    if (missing.length > 0) return { status: Status.Blocked, error: `The request workflow requires inputs the session does not send: ${missing.join(", ")}.` };
    const started = gh(["workflow", "run", dispatched.workflow, "--repo", repo, "--ref", dispatched.ref ?? "main", "--json"], { input: read(out) });
    if (started.status !== 0) return { status: Status.Blocked, error: tailLines(started.stderr || started.stdout, 3) };
    const timing = { pollSeconds, findSeconds, giveUpSeconds };
    const requestRun = await findRun(dispatched.workflow, dispatched.requestId, timing);
    if (!requestRun) return { status: Status.Blocked, error: "The request run did not appear.", requestId: dispatched.requestId };
    const requestResult = await followRun(requestRun.databaseId, timing);
    if (!requestResult.ok) return finishFailure(requestResult, requestRun);
    const envRun = await findRun(ENVIRONMENT_WORKFLOW, dispatched.requestId, timing);
    if (!envRun) return { status: Status.Blocked, error: "The environment run did not appear.", requestId: dispatched.requestId };
    const envResult = await followRun(envRun.databaseId, timing);
    if (!envResult.ok) return finishFailure(envResult, envRun);
    return recordResult({ worktree, runId: envRun.databaseId, requestId: dispatched.requestId });
  }

  function finishFailure(result, runEntry) {
    if (result.giveUp) return { status: Status.Blocked, error: "Gave up waiting for the run.", stillRunning: result.giveUp, runId: runEntry.databaseId };
    return { ...failureStatus(result.failure), runId: runEntry.databaseId };
  }

  function recordResult({ worktree, runId, requestId }) {
    const target = path.join(gitDir(worktree), "vibe-environment-result");
    const downloaded = gh(["run", "download", String(runId), "--repo", repo, "-n", "vibe-environment-result", "-D", target]);
    if (downloaded.status !== 0) return { status: Status.Blocked, message: NOT_CONFIRMED_READY, error: tailLines(downloaded.stderr, 2) };
    const recorded = parseJson(sessions(["environment-result", "--worktree", worktree, "--file", path.join(target, "vibe-environment-result.json"), "--request-id", requestId]).stdout, {});
    if (recorded.ok !== true) return { status: Status.Blocked, message: NOT_CONFIRMED_READY, error: recorded.error ?? "environment-result refused the file" };
    const { ok, ...result } = recorded;
    return { status: Status.Done, requestId, runId, ...result };
  }

  /** The publish checks the worker runs before any push, then the exact-SHA push. */
  function publish({ worktree, since, stdin }) {
    const noContext = mainSyncContextProblem(stdin);
    if (noContext) return noContext;
    const record = parseJson(sessions(["show", "--worktree", worktree]).stdout, {});
    const session = record.session ?? record;
    const plans = parseJson(node("local-plans.mjs", ["--worktree", worktree]).stdout, {});
    if (plans.ok !== true) return { status: Status.Blocked, problems: plans.committedLocalPlans ?? [plans.error ?? "committed local plans"] };
    const baseline = since ?? session.vercel?.lastDeployedCommit ?? session.baseCommit;
    if (!baseline) return { status: Status.Blocked, error: "No --since commit and the record has no lastDeployedCommit or baseCommit." };
    const migrations = parseJson(node("migration-publish.mjs", ["--worktree", worktree, "--since", baseline]).stdout, {});
    if (migrations.ok !== true) return { status: Status.Blocked, problems: migrations.problems ?? ["migration-publish refused"] };
    const left = uncommittedDeliverables(run("git", ["-C", worktree, "status", "--porcelain"]).stdout, (session.localFixes ?? []).map((fix) => fix.path ?? fix));
    if (left.length > 0) return { status: Status.NeedsCommit, files: left };
    const pushed = parseJson(sessions(["main-sync-push", "--worktree", worktree], { input: stdin }).stdout, {});
    if (pushed.ok !== true) return { status: pushed.status ?? Status.Blocked, error: pushed.error ?? "main-sync-push refused" };
    const sync = pushed.mainSync ?? {};
    return { status: Status.Done, pushed: sync.pushed ?? null, alreadyPublished: sync.alreadyPublished ?? false, ...(sync.sha ? { sha: sync.sha } : {}) };
  }

  async function redeploy({ worktree, since, personEmail, stdin, ...timing }) {
    const published = publish({ worktree, since, stdin });
    if (published.status !== Status.Done) return published;
    if (published.alreadyPublished) return { ...published, requested: false };
    const record = parseJson(sessions(["show", "--worktree", worktree]).stdout, {});
    const session = record.session ?? record;
    if (!session.lastRequestId) return { ...published, requested: false, progress: "pushed" };
    const requested = await request({ worktree, mode: session.vercel?.mode ?? "create", personEmail, stdin, ...timing });
    return { ...requested, pushed: published.pushed };
  }

  /** Opens the pull request, or reports the open one. The body and title are the worker's. */
  function openPullRequest({ worktree, branch, commit, title, bodyFile, base }) {
    const remote = run("git", ["-C", worktree, "ls-remote", "origin", branch]).stdout.split(/\s+/)[0];
    if (remote !== commit) return { status: Status.Blocked, error: `origin/${branch} is at ${remote || "nothing"}, not the verified commit; nothing was pushed.` };
    const existing = parseJson(gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url,number"]).stdout, []);
    if (existing.length > 0) return { status: Status.Done, created: false, url: existing[0].url, number: existing[0].number };
    const checked = parseJson(node("pr-preflight.mjs", ["--title", title, "--body-file", bodyFile, "--worktree", worktree, "--base", base]).stdout, {});
    if (checked.ok !== true) return { status: Status.Blocked, problems: checked.problems ?? ["pr-preflight refused"] };
    const created = gh(["pr", "create", "--repo", repo, "--head", branch, "--base", "main", "--title", title, "--body-file", bodyFile]);
    if (created.status !== 0) return { status: Status.Blocked, error: tailLines(created.stderr, 3) };
    return { status: Status.Done, created: true, url: created.stdout.trim().split("\n").pop() };
  }

  function updatePullRequest({ worktree, pr, bodyFile, title }) {
    if (!title) return { status: Status.Blocked, error: "pr-update needs --title: pr-preflight.mjs checks the title with the body." };
    const checked = parseJson(node("pr-preflight.mjs", ["--title", title, "--body-file", bodyFile, "--worktree", worktree, "--pr", String(pr)]).stdout, {});
    if (checked.ok !== true) return { status: Status.Blocked, problems: checked.problems ?? ["pr-preflight refused"] };
    const edited = gh(["pr", "edit", String(pr), "--repo", repo, "--body-file", bodyFile, "--title", title]);
    return edited.status === 0 ? { status: Status.Done, pr: Number(pr) } : { status: Status.Blocked, error: tailLines(edited.stderr, 3) };
  }

  return { flags, request, publish, redeploy, openPullRequest, updatePullRequest, followRun, findRun, recordResult };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      worktree: { type: "string" }, "distinct-id": { type: "string" }, "org-id": { type: "string" }, replace: { type: "boolean", default: false },
      mode: { type: "string" }, "person-email": { type: "string" }, "keep-flag-snapshot": { type: "string" },
      "poll-seconds": { type: "string" }, "find-seconds": { type: "string" }, "give-up-seconds": { type: "string" },
      since: { type: "string" }, branch: { type: "string" }, commit: { type: "string" }, title: { type: "string" },
      "body-file": { type: "string" }, base: { type: "string" }, pr: { type: "string" },
    },
  });
  if (!values.worktree) throw new Error("--worktree is required.");
  const controller = createEnvCtl();
  const stdin = process.stdin.isTTY ? undefined : readFileSync(0, "utf8");
  const timing = {
    ...(values["poll-seconds"] ? { pollSeconds: Number(values["poll-seconds"]) } : {}),
    ...(values["find-seconds"] ? { findSeconds: Number(values["find-seconds"]) } : {}),
    ...(values["give-up-seconds"] ? { giveUpSeconds: Number(values["give-up-seconds"]) } : {}),
  };
  const common = { worktree: values.worktree, personEmail: values["person-email"] };
  switch (positionals[0]) {
    case "flags": return controller.flags({ worktree: values.worktree, distinctId: values["distinct-id"], orgId: values["org-id"], replace: values.replace });
    case "request": return controller.request({ ...common, mode: values.mode, keepFlagSnapshot: values["keep-flag-snapshot"], stdin, ...timing });
    case "publish": return controller.publish({ worktree: values.worktree, since: values.since, stdin });
    case "redeploy": return controller.redeploy({ ...common, since: values.since, stdin, ...timing });
    case "desktop": return controller.request({ ...common, mode: "desktop", stdin, ...timing });
    case "pr": return controller.openPullRequest({ worktree: values.worktree, branch: values.branch, commit: values.commit, title: values.title, bodyFile: values["body-file"], base: values.base });
    case "pr-update": return controller.updatePullRequest({ worktree: values.worktree, pr: values.pr, bodyFile: values["body-file"], title: values.title });
    default: throw new Error("Usage: env-ctl.mjs flags|request|publish|redeploy|desktop|pr|pr-update --worktree <path> ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(result.status === Status.Done ? 0 : 1);
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ status: Status.Blocked, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exit(2);
    },
  );
}
