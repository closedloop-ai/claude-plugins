#!/usr/bin/env node
// The orchestrator's helper ledger. Idle helper panes hide the active ones
// from the operator, so a helper (reviewer, verifier, QA prep, poller) stops
// as soon as its result is accepted and a fresh one is launched from its saved
// brief at the next trigger. `status` lists every helper whose result was
// accepted more than --idle-minutes ago and that is not recorded as stopped.
//
// Usage: helpers.mjs <orchDir> start <name> [--kind other] [--stack <stack>]
//        Reviewer/verifier/critic: --kind <kind> --brief <file> --worktree <dir>
//        --worker-id <managed thread ID> --role <agent name>
//        --agent-definition <canonical file> --capabilities <recorded JSON> [--runtime claude|codex]
//        [--owner <writer> --ticket <slug> --repo <owner/repo> --pr <n> --ending pr-terminal]
//        helpers.mjs <orchDir> pid <name> <pid...> [--group]
//        helpers.mjs <orchDir> resources <name> [--project <compose>] [--container <id>]...
//        [--volume <id>]... [--network <id>]...
//        helpers.mjs <orchDir> final <name> --deliverable <file> --session-id <id> --turn-id <id> --out <file>
//        [--completion-event <saved thread/read JSON>]; deliverable ends with
//        FINAL <one-time token> <start tree> <worker ID> <session ID> <turn ID> completed
//        helpers.mjs <orchDir> accepted <name> --report <helper-final.json>
//        helpers.mjs <orchDir> abandoned <name> --reason <why this review was superseded or stopped> [--if-registration <fingerprint>]
//        helpers.mjs <orchDir> stopped <name> [--grace-seconds <n, default 10>] [--owner <writer> --owner-token <token>]
//        helpers.mjs <orchDir> hand <stack> --to <guide>
//        helpers.mjs <orchDir> unhand <stack>
//        helpers.mjs <orchDir> status [--idle-minutes <n, default 5>] [--now <iso>] [--e2e-lock-dir <dir>]
//
// `pid` records processes a helper started (dev servers, app stacks); the
// helper records its own. Pass `--group` only for a process the helper spawned
// detached, so it leads its own process group. `stopped` ends every recorded
// process that is still alive and ours (SIGTERM, then SIGKILL after the grace)
// and records the helper stopped only when none is left; otherwise it prints
// `ALIVE <name> <pids>` and exits 1. A whole group is signalled only for a
// `--group` pid whose process group id still equals the pid; any other pid is
// signalled alone. A pid of 1 or lower, this process or its parent is never
// recorded or signalled, and neither is a pid the system says is not ours
// (EPERM). A recorded pid can be reused, even by one of the user's own apps,
// so `pid` stores each process's start time and command (`ps -o
// lstart=,command=`), refusing one it cannot read, and every signal re-reads
// them first: a pid whose identity differs, cannot be read, or was never
// recorded is treated as not ours and never signalled, alone or as a group.
// `stopped` also refuses, before ending anything, a helper that owns a standing
// duty on the fleet board (board.mjs `duty`): it prints `OWNS <duty>` and exits
// 1 until the duty has another owner. Main's post-merge health once went
// unwatched for an hour after its watcher was stopped with no replacement.
// `hand` marks a running app stack (a worktree path, port or URL) as handed to
// a human QA guide; `start --stack` on a handed stack exits 1, so a rerun that
// toggles flags or moves data launches its own stack.
//
// `status` reconciles terminal PR helpers from their records, then prints
// `STOP`, `ORPHAN`, `LEFTOVER` or `UNKNOWN` with owner and ticket where recorded.
// lines, then `helpers: <active> active, <stop> to stop, <orphans> orphaned`,
// and exits 1 when any helper should be stopped or left processes running.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { captureOwnedDockerResources, defaultLockDir, readHolder, removeOwnedDockerResources, sameWorktreeEntry } from "../../vibe/scripts/e2e-lock.mjs";
import { readProcessIdentity } from "../../../shared/process-identity.mjs";
import { sameSource, sourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { readSessionRecord } from "../../vibe/scripts/session-record.mjs";
import { agentFrontmatterName } from "../../vibe/scripts/agent-frontmatter.mjs";
import { evidenceFingerprint } from "../../handoff/scripts/handoff-evidence.mjs";
import { graphAliases } from "../../handoff/scripts/mcp-tool-names.mjs";
import { promptProblems } from "./skill-freshness.mjs";
import { LoadBasis, loadedSkillEvidence } from "../../vibe/scripts/loaded-skill.mjs";
import { vibeRoot } from "../../../shared/vibe-install.mjs";

import { captureScratchLease, reconcileExpiredScratchHelpers, registerScratchProgram, runScratchStack,
  scratchLeaseTerminal } from './scratch-cleanup.mjs';
import { failScript } from "../../vibe/scripts/provider.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

const LEDGER = "helpers.json";
const STACKS = "#stacks";
const DEFAULT_IDLE_MINUTES = 5;
const DEFAULT_GRACE_SECONDS = 10;
const POLL_MS = 200;
const LEDGER_WAIT_MS = 30_000;
const ENDINGS = new Set(["pr-terminal"]);
const FINAL_KINDS = new Set(["reviewer", "verifier", "critic"]);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The helper writes this exact last line only after its deliverable is complete. */
export function finalMarker(helper, completion) {
  return `FINAL ${helper.finalToken} ${helper.source.treeSha256} ${helper.workerId} ${completion.sessionId} ${completion.turnId} completed`;
}

/** Read the same regular-file bytes that the named helper registers as a launch input. */
export function readHelperInput(file) {
  const fingerprint = evidenceFingerprint(file);
  const bytes = readFileSync(fingerprint.path);
  if (createHash("sha256").update(bytes).digest("hex") !== fingerprint.sha256) throw new Error("Reviewer input changed while reading");
  return { fingerprint, text: bytes.toString("utf8") };
}

/** Relative briefs belong to the orchestration directory and may link to a shared brief. */
export function resolveHelperBrief(orchDir, brief) {
  return realpathSync(path.resolve(orchDir, brief));
}

/** Split saved thread/read objects at their outer braces. JSON.parse validates each complete page. */
function threadReadPages(text) {
  const pages = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (depth === 0) {
      if (!" \t\r\n".includes(char)) return null;
    } else if (char === '"') {
      quoted = true;
    } else if (char === "}" && --depth === 0) {
      try { pages.push(JSON.parse(text.slice(start, index + 1))); }
      catch { return null; }
    }
  }
  return depth === 0 && pages.length ? pages : null;
}

