#!/usr/bin/env node
// The mechanical half of `vibe-setup-worker` (PRD-823, WS3 D1, ISS-13343):
// apply the preflight fixes that need no person, bootstrap a worktree, start
// local Storybook, build and launch the session's Desktop profile, stop what
// a session runs and discard a confirmed session. It wraps `vibe-preflight.sh`,
// `./.closedloop-ai/loops-setup.sh`, `run-bounded.mjs` and the `vibe-sessions.mjs`
// subcommands (`touch`, `desktop-auth`, `desktop-launched`, `desktop-tab`,
// `stop`, `discard`); it re-implements none of them. The worker keeps every
// judgment: a repository defect, an unfamiliar failure and anything it must
// word for the person. The worker prompt works the same without this script.
//
// Usage:
//   setup-ctl.mjs preflight-fix [--runtime codex|claude] [--codex <CLI>] [--repo <checkout>] [--prototype] [--apply]
//   setup-ctl.mjs bootstrap     --worktree <path>
//   setup-ctl.mjs storybook     --worktree <path>
//   setup-ctl.mjs desktop-profile --worktree <path>          (profile + auth claim; the environment is requested again next)
//   setup-ctl.mjs desktop-launch  --worktree <path>          (sign in, start, record)
//   setup-ctl.mjs stop          --worktree <path>
//   setup-ctl.mjs discard       --worktree <target> [--confirmed]
//
// Every command prints one JSON object with a `status` of OK, NEEDS_PERSON,
// BLOCKED or NEEDS_AGENT, and exits 0 only for OK. `NEEDS_PERSON` carries the
// sentence from `plain-words.md` / `preflight.md` when one is written there
// (`message`), and `message: null` plus the `reference` to read when none is:
// this script never writes words for the person. It never types or asks for a
// credential, never runs a fix that needs the Mac password or a sign-in, and
// never runs `<Codex CLI> plugin add`.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { execCommand, parseJson, tailLines } from "./ws3-exec.mjs";

export const Status = Object.freeze({ Ok: "OK", NeedsPerson: "NEEDS_PERSON", Blocked: "BLOCKED", NeedsAgent: "NEEDS_AGENT" });
// references/preflight.md, the `claude-auth-login` row, word for word.
export const CLAUDE_SIGN_IN_WORDS = "Your Claude sign-in on this Mac has run out, so I can't start the helpers that build your change. Open the Terminal app (press Cmd and Space, type Terminal, press Return), type claude auth login and press Return, then finish signing in in the browser window that opens. Tell me when you're done.";
// references/preflight.md, the `allow-folder-access` row; `<folder>` is the preflight's own detail.
export const folderAccessWords = (folder) => `Your Mac is asking whether Codex can open your ${folder} folder; click Allow.`;
// references/environment.md, "Desktop": the sentence for a Desktop that cannot start.
export const DESKTOP_UNAVAILABLE = "DESKTOP_UNAVAILABLE";
export const STORYBOOK_PORTS = Object.freeze({ first: 6100, last: 6999 });
export const LIMITS = Object.freeze({ bootstrap: 1800, desktopPrepare: 900, signIn: 300, storybookWaitMs: 180_000, desktopWaitMs: 300_000, pollMs: 2000 });

/** Mechanical fixes with no person in the loop: the exact command from `preflight.md`'s fix table. */
export const AUTO_FIXES = Object.freeze({
  "install-pnpm": { command: "sh", args: ["-c", "corepack enable && corepack prepare pnpm@latest --activate"], display: "corepack enable && corepack prepare pnpm@latest --activate" },
  "brew-install-jq": { command: "brew", args: ["install", "jq"], display: "brew install jq" },
  "brew-install-gh": { command: "brew", args: ["install", "gh"], display: "brew install gh" },
});
// Fixes that need the person at the Mac or a sign-in the script must not drive.
const PERSON_FIXES = Object.freeze({
  "claude-auth-login": () => ({ message: CLAUDE_SIGN_IN_WORDS, reference: "preflight.md, claude-auth-login" }),
  "allow-folder-access": (check) => ({ message: folderAccessWords(check.detail), reference: "preflight.md, allow-folder-access" }),
  "install-xcode-clt": () => ({ message: null, reference: "preflight.md, install-xcode-clt" }),
  "install-homebrew": () => ({ message: null, reference: "preflight.md, install-homebrew (asks for the Mac password through sudo)" }),
});
// Fixes the preflight says stop, or that are the worker's judgment.
const BLOCKED_FIXES = Object.freeze({
  "unsupported-os": "this flow supports macOS only",
  "choose-repo": "more than one checkout; resolve it from the active workspace or recorded session",
  "ask-for-repo-path": "the folder is not a checkout of the repository; resolve it from the recorded checkout",
  "posthog-key-missing": "the public analytics key could not be found; see preflight.md",
});
const DELEGATED_FIXES = Object.freeze({
  "install-node": "preflight.md, Supported Node",
  "gh-auth-login": "preflight.md, Signing in to GitHub",
  "clone-repo": "preflight.md, clone-repo",
  "run-loops-setup": "setup-ctl.mjs bootstrap --worktree <repo> after preflight.md, run-loops-setup",
});

