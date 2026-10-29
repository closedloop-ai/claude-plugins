#!/usr/bin/env node
// The mechanical sequence of `vibe-prototype-worker` share mode (PRD-823, WS3
// D8, ISS-13350), with no model: the committed-plan check, the main-sync share
// admission, the exact-SHA push, the wait for that SHA's `prototypes`
// deployment, and the recording of the immutable preview URL. It wraps
// `local-plans.mjs` and the `vibe-sessions.mjs` subcommands `main-sync-share`,
// `main-sync-push` and `prototype-result` (which re-verifies the owned branch,
// the slug, the immutable HTTPS URL and the full HEAD before it records
// anything), and reads GitHub deployments read-only through `gh api`, the
// pattern the repository's prototype skill, step 5.5, names. It changes no
// source, never commits, never touches Vercel settings, and a deployment alias
// is never accepted as readiness: the URL is the deployment's own
// `environment_url` with `/p/<slug>` appended.
//
// Left to the worker: the ticket refresh (the ticket helper owns it), the
// writer's validation and commit that must precede this, and every word for
// the person. Without this script the worker follows its Share mode steps.
//
// Usage: prototype-share.mjs --worktree <path> [--poll-seconds 15] [--deadline-minutes 20]
//   The granted main-sync context is read from stdin when it is piped.
// Prints one JSON object whose `status` is DONE (url, deployedCommit, slug),
// BLOCKED (evidence), or a status `main-sync-share`/`main-sync-push` returned
// (NEEDS_DESKTOP_STOP, NEEDS_COMMIT, ...). Exits 0 only for DONE.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execCommand, parseJson, tailLines } from "./ws3-exec.mjs";

export const REPO = "closedloop-ai/symphony-alpha";
export const READY = "success";
export const STOP_STATES = new Set(["failure", "error", "inactive"]);
const PENDING_STATES = new Set(["pending", "queued", "in_progress"]);
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
export const Status = Object.freeze({ Done: "DONE", Blocked: "BLOCKED" });

const here = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(here, name);

/** The newest preview deployment of the `prototypes` project among a SHA's deployments, or null. */
export function prototypesDeployment(deployments) {
  return (Array.isArray(deployments) ? deployments : [])
    .filter((deployment) => /prototypes/i.test(String(deployment?.environment ?? "")) && /preview/i.test(String(deployment?.environment ?? "")))
    .sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))[0] ?? null;
}

/** The newest status of a deployment (the API lists newest first), or null. */
export function newestStatus(statuses) {
  return Array.isArray(statuses) && statuses.length > 0 ? statuses[0] : null;
}