/** Every saved page must belong to the named thread. At least one must confirm the exact completed turn. */
export function completionEventProblem(event, completion) {
  const pages = typeof event === "string" ? threadReadPages(event) : [event];
  if (!pages) return "invalid App Server thread/read completion evidence: expected complete JSON object pages with no trailing output";
  const unconfirmed = "runtime did not confirm the named completed turn";
  let confirmed = false;
  for (const page of pages) {
    const thread = page?.thread ?? page;
    if (thread?.id !== completion.sessionId || (thread.turns !== undefined && !Array.isArray(thread.turns))) return unconfirmed;
    for (const turn of thread.turns ?? []) {
      if (turn?.id !== completion.turnId) continue;
      if (turn.status !== "completed") return unconfirmed;
      confirmed = true;
    }
  }
  return confirmed ? null : unconfirmed;
}

/** Only the helper's explicit final report and unchanged deliverable justify acceptance. */
export function finalReportProblem(helper, reportFile) {
  return verifyFinalReport(helper, reportFile, readHelperInput, sourceIdentity);
}

/** Verify the report and all its evidence against the source read for this operation. */
function verifyFinalReport(helper, reportFile, readInput, readSource) {
  if (!helper?.startedAt || !helper.worktree || !helper.finalToken || !helper.requiresFinal || !reportFile) return "helper needs a registered worktree and final report";
  if (helper.abandonedAt) return "an abandoned helper cannot finalize or accept a report";
  let report;
  try {
    const input = readInput(reportFile);
    if (!helper.finalizedAt || helper.finalReportPath !== input.fingerprint.path) return "helper FINAL token was not consumed for this report";
    report = JSON.parse(input.text);
  } catch { return "helper final report cannot be read"; }
  if (report.helper !== helper.name || report.token !== helper.finalToken || report.status !== "FINAL") return "helper report is not its final deliverable";
  if (report.workerId !== helper.workerId) return "helper report names another worker";
  if (!report.completion?.sessionId || !report.completion?.turnId) return "helper report lacks completed session and turn identity";
  try {
    if (!isDeepStrictEqual(readInput(helper.capabilities?.path).fingerprint, helper.capabilities)) return "helper capability record changed";
    if (!isDeepStrictEqual(readInput(helper.agentDefinition?.path).fingerprint, helper.agentDefinition)) return "helper canonical agent definition changed";
    if (report.completionEvidence) {
      const evidence = readInput(report.completionEvidence.path);
      if (!isDeepStrictEqual(evidence.fingerprint, report.completionEvidence)) return "helper runtime completion evidence changed";
      const runtimeProblem = completionEventProblem(evidence.text, report.completion);
      if (runtimeProblem) return runtimeProblem;
    }
    const deliverable = readInput(report.deliverable?.path);
    if (!isDeepStrictEqual(deliverable.fingerprint, report.deliverable)) return "helper final deliverable changed";
    if (!deliverable.text.trimEnd().endsWith(finalMarker(helper, report.completion))) return "helper deliverable lacks its FINAL marker";
    const source = readSource(helper.worktree);
    if (!sameSource(helper.source ?? {}, source)) return "helper source changed since start";
    if (!sameSource(report.source ?? {}, source)) return "helper report is stale for the current source";
  } catch { return "helper final deliverable cannot be verified"; }
  return null;
}

/** Helpers to stop: accepted more than `idleMinutes` before `now` and never recorded stopped. */
export function stopCandidates(ledger, now, idleMinutes = DEFAULT_IDLE_MINUTES) {
  return helperEntries(ledger)
    .filter(([, helper]) => helper.acceptedAt && !helper.stoppedAt && now - Date.parse(helper.acceptedAt) > idleMinutes * 60_000)
    .map(([name, helper]) => ({ name, minutes: Math.floor((now - Date.parse(helper.acceptedAt)) / 60_000), brief: helper.brief ?? null }));
}