const here = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(here, name);
const BOUNDED = script("run-bounded.mjs");
const PREFLIGHT = script("vibe-preflight.sh");
const SESSIONS = script("vibe-sessions.mjs");

/** The failed checks (one JSON object per preflight line), classified by their `fix`. */
export function classifyChecks(lines) {
  const failed = lines.filter((check) => check.ok === false);
  const plan = { auto: [], needsPerson: [], blocked: [], delegated: [], unknown: [] };
  for (const check of failed) {
    const fix = String(check.fix ?? "");
    if (fix.includes("plugin add")) plan.blocked.push({ check: check.check, fix, reason: "never run plugin add; a human installs closedloop-core as INSTALL.md describes" });
    else if (fix in AUTO_FIXES) plan.auto.push({ check: check.check, fix });
    else if (fix in PERSON_FIXES) plan.needsPerson.push({ check: check.check, fix, detail: check.detail, ...PERSON_FIXES[fix](check) });
    else if (fix in BLOCKED_FIXES) plan.blocked.push({ check: check.check, fix, reason: BLOCKED_FIXES[fix], detail: check.detail });
    else if (fix in DELEGATED_FIXES) plan.delegated.push({ check: check.check, fix, reference: DELEGATED_FIXES[fix], detail: check.detail });
    else plan.unknown.push({ check: check.check, fix, detail: check.detail });
  }
  return plan;
}

function overallStatus(plan) {
  if (plan.blocked.length > 0) return Status.Blocked;
  if (plan.needsPerson.length > 0) return Status.NeedsPerson;
  if (plan.delegated.length > 0 || plan.unknown.length > 0 || plan.auto.length > 0) return Status.NeedsAgent;
  return Status.Ok;
}

/** The preflight's JSON lines from its output; a line that is not JSON is dropped. */
export function parsePreflight(stdout) {
  return stdout.split("\n").map((line) => parseJson(line, null)).filter((item) => item && typeof item.check === "string");
}