/** The deployment's own preview URL for the prototype, or null when `environmentUrl` is not an https URL without credentials, query or fragment. */
export function previewUrlFor(environmentUrl, slug) {
  try {
    const url = new URL(environmentUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    url.pathname = `/p/${slug}`;
    return url.href;
  } catch {
    return null;
  }
}

export function createPrototypeShare({
  run = execCommand,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  repo = REPO,
  write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
} = {}) {
  const sessions = (args, options) => parseJson(run(process.execPath, [script("vibe-sessions.mjs"), ...args], options).stdout, {});
  const gh = (args) => run("gh", args);

  function deploymentsFor(sha) {
    const found = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = gh(["api", `repos/${repo}/deployments?sha=${sha}&per_page=${PAGE_SIZE}&page=${page}`]);
      if (response.status !== 0) return { error: tailLines(response.stderr, 2) };
      const batch = parseJson(response.stdout, []);
      found.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return { deployments: found };
  }

  /** Waits for the exact SHA's prototypes deployment to be ready: `{ ready, environmentUrl, deploymentId }` or `{ blocked, ... }`. */
  async function waitReady({ sha, pollSeconds, deadlineMs }) {
    let evidence = { reason: "no prototypes deployment for the SHA appeared" };
    for (;;) {
      const listed = deploymentsFor(sha);
      if (listed.error) return { blocked: "reading deployments failed", evidence: { detail: listed.error } };
      const deployment = prototypesDeployment(listed.deployments);
      if (deployment) {
        const statusResponse = gh(["api", `repos/${repo}/deployments/${deployment.id}/statuses`]);
        if (statusResponse.status !== 0) return { blocked: "reading deployment statuses failed", evidence: { deploymentId: deployment.id, detail: tailLines(statusResponse.stderr, 2) } };
        const status = newestStatus(parseJson(statusResponse.stdout, []));
        evidence = { deploymentId: deployment.id, state: status?.state ?? "none" };
        if (status?.state === READY) return { ready: true, deploymentId: deployment.id, environmentUrl: status.environment_url ?? deployment.environment_url ?? null };
        if (STOP_STATES.has(status?.state)) return { blocked: `the deployment ended as ${status.state}`, evidence };
        if (status && !PENDING_STATES.has(status.state)) return { blocked: `unrecognized deployment state ${status.state}`, evidence };
      }
      if (now() >= deadlineMs) return { blocked: "the deadline passed before the exact SHA was ready", evidence };
      await sleep(pollSeconds * 1000);
    }
  }

  async function share({ worktree, pollSeconds = 15, deadlineMinutes = 20, stdin }) {
    const plans = parseJson(run(process.execPath, [script("local-plans.mjs"), "--worktree", worktree]).stdout, {});
    if (plans.ok !== true) return { status: Status.Blocked, problems: plans.committedLocalPlans ?? [plans.error ?? "committed local plans"] };
    const admitted = sessions(["main-sync-share", "--worktree", worktree], { input: stdin });
    if (admitted.ok !== true) return { status: admitted.status ?? Status.Blocked, error: admitted.error ?? "main-sync-share refused" };
    if (admitted.mainSync?.alreadyPublished === true) return { status: Status.Done, alreadyPublished: true, pushed: false, requested: false };
    const pushed = sessions(["main-sync-push", "--worktree", worktree], { input: stdin });
    if (pushed.ok !== true) return { status: pushed.status ?? Status.Blocked, error: pushed.error ?? "main-sync-push refused" };
    const pushedAt = now();
    const sha = run("git", ["-C", worktree, "rev-parse", "HEAD"]).stdout.trim();
    const record = sessions(["show", "--worktree", worktree]);
    const slug = (record.session ?? record).slug;
    if (!/^[0-9a-f]{40}$/.test(sha) || !slug) return { status: Status.Blocked, error: "could not read the full HEAD SHA or the session slug" };
    const waited = await waitReady({ sha, pollSeconds, deadlineMs: pushedAt + deadlineMinutes * 60_000 });
    if (!waited.ready) return { status: Status.Blocked, error: waited.blocked, deployedCommit: sha, ...waited.evidence };
    const previewUrl = previewUrlFor(waited.environmentUrl, slug);
    if (!previewUrl) return { status: Status.Blocked, error: "the ready deployment has no usable environment_url", deployedCommit: sha, deploymentId: waited.deploymentId };
    const gitDir = run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
    const file = path.join(gitDir, "vibe-prototype-result.json");
    write(file, `${JSON.stringify({ slug, previewUrl, deployedCommit: sha, verifiedAt: new Date(now()).toISOString() }, null, 2)}\n`);
    const recorded = sessions(["prototype-result", "--worktree", worktree, "--file", file]);
    if (recorded.ok !== true) return { status: Status.Blocked, error: recorded.error ?? "prototype-result refused the result", deployedCommit: sha, previewUrl };
    return { status: Status.Done, previewUrl, deployedCommit: sha, slug, deploymentId: waited.deploymentId };
  }

  return { share, waitReady };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { worktree: { type: "string" }, "poll-seconds": { type: "string" }, "deadline-minutes": { type: "string" } } });
  if (!values.worktree) throw new Error("--worktree is required.");
  const stdin = process.stdin.isTTY ? undefined : readFileSync(0, "utf8");
  return createPrototypeShare().share({
    worktree: path.resolve(values.worktree), stdin,
    ...(values["poll-seconds"] ? { pollSeconds: Number(values["poll-seconds"]) } : {}),
    ...(values["deadline-minutes"] ? { deadlineMinutes: Number(values["deadline-minutes"]) } : {}),
  });
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