/** Stopped helpers whose recorded processes still run. Stopped QA agents once left dev servers running for 13 to 16 hours on a loaded machine. */
export function orphans(ledger, alive = isAlive, identityOf = readIdentity) {
  return helperEntries(ledger)
    .filter(([, helper]) => helper.stoppedAt)
    .map(([name, helper]) => ({ name, pids: (helper.pids ?? []).filter((pid) =>
      alive(pid) && helper.identities?.[pid] && identityOf(pid) === helper.identities[pid]) }))
    .filter((helper) => helper.pids.length > 0);
}

/** Live recorded identity still pending; a reused PID is foreign, while an unreadable one refuses cleanup. */
export function pendingRecordedProcess(target, alive = isAlive, identityOf = readIdentity) {
  if (!alive(target.pid)) return false;
  if (!target.identity) return true;
  const current = identityOf(target.pid);
  return !current || current === target.identity;
}

/** Pending private e2e cleanup records remain visible until their owned resource reconciliation succeeds. */
export function pendingE2eCleanups(lockDir = defaultLockDir(),
  { alive = isAlive, identityOf = readIdentity, holderOf = readHolder } = {}) {
  const dir = path.dirname(lockDir);
  let names;
  try { names = readdirSync(dir).filter((name) => /^e2e-cleanup-[a-zA-Z0-9_-]+\.json$/.test(name)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return names.map((name) => {
    let record;
    try {
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular record");
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch { record = {}; }
    if (record.state === "complete") return null;
    const owner = record.owner ?? {};
    const holder = holderOf(lockDir);
    const isCurrentRun = Number.isSafeInteger(owner.pid) && typeof owner.token === "string"
      && typeof owner.identity === "string" && owner.identity !== ""
      && name === `e2e-cleanup-${owner.token}.json`
      && alive(owner.pid) && identityOf(owner.pid) === owner.identity
      && holder?.pid === owner.pid && holder?.token === owner.token && holder?.identity === owner.identity;
    if (isCurrentRun) return null;
    const ownerName = owner.name ?? owner.writer ?? (path.basename(owner.worktree ?? "") || "unknown");
    const ticket = owner.ticket ?? /iss[-_](\d+)/i.exec(owner.worktree ?? "")?.[0]?.toUpperCase().replace("_", "-") ?? "unknown";
    return `LEFTOVER ${name} owner ${ownerName} ticket ${ticket}: pending e2e cleanup for ${record.project ?? "unknown project"}`;
  }).filter(Boolean);
}

/** Whether endProcesses may signal a pid: kill(-1) reaches every process the user owns and kill(0) the caller's own group. */
export function safePid(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

/** Parses recorded pids, refusing anything that is not an integer above 1. */
export function parsePids(texts) {
  const pids = texts.map(Number);
  if (pids.length === 0 || !pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) {
    throw new Error("pid needs one or more process ids above 1.");
  }
  return pids;
}

/** `alive`, `gone`, or `foreign` when the process exists but is not ours (EPERM). */
export function probe(pid, kill = defaultKill) {
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    return error?.code === "EPERM" ? "foreign" : "gone";
  }
}

/** Whether a process exists, ours or not. */
export function isAlive(pid) {
  return probe(pid) !== "gone";
}

/** The shared process-birth fingerprint, preserved under the helper module's existing API name. */
export const readIdentity = readProcessIdentity;

/** The process group id of `pid`, or null when it cannot be read. */
export function readGroupId(pid) {
  const result = spawnSync("ps", ["-o", "pgid=", String(pid)], { encoding: "utf8" });
  const group = Number(result.stdout?.trim());
  return result.status === 0 && Number.isSafeInteger(group) ? group : null;
}

/**
 * Ends `targets` ({ pid, group, identity }), SIGKILLs what outlives the
 * grace, and returns the pids still alive and ours. Unsafe and foreign pids
 * are never signalled; a pid is ours only while `identityOf` still returns
 * the identity recorded for it. `kill`, `groupOf` and `identityOf` are
 * injectable so tests can check every decision without sending a real signal.
 */
export async function endProcesses(targets, graceSeconds = DEFAULT_GRACE_SECONDS, { kill = defaultKill, groupOf = readGroupId, identityOf = readIdentity } = {}) {
  const owned = targets.filter((target) => safePid(target.pid));
  const same = (target) => typeof target.identity === "string" && target.identity !== "" && identityOf(target.pid) === target.identity;
  const live = () => owned.filter((target) => probe(target.pid, kill) === "alive" && same(target));
  const signal = (target, name) => {
    const { pid, group } = target;
    // Checked again here so no edit to the filter above can ever reach kill(-1).
    if (!(pid > 1)) return;
    // Re-read right before the signal: the pid may have been reused since the last check.
    if (!same(target)) return;
    const wholeGroup = group === true && groupOf(pid) === pid;
    try {
      kill(wholeGroup ? -pid : pid, name);
    } catch {
      // Already gone.
    }
  };
  for (const target of live()) signal(target, "SIGTERM");
  const deadline = Date.now() + graceSeconds * 1000;
  while (live().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  for (const target of live()) signal(target, "SIGKILL");
  const killDeadline = Date.now() + 2000;
  while (live().length > 0 && Date.now() < killDeadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return live().map((target) => target.pid);
}

function defaultKill(pid, name) {
  process.kill(pid, name);
}

/** Helper records in the ledger, excluding its reserved stack handoff map. */
export function helperEntries(ledger) {
  return Object.entries(ledger).filter(([name]) => name !== STACKS);
}

function currentPrState(repo, pr) {
  const result = spawnSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "state,mergedAt"],
    { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error("PR state could not be read; owned stack retained.");
  const value = JSON.parse(result.stdout);
  return value.mergedAt || ["CLOSED", "MERGED"].includes(value.state) ? "terminal" : "open";
}

/** Reconcile only terminal PR helpers recorded with a matching owner and resource witness. */
export async function reconcileTerminalHelpers(ledger, { prState = currentPrState, end = endProcesses,
  cleanup = removeOwnedDockerResources, alive = isAlive, identityOf = readIdentity } = {}) {
  const findings = [];
  let changed = false;
  for (const [name, helper] of helperEntries(ledger)) {
    if (helper.stoppedAt || helper.ending !== "pr-terminal") continue;
    const label = `${name} owner ${helper.owner ?? "unknown"} ticket ${helper.ticket ?? "unknown"}`;
    if (helper.kind === 'scratch') {
      findings.push(`LEFTOVER ${label}: scratch cannot use pr-terminal cleanup`);
      continue;
    }
    if (!helper.owner || !helper.ticket || !helper.repo || !helper.pr) {
      findings.push(`LEFTOVER ${label}: missing ending or ownership record`);
      continue;
    }
    let state;
    try { state = await prState(helper.repo, helper.pr); }
    catch { findings.push(`UNKNOWN ${label}: PR state unavailable`); continue; }
    if (state !== "terminal") continue;
    changed = true;
    const groups = new Set(helper.groups ?? []);
    const targets = (helper.pids ?? []).map((pid) => ({ pid, group: groups.has(pid), identity: helper.identities?.[pid] }));
    try {
      if (helper.project && helper.dockerResources?.project !== helper.project) {
        throw new Error("Compose resources and creation witnesses were not recorded.");
      }
      const survivors = await end(targets);
      if (survivors.length || targets.some((target) => pendingRecordedProcess(target, alive, identityOf))) {
        throw new Error("recorded process remains or changed identity");
      }
      if (helper.dockerResources) cleanup(helper.dockerResources);
      helper.stoppedAt = new Date().toISOString();
      helper.cleanupError = undefined;
    } catch (error) {
      helper.cleanupError = error instanceof Error ? error.message : String(error);
      findings.push(`LEFTOVER ${label}: ${helper.cleanupError}`);
    }
  }
  return { ledger, findings, changed };
}

/** Read the helper ledger, returning an empty ledger before its first write. */
export function read(orchDir) {
  const file = path.join(orchDir, LEDGER);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

/** Acquire the helper ledger lock and return its identity-checked release callback. */
export async function acquireLedgerLock(orchDir, { waitMs = LEDGER_WAIT_MS, clock = Date.now, onWait } = {}) {
  const dir = path.join(orchDir, 'helpers.lock');
  const owner = { pid: process.pid, identity: readIdentity(process.pid), token: randomUUID() };
  if (!owner.identity) throw new Error('helper ledger process identity is unreadable');
  const deadline = clock() + waitMs;
  while (clock() < deadline) {
    try {
      mkdirSync(dir);
      writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
      return () => {
        try {
          const saved = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8'));
          if (saved.token === owner.token) rmSync(dir, { recursive: true });
        } catch { /* Another owner keeps its lock. */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Even a peer that releases before its identity check invalidates pre-lock preparation.
      onWait?.();
      let saved;
      try { saved = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { saved = null; }
      const unclaimed = !saved && statSync(dir, { throwIfNoEntry: false });
      if (!saved && !unclaimed) continue;
      if (saved?.identity && readIdentity(saved.pid) === saved.identity
        || unclaimed && Date.now() - unclaimed.mtimeMs < 60_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      let current;
      try { current = JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { current = null; }
      if (current?.token !== saved?.token) continue;
      rmSync(dir, { recursive: true });
    }
  }
  throw new Error('helper ledger lock remained active; ownership record was not overwritten');
}

/** A cheap witness binds the checked bytes and path across the worktree read and ledger acquisition. */
function evidenceVersion(file) {
  const { dev, ino, size, ctimeNs, mtimeNs } = lstatSync(file, { bigint: true });
  return [realpathSync(file), dev, ino, size, ctimeNs, mtimeNs];
}

/** Read reviewer launch inputs before capturing the worktree the new helper will review. */
function prepareReviewerStart(orchDir, values, readInput, rememberVersion) {
  const runtime = values.runtime ?? "claude";
  const workerId = values["worker-id"];
  const pluginRoot = vibeRoot(values.worktree);
  const loadedSkill = loadedSkillEvidence(workerId, runtime, pluginRoot, "fleet-orchestrator", LoadBasis.InstalledAtSpawn);
  // Briefs may be symlinks. Bind the requested path and the bytes read from its resolved target.
  const requestedBrief = path.resolve(orchDir, values.brief);
  rememberVersion(requestedBrief);
  const briefPath = resolveHelperBrief(orchDir, values.brief);
  rememberVersion(briefPath);
  const bytes = readFileSync(briefPath);
  const problems = promptProblems({ loadedSkill }, bytes.toString("utf8"), { actorId: workerId, pluginRoot, worktree: values.worktree });
  if (problems.length) throw new Error(problems.join("; "));
  const capabilities = readInput(values.capabilities);
  graphAliases(JSON.parse(capabilities.text));
  const definition = readInput(values["agent-definition"]);
  if (agentFrontmatterName(definition.text) !== values.role) throw new Error("canonical agent definition does not name the requested role");
  return { workerId, role: values.role, agentDefinition: definition.fingerprint, capabilities: capabilities.fingerprint, loadedSkill,
    ...(runtime === "codex" ? { briefEvidence: { path: briefPath, sha256: createHash("sha256").update(bytes).digest("hex") } } : {}) };
}

/** Prepare only filesystem-dependent inputs. The locked transition still checks the live registration. */
function prepareTransition(action, entry, values, orchDir) {
  const versions = new Map();
  function rememberVersion(file) {
    if (!versions.has(file)) versions.set(file, evidenceVersion(file));
  }
  const inputs = new Map();
  function readInput(file) {
    if (!inputs.has(file)) {
      rememberVersion(file);
      inputs.set(file, readHelperInput(file));
    }
    return inputs.get(file);
  }
  let result;
  try {
    if (action === "final") {
      if (!entry?.startedAt || entry.stoppedAt || entry.finalizedAt || !entry.worktree || !entry.requiresFinal || !values.deliverable || !values.out
        || !values["session-id"] || !values["turn-id"]) throw new Error("final needs an active helper, worktree, deliverable, completed session/turn and output file");
      const completion = { sessionId: values["session-id"], turnId: values["turn-id"] };
      const event = values["completion-event"] ? readInput(values["completion-event"]) : null;
      if (event) {
        const problem = completionEventProblem(event.text, completion);
        if (problem) throw new Error(problem);
      }
      const deliverable = readInput(values.deliverable);
      if (!deliverable.text.trimEnd().endsWith(finalMarker(entry, completion))) throw new Error("helper deliverable lacks its FINAL marker");
      const source = sourceIdentity(entry.worktree);
      if (!sameSource(entry.source ?? {}, source)) throw new Error("helper source changed since start");
      result = { helper: entry.name, token: entry.finalToken, status: "FINAL", workerId: entry.workerId, source,
        completion, ...(event ? { completionEvidence: event.fingerprint } : {}), deliverable: deliverable.fingerprint };
    } else if (action === "accepted" || (action === "stopped" && entry?.acceptedAt && !entry.abandonedAt)) {
      // Older records can carry both timestamps. Recorded abandonment already permits cleanup.
      const reportFile = action === "accepted" ? values.report : entry.report?.path;
      if (action === "stopped" && (!reportFile || !isDeepStrictEqual(readInput(reportFile).fingerprint, entry.report))) {
        throw new Error("helper final report changed after acceptance");
      }
      const problem = verifyFinalReport(entry, reportFile, readInput, sourceIdentity);
      if (problem) throw new Error(problem);
      result = readInput(reportFile).fingerprint;
    } else if (action === "start") {
      const reviewer = FINAL_KINDS.has(values.kind) ? prepareReviewerStart(orchDir, values, readInput, rememberVersion) : {};
      result = { ...reviewer, ...(values.worktree ? { worktree: path.resolve(values.worktree), source: sourceIdentity(values.worktree) } : {}) };
    }
  } catch (error) {
    return () => { throw error; };
  }
  return () => {
    for (const [file, version] of versions) {
      if (!isDeepStrictEqual(version, evidenceVersion(file))) throw new Error("helper evidence changed during verification");
    }
    return result;
  };
}

/** PID and resource updates are independent of final evidence. Cleanup reads them from the locked entry. */
function preparationRecord(action, entry) {
  if (action === "start" || !entry) return entry;
  const { pids, groups, identities, dockerResources, ...registration } = entry;
  return registration;
}

/** After real contention, release the grant and reread all inputs within the original wait budget. */
async function lockWithFreshSource(orchDir, prepare) {
  if (!prepare) return { releaseLedger: await acquireLedgerLock(orchDir) };
  let waitMs = LEDGER_WAIT_MS;
  while (true) {
    const checkedInput = prepare();
    const started = Date.now();
    let collided = false;
    const releaseLedger = await acquireLedgerLock(orchDir, { waitMs, onWait: () => { collided = true; } });
    if (!collided) return { releaseLedger, checkedInput };
    releaseLedger();
    waitMs -= Date.now() - started;
  }
}

/** Identify a registration without putting its one-time FINAL token in a child process's arguments. */
export function registrationFingerprint(helper) {
  return createHash("sha256").update(helper.finalToken).digest("hex");
}

/** Atomically replace the private helper ledger. */
export function write(orchDir, ledger) {
  const file = path.join(orchDir, LEDGER);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}

/** Standing duties on the fleet board (board.json) that `name` owns. */
export function ownedDuties(orchDir, name) {
  const file = path.join(orchDir, "board.json");
  const duties = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).duties ?? {} : {};
  return Object.entries(duties).filter(([, duty]) => duty?.owner === name).map(([duty]) => duty);
}

function requireName(action, name) {
  if (!name) {
    throw new Error(`${action} needs a name.`);
  }
  if (name === STACKS) {
    throw new Error(`${name} is reserved.`);
  }
  return name;
}

async function main(argv) {
  const [workDir, action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      brief: { type: "string" },
      stack: { type: "string" },
      to: { type: "string" },
      "idle-minutes": { type: "string" },
      "grace-seconds": { type: "string" },
      group: { type: "boolean" },
      now: { type: "string" },
      owner: { type: "string" }, ticket: { type: "string" }, repo: { type: "string" }, pr: { type: "string" },
      "owner-token": { type: "string" },
      ending: { type: "string" }, project: { type: "string" },
      "ttl-seconds": { type: "string" },
      "compose-file": { type: "string" },
      "e2e-lock-dir": { type: "string" },
      worktree: { type: "string" }, report: { type: "string" },
      kind: { type: "string" },
      "worker-id": { type: "string" }, capabilities: { type: "string" },
      role: { type: "string" }, "agent-definition": { type: "string" },
      deliverable: { type: "string" }, out: { type: "string" }, "session-id": { type: "string" }, "turn-id": { type: "string" },
      "completion-event": { type: "string" }, runtime: { type: "string" },
      reason: { type: "string" }, "if-registration": { type: "string" },
      container: { type: "string", multiple: true }, volume: { type: "string", multiple: true }, network: { type: "string", multiple: true },
    },
  });
  if (!workDir || !["start", "pid", "resources", "final", "accepted", "abandoned", "stopped", "hand", "unhand", "status", "scratch-run"].includes(action)) {
    throw new Error("Usage: helpers.mjs <orchDir> start <name> [--kind reviewer|verifier|critic --brief <file> --worktree <dir> --worker-id <thread> --role <name> --agent-definition <file> --capabilities <file> [--runtime claude|codex]] | final|accepted|stopped|pid|resources|hand|unhand <name> | status");
  }
  const orchDir = resolveWorkDir(workDir).dir;
  if (action === 'scratch-run') {
    const name = positionals[0];
    if (!name || !values.owner || !values.ticket || !values.worktree || !values["compose-file"]) {
      throw new Error('scratch-run needs name, owner, ticket, worktree, TTL and Compose file');
    }
    const result = runScratchStack({ orchDir, name, owner: values.owner, ticket: values.ticket,
      worktree: values.worktree, ttlSeconds: Number(values["ttl-seconds"]), composeFile: values["compose-file"] });
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  }
  const checksSource = ["start", "final", "accepted", "stopped"].includes(action);
  const registered = checksSource ? read(orchDir)[positionals[0]] : undefined;
  const prepare = checksSource ? () => prepareTransition(action, registered, values, orchDir) : null;
  const { releaseLedger, checkedInput } = await lockWithFreshSource(orchDir, prepare);
  try {
  const ledger = read(orchDir);
  // Another transition may have replaced this registration while Git was reading it.
  if (checksSource && !isDeepStrictEqual(preparationRecord(action, registered), preparationRecord(action, ledger[positionals[0]]))) {
    throw new Error("helper registration changed while verifying its source; retry with its current record");
  }
  if ((action === "final" || action === "accepted") && ledger[positionals[0]]?.abandonedAt) {
    throw new Error("an abandoned helper cannot finalize or accept a report");
  }
  const now = values.now ? Date.parse(values.now) : Date.now();
  const at = new Date(now).toISOString();
  if (action === "status") {
    const reconciled = await reconcileTerminalHelpers(ledger);
    if (reconciled.changed) write(orchDir, ledger);
    for (const finding of reconciled.findings) process.stdout.write(`${finding}\n`);
    const dueScratch = helperEntries(ledger).filter(([, helper]) => helper.kind === 'scratch' && !helper.stoppedAt
      && now >= Date.parse(helper.expiresAt ?? ''));
    for (const [name, helper] of dueScratch) process.stdout.write(`SCRATCH-DUE ${name} owner ${helper.owner} ticket ${helper.ticket}\n`);
    const stop = stopCandidates(ledger, now, values["idle-minutes"] === undefined ? DEFAULT_IDLE_MINUTES : Number(values["idle-minutes"]));
    for (const helper of stop) {
      const meta = ledger[helper.name];
      process.stdout.write(`STOP ${helper.name} accepted ${helper.minutes}m ago${meta.owner ? `; owner ${meta.owner} ticket ${meta.ticket ?? "unknown"}` : ""}${helper.brief ? `; relaunch from ${helper.brief}` : ""}\n`);
    }
    const left = orphans(ledger);
    for (const helper of left) {
      const meta = ledger[helper.name];
      process.stdout.write(`ORPHAN ${helper.name} ${helper.pids.join(" ")} still running${meta.owner ? `; owner ${meta.owner} ticket ${meta.ticket ?? "unknown"}` : ""}\n`);
    }
    const active = helperEntries(ledger).filter(([, helper]) => !helper.stoppedAt).length;
    const pending = pendingE2eCleanups(values["e2e-lock-dir"] ?? defaultLockDir());
    for (const finding of pending) process.stdout.write(`${finding}\n`);
    process.stdout.write(`helpers: ${active} active, ${stop.length} to stop, ${left.length} orphaned\n`);
    return stop.length + left.length + reconciled.findings.length + dueScratch.length + pending.length === 0 ? 0 : 1;
  }
  const name = requireName(action, positionals[0]);
  const stacks = ledger[STACKS] ?? {};
  if (action === "hand" || action === "unhand") {
    if (action === "hand") {
      if (!values.to) {
        throw new Error("hand needs --to <guide>.");
      }
      stacks[name] = { guide: values.to, handedAt: at };
    } else {
      delete stacks[name];
    }
    ledger[STACKS] = stacks;
    write(orchDir, ledger);
    return 0;
  }
  if (action === "start") {
    const kind = values.kind ?? "other";
    if (ledger[name] && !ledger[name].stoppedAt) throw new Error('An active helper already owns this name; keep its project record');
    if (![...FINAL_KINDS, "other", "scratch"].includes(kind)) throw new Error("helper kind must be reviewer, verifier, critic, scratch or other");
    const ttlSeconds = Number(values["ttl-seconds"]);
    if (kind === "scratch" && (!values.owner || !values.ticket || !values.worktree || !values.project
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400)) {
      throw new Error("Scratch helper needs owner, ticket, worktree, empty project and TTL of 60 to 86400 seconds.");
    }
    if (kind !== "scratch" && values["ttl-seconds"] !== undefined) throw new Error("--ttl-seconds applies only to scratch helpers.");
    if (kind === 'scratch' && values.ending) throw new Error('Scratch helpers use TTL and terminal writer lease, not pr-terminal');
    if (FINAL_KINDS.has(kind) && (!values.brief || !values.worktree || !values["worker-id"] || !values.capabilities
      || !values.role || !values["agent-definition"])) throw new Error("reviewer, verifier and critic helpers need brief, worktree, worker ID, role, agent definition and capability record");
    if (FINAL_KINDS.has(kind) && helperEntries(ledger).some(([, other]) => other.requiresFinal && other.workerId === values["worker-id"])) {
      throw new Error("review helpers cannot share a native worker identity");
    }
    const runtime = values.runtime ?? "claude";
    if (!["claude", "codex"].includes(runtime)) throw new Error("--runtime must be claude or codex");
    // A QA rerun must never change the stack a human is testing on.
    if (values.stack && stacks[values.stack]) {
      process.stderr.write(`stack ${values.stack} is handed to ${stacks[values.stack].guide}; launch this helper on its own stack\n`);
      return 1;
    }
    if (values.ending && !ENDINGS.has(values.ending)) throw new Error("Unknown --ending; use pr-terminal.");
    if (values.ending === "pr-terminal" && (!values.owner || !values.ticket || !values.repo || !values.pr)) {
      throw new Error("A PR terminal helper needs owner, ticket, repository and PR.");
    }
    if (values.project) {
      if (helperEntries(ledger).some(([other, helper]) => other !== name && helper.project === values.project && !helper.stoppedAt)) {
        throw new Error("The Docker project is already reserved by another helper.");
      }
      const existing = captureOwnedDockerResources({ project: values.project });
      if (existing.containers.length || existing.volumes.length || existing.networks.length) {
        throw new Error("The requested Docker project has existing resources; it is not this helper's.");
      }
    }
    if (kind === 'scratch') registerScratchProgram(orchDir);
    ledger[name] = { name, kind, requiresFinal: FINAL_KINDS.has(kind), finalToken: randomUUID(), startedAt: at,
      ...(kind === "scratch" ? { ownerToken: randomUUID(), expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
        writerLease: captureScratchLease(orchDir, values.owner, values.worktree) } : {}),
      ...checkedInput(),
      ...(values.brief ? { brief: values.brief } : {}), ...(values.stack ? { stack: values.stack } : {}),
      ...(values.owner ? { owner: values.owner } : {}), ...(values.ticket ? { ticket: values.ticket } : {}),
      ...(values.repo ? { repo: values.repo } : {}), ...(values.pr ? { pr: values.pr } : {}),
      ...(values.ending ? { ending: values.ending } : {}), ...(values.project ? { project: values.project } : {}) };
  } else if (action === "resources") {
    const entry = ledger[name];
    if (!entry?.startedAt || entry.stoppedAt || !entry.owner || !entry.ticket) {
      throw new Error("Record Docker resources only for an active helper with owner and ticket.");
    }
    if (values.project && values.project !== entry.project) throw new Error("Docker project differs from the helper's start record.");
    const captured = captureOwnedDockerResources({ project: entry.project ?? null,
      ...(values.container ? { containers: values.container } : {}),
      ...(values.volume ? { volumes: values.volume } : {}),
      ...(values.network ? { networks: values.network } : {}) });
    if (!Number.isFinite(Date.parse(entry.startedAt))) throw new Error("Helper start has no parseable creation witness.");
    for (const kind of ["containers", "volumes", "networks"]) {
      for (const witness of captured[kind]) {
        if (!Number.isFinite(Date.parse(witness.created)) || Date.parse(witness.created) < Date.parse(entry.startedAt)) {
          throw new Error("Docker resource predates this helper; it was not started here.");
        }
        if (entry.kind === "scratch" && witness.ownerToken !== entry.ownerToken) {
          throw new Error("Scratch Docker resource lacks its creation-time owner token label.");
        }
      }
    }
    entry.dockerResources = captured;
  } else if (action === "pid") {
    const pids = parsePids(positionals.slice(1));
    const identities = Object.fromEntries(pids.map((pid) => [pid, readIdentity(pid)]));
    const unreadable = pids.filter((pid) => !identities[pid]);
    if (unreadable.length > 0) {
      throw new Error(`cannot read the start time and command of ${unreadable.join(" ")}; record only a running process this helper started.`);
    }
    const entry = ledger[name] ?? {};
    const groups = values.group ? [...new Set([...(entry.groups ?? []), ...pids])] : (entry.groups ?? []);
    ledger[name] = {
      ...entry,
      pids: [...new Set([...(entry.pids ?? []), ...pids])],
      identities: { ...(entry.identities ?? {}), ...identities },
      ...(groups.length > 0 ? { groups } : {}),
    };
  } else if (action === "final") {
    const entry = ledger[name];
    const report = checkedInput();
    const out = path.resolve(values.out);
    if (out === entry.worktree || out.startsWith(`${entry.worktree}${path.sep}`)) throw new Error("final report belongs outside the source worktree");
    writeFileSync(out, `${JSON.stringify(report)}\n`, { mode: 0o600, flag: "wx" });
    entry.finalReportPath = realpathSync(out);
    entry.finalizedAt = at;
    write(orchDir, ledger);
    return 0;
  } else if (action === "accepted") {
    const entry = ledger[name];
    ledger[name] = { ...entry, acceptedAt: at, report: checkedInput() };
  } else if (action === "abandoned") {
    const entry = ledger[name];
    if (!entry?.startedAt || entry.stoppedAt || !entry.requiresFinal || entry.acceptedAt) {
      throw new Error("abandoned needs an active unaccepted reviewer, verifier or critic helper");
    }
    if (values["if-registration"] !== undefined && values["if-registration"] !== registrationFingerprint(entry)) {
      throw new Error("helper registration changed before abandonment; its replacement was preserved");
    }
    if (!values.reason?.trim()) throw new Error("abandoned needs --reason <why the helper was superseded or stopped>");
    ledger[name] = { ...entry, abandonedAt: at, abandonReason: values.reason.trim() };
  } else {
    const entry = ledger[name] ?? {};
    if (entry.kind === 'scratch') {
      if (!values.owner && (now < Date.parse(entry.expiresAt ?? '') || !scratchLeaseTerminal(entry))) {
        throw new Error('Scratch stop requires elapsed TTL and terminal writer lease');
      }
      if (values.owner) {
        if (values.owner !== entry.owner) throw new Error('scratch stop owner differs from its recorded owner');
        if (!values["owner-token"] || values["owner-token"] !== entry.ownerToken) {
          throw new Error('scratch stop needs its recorded owner token');
        }
        const grace = values["grace-seconds"] === undefined ? DEFAULT_GRACE_SECONDS : Number(values["grace-seconds"]);
        const groups = new Set(entry.groups ?? []);
        const targets = (entry.pids ?? []).map((pid) => ({ pid, group: groups.has(pid), identity: entry.identities?.[pid] }));
        const survivors = await endProcesses(targets, grace);
        if (survivors.length || targets.some((target) => pendingRecordedProcess(target))) {
          process.stdout.write(`ALIVE ${name} ${survivors.join(" ")}\n`);
          return 1;
        }
      }
      const settled = reconcileExpiredScratchHelpers({ [name]: entry }, now,
        values.owner ? { explicit: true } : {});
      if (!entry.stoppedAt) throw new Error(settled.findings.join('; ') || 'Scratch ownership could not be reconciled');
      write(orchDir, ledger);
      return 0;
    }
    if (entry.requiresFinal && !entry.acceptedAt && !entry.abandonedAt) throw new Error("review helper has no accepted final deliverable or recorded abandonment");
    if (entry.acceptedAt) checkedInput();
    if (entry.project && entry.dockerResources?.project !== entry.project) {
      throw new Error("Compose resources and creation witnesses were not recorded.");
    }
    const owned = ownedDuties(orchDir, name);
    if (owned.length > 0) {
      for (const duty of owned) {
        process.stdout.write(`OWNS ${duty}; give it a new owner first: board.mjs <orchDir> duty ${duty} --owner <replacement>\n`);
      }
      return 1;
    }
    const grace = values["grace-seconds"] === undefined ? DEFAULT_GRACE_SECONDS : Number(values["grace-seconds"]);
    const groups = new Set(entry.groups ?? []);
    const targets = (entry.pids ?? []).map((pid) => ({ pid, group: groups.has(pid), identity: entry.identities?.[pid] }));
    const survivors = await endProcesses(targets, grace);
    const remaining = targets.filter((target) => pendingRecordedProcess(target)).map((target) => target.pid);
    if (survivors.length > 0 || remaining.length > 0) {
      process.stdout.write(`ALIVE ${name} ${[...new Set([...survivors, ...remaining])].join(" ")}\n`);
      return 1;
    }
    if (entry.dockerResources) removeOwnedDockerResources(entry.dockerResources);
    ledger[name] = { ...(ledger[name] ?? {}), stoppedAt: at };
  }
  write(orchDir, ledger);
  return 0;
  } finally { releaseLedger(); }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.exit(failScript(error, 2));
    }
  );
}