/** A free port in the Storybook range, given a probe of which ports answer. */
export async function freePort(isFree, { first, last } = STORYBOOK_PORTS) {
  for (let port = first; port <= last; port += 1) {
    if (await isFree(port)) return port;
  }
  return null;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Starts a command detached, logging owner-only to `logFile`; returns its pid. */
export function startDetached(command, args, { cwd, logFile }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(command, args, { cwd, detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  return child.pid;
}

export function createSetupCtl({
  run = execCommand,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  isPortFree = portIsFree,
  detach = startDetached,
  probe = async (url) => { try { return (await fetch(url)).ok; } catch { return false; } },
  alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  readFile = (file) => readFileSync(file, "utf8"),
  writeFile = (file, text) => writeFileSync(file, text),
  exists = existsSync,
} = {}) {
  const sessions = (args, options) => parseJson(run(process.execPath, [SESSIONS, ...args], options).stdout, {});
  const bounded = (seconds, command, args, options) => run(process.execPath, [BOUNDED, String(seconds), command, ...args], { ...options, timeoutMs: (seconds + 30) * 1000 });
  const gitDir = (worktree) => run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]).stdout.trim();
  const session = (worktree) => {
    const shown = sessions(["show", "--worktree", worktree]);
    return shown.session ?? shown;
  };

  function preflightArgs({ runtime, codex, repo, prototype }) {
    return [...(runtime ? ["--runtime", runtime] : []), ...(codex ? ["--codex", codex] : []), ...(repo ? ["--repo", repo] : []), ...(prototype ? ["--prototype"] : [])];
  }

  function preflightFix(options) {
    const args = preflightArgs(options);
    const first = parsePreflight(run("bash", [PREFLIGHT, ...args]).stdout);
    if (first.length === 0) return { status: Status.Blocked, error: "vibe-preflight.sh printed no checks" };
    let plan = classifyChecks(first);
    const applied = [];
    if (options.apply) {
      for (const item of plan.auto) {
        const fix = AUTO_FIXES[item.fix];
        const result = bounded(LIMITS.bootstrap, fix.command, fix.args);
        applied.push({ fix: item.fix, command: fix.display, ok: result.status === 0, ...(result.status === 0 ? {} : { evidenceTail: tailLines(`${result.stdout}\n${result.stderr}`, 4) }) });
      }
      if (applied.length > 0) plan = classifyChecks(parsePreflight(run("bash", [PREFLIGHT, ...args]).stdout));
    }
    return { status: overallStatus(plan), applied, ...plan, passing: first.filter((check) => check.ok === true).map((check) => check.check) };
  }

  function bootstrap({ worktree }) {
    const setup = path.join(worktree, ".closedloop-ai", "loops-setup.sh");
    if (!exists(setup)) return { status: Status.Blocked, error: "the worktree has no .closedloop-ai/loops-setup.sh" };
    const result = bounded(LIMITS.bootstrap, "./.closedloop-ai/loops-setup.sh", [], { cwd: worktree });
    if (result.status === 0) return { status: Status.Ok };
    return {
      status: result.status === 124 ? Status.Blocked : Status.NeedsAgent, exitCode: result.status,
      reason: result.status === 124 ? `stopped after ${LIMITS.bootstrap}s on this machine` : "loops-setup.sh failed; read its output for a missing prerequisite",
      evidenceTail: tailLines(`${result.stdout}\n${result.stderr}`, 20),
    };
  }

  async function waitFor(condition, limitMs) {
    const deadline = now() + limitMs;
    for (;;) {
      if (await condition()) return true;
      if (now() >= deadline) return false;
      await sleep(LIMITS.pollMs);
    }
  }

  async function storybook({ worktree }) {
    const record = session(worktree);
    const stack = record.stack ?? {};
    if (stack.storybookUrl && stack.storybookPid && alive(stack.storybookPid) && await probe(stack.storybookUrl)) {
      return { status: Status.Ok, reused: true, url: stack.storybookUrl };
    }
    const port = await freePort(isPortFree);
    if (port === null) return { status: Status.Blocked, error: `no free port from ${STORYBOOK_PORTS.first} to ${STORYBOOK_PORTS.last}` };
    const logFile = path.join(gitDir(worktree), "vibe-storybook.log");
    const pid = detach("pnpm", ["--filter", "storybook", "exec", "storybook", "dev", "-p", String(port), "--ci", "--no-open"], { cwd: worktree, logFile });
    const url = `http://localhost:${port}`;
    const up = await waitFor(async () => (exists(logFile) && /Local:/.test(readFile(logFile))) && await probe(url), LIMITS.storybookWaitMs);
    if (!up) {
      return { status: Status.Blocked, error: "Storybook did not answer in time", pid, evidenceTail: exists(logFile) ? tailLines(readFile(logFile), 12) : "" };
    }
    const recorded = sessions(["touch", "--worktree", worktree, "--stack", JSON.stringify({ ...stack, storybookUrl: url, storybookPid: pid })]);
    if (recorded.ok === false) return { status: Status.Blocked, error: recorded.error ?? "touch refused the stack", pid, url };
    return { status: Status.Ok, reused: false, url, pid };
  }

  function desktopProfile({ worktree }) {
    const profile = path.join(gitDir(worktree), "vibe-desktop-profile");
    const prepared = bounded(LIMITS.desktopPrepare, "pnpm", ["--filter", "desktop", "vibe:profile", "prepare", "--out", profile, "--now", new Date(now()).toISOString()], { cwd: worktree });
    if (prepared.status !== 0) return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: tailLines(`${prepared.stdout}\n${prepared.stderr}`, 2) };
    const claim = bounded(LIMITS.signIn, "pnpm", ["--filter", "desktop", "vibe:profile", "auth-claim", "--profile", profile], { cwd: worktree });
    const claimLine = claim.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).pop();
    if (claim.status !== 0 || !claimLine) return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: tailLines(`${claim.stdout}\n${claim.stderr}`, 2) };
    const claimFile = path.join(gitDir(worktree), "vibe-desktop-auth-claim.json");
    writeFile(claimFile, `${claimLine}\n`);
    const saved = sessions(["desktop-auth", "--worktree", worktree, "--file", claimFile]);
    if (saved.ok === false) return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: saved.error ?? "desktop-auth refused the claim" };
    return { status: Status.Ok, next: "request the environment again in desktop mode (env-ctl.mjs desktop)" };
  }

  async function desktopLaunch({ worktree }) {
    const tab = sessions(["desktop-tab", "--worktree", worktree]);
    if (tab.running === true) return { status: Status.Ok, reused: true };
    const record = session(worktree);
    const apiUrl = record.vercel?.apiUrl;
    const appUrl = record.vercel?.appUrl;
    if (!apiUrl || !appUrl) return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: "the session records no app and API URL yet" };
    const dir = gitDir(worktree);
    const profile = path.join(dir, "vibe-desktop-profile");
    const origins = ["--api-origin", apiUrl, "--web-origin", appUrl];
    const signIn = bounded(LIMITS.signIn, "pnpm", ["--filter", "desktop", "vibe:profile", "sign-in", "--profile", profile, ...origins], { cwd: worktree });
    const signInOutput = `${signIn.stdout}\n${signIn.stderr}`;
    if (signIn.status !== 0 && !/already signed in/i.test(signInOutput)) {
      return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: tailLines(signInOutput, 2) };
    }
    const logFile = path.join(dir, "vibe-desktop.log");
    const pid = detach("pnpm", ["--filter", "desktop", "vibe:profile", "launch", "--profile", profile, ...origins], { cwd: worktree, logFile });
    const visible = await waitFor(() => !alive(pid) || /Desktop window visible/.test(exists(logFile) ? readFile(logFile) : ""), LIMITS.desktopWaitMs);
    const log = exists(logFile) ? readFile(logFile) : "";
    if (!visible || !/Desktop window visible/.test(log)) {
      return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: "Desktop did not show its window", evidenceTail: tailLines(log, 12) };
    }
    const recorded = sessions(["desktop-launched", "--worktree", worktree, "--pid", String(pid), "--log", logFile]);
    if (recorded.ok === false) return { status: Status.Blocked, code: DESKTOP_UNAVAILABLE, error: recorded.error ?? "desktop-launched refused the launch" };
    return { status: Status.Ok, reused: false, pid };
  }

  function stop({ worktree }) {
    const stopped = sessions(["stop", "--worktree", worktree]);
    const { ok, ...rest } = stopped;
    return ok === false ? { status: Status.Blocked, error: stopped.error ?? "stop refused" } : { status: Status.Ok, ...rest };
  }

  function discard({ worktree, confirmed }) {
    const repo = sessions(["repo"]).repo;
    if (!repo) return { status: Status.Blocked, error: "no remembered checkout to run the discard from" };
    const target = path.resolve(worktree);
    if (path.resolve(repo) === target || path.resolve(repo).startsWith(`${target}${path.sep}`)) {
      return { status: Status.Blocked, error: "the retained checkout is the target or inside it; run the discard from another validated checkout" };
    }
    if (!confirmed) {
      const preview = sessions(["discard", "--worktree", target], { cwd: repo });
      const { ok, ...rest } = preview;
      return { status: ok === false ? Status.Blocked : Status.NeedsAgent, confirmed: false, note: "nothing was deleted; run again with --confirmed once the person confirmed", ...rest };
    }
    const stopped = stop({ worktree: target });
    if (stopped.status !== Status.Ok) return stopped;
    const receipt = sessions(["discard", "--worktree", target, "--confirm"], { cwd: repo });
    const { ok, ...rest } = receipt;
    if (ok === false || rest.discarded !== true) return { status: Status.Blocked, error: receipt.error ?? "the discard did not complete", ...rest };
    return { status: Status.Ok, ...rest };
  }

  return { preflightFix, bootstrap, storybook, desktopProfile, desktopLaunch, stop, discard };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      runtime: { type: "string" }, codex: { type: "string" }, repo: { type: "string" }, prototype: { type: "boolean", default: false },
      apply: { type: "boolean", default: false }, worktree: { type: "string" }, confirmed: { type: "boolean", default: false },
    },
  });
  const ctl = createSetupCtl();
  const need = () => { if (!values.worktree) throw new Error("--worktree is required."); return { worktree: path.resolve(values.worktree) }; };
  switch (positionals[0]) {
    case "preflight-fix": return ctl.preflightFix(values);
    case "bootstrap": return ctl.bootstrap(need());
    case "storybook": return ctl.storybook(need());
    case "desktop-profile": return ctl.desktopProfile(need());
    case "desktop-launch": return ctl.desktopLaunch(need());
    case "stop": return ctl.stop(need());
    case "discard": return ctl.discard({ ...need(), confirmed: values.confirmed });
    default: throw new Error("Usage: setup-ctl.mjs preflight-fix|bootstrap|storybook|desktop-profile|desktop-launch|stop|discard ...");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(result.status === Status.Ok ? 0 : 1);
    },
    (error) => {
      process.stdout.write(`${JSON.stringify({ status: Status.Blocked, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exit(2);
    },
  );
}
