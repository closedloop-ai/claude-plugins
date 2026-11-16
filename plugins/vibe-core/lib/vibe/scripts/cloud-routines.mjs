/**
 * The Claude routines vibe creates, and their removal. Every cloud run used to
 * create a new RemoteTrigger routine and leave it on the account for the
 * person to delete by hand (ISS-13998). RemoteTrigger has no delete action, so
 * vibe now owns one standing routine per machine, "vibe cloud worker", and
 * reuses it for every dispatch and validate: under a machine lock it updates
 * the routine's job_config and runs it, and binds the run by the session id the
 * run call returns (operator ruling, 2026-11-13, q1 and q3).
 *
 * The ledger lives outside any worktree, in the home folder's .codex/vibe/cloud,
 * so it survives a crash and a worktree removal. An intent is written before
 * every create, so a routine is on record before it exists; a create whose answer
 * was lost is found again by its token on the next sweep. Routines vibe
 * recorded elsewhere (receipts of older runs, a retired standing routine, one
 * retired with `routines --retire`) are queued for removal; an entry leaves the queue only when RemoteTrigger `get`
 * answers HTTP 404 for it. The removal itself is a headless `claude -p --chrome`
 * (operator ruling q5, option B) given only the recorded ids, told to delete those
 * on their claude.ai routine pages and touch nothing else; its report is never
 * trusted. A removal that does not happen stays recorded and is retried at the
 * next cloud run; the only output is the pending line on stderr. Nothing here
 * asks the person to delete a routine.
 */
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { acquire, release } from "./e2e-lock.mjs";
import { legacyRoutineName, RECEIPT_NAME, TERMINAL } from "./cloud-receipts.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

export const ROUTINE_NAME = "vibe cloud worker";
const LEDGER_SCHEMA = "vibe.cloud-routines/1";
/** A disabled yearly cron: create needs one schedule field, and a stored run_once_at would expire on a kept routine. */
const STANDING_CRON = "0 0 1 1 *";
/** The create prompt's only line; the run's own prompt replaces it through update before any run. */
const TOKEN_LINE = "VIBE_ROUTINE_TOKEN";
/** Run records kept; proved removals are all kept (ids and times only), so an old receipt is never re-queued. */
const KEEP_RUNS = 200;
const ROUTINE_ID = /^[\w-]+$/;
const RECEIPT_BYTES = 1024 * 1024;
const LOCK_POLL_MS = 1000;
/** An intent older than one RemoteTrigger command (90 s in cloud-worker.mjs), or whose process is gone, lost its create answer. */
const STALE_INTENT_MS = 90 * 1000;
/** A stale intent is looked up in this many sweeps at most; one never listed by then is dropped (its create made nothing). */
const INTENT_LOOKUPS = 5;
/** A run still marked started past this wall time ended without a mark (its poll gave up); the run limit is 35 minutes. */
const RUN_WALL_MS = 35 * 60 * 1000;
/**
 * The removal run's confinement, from Claude Code 2.1.323 (`claude --help` and its bundle): `--chrome` wires the
 * Claude in Chrome server into the dynamic MCP config, which `--strict-mcp-config` keeps while dropping every
 * configured server; `--setting-sources ""` loads no user, project or local settings (no allow rules, default mode
 * or hooks; flag and managed settings still apply); `--tools ""` removes every built-in tool; `--permission-mode
 * dontAsk` denies anything not allowed. `--restricted` and `--safe-mode` are not used: both skip the Chrome wiring.
 */
const CHROME = "mcp__claude-in-chrome__";
const CHROME_ALLOWED = ["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "list_connected_browsers", "select_browser", "navigate", "read_page", "find", "computer"].map((name) => CHROME + name).join(",");
const CHROME_DENIED = ["javascript_tool", "browser_batch", "form_input", "file_upload", "upload_image", "gif_creator", "get_page_text", "read_console_messages", "read_network_requests", "resize_window", "switch_browser"].map((name) => CHROME + name).join(",");
const REMOVAL_MS = 10 * 60 * 1000;
/** After a failed removal the Chrome run waits 30 minutes, doubling per attempt up to a day; `get` still runs each sweep. */
const BACKOFF_BASE_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const ROUTINE_BUSY = "CLOUD_ROUTINE_BUSY: another cloud run on this machine is still starting; try again when it has started";

export function pendingLine(count) {
  return `CLOUD_ROUTINE_REMOVAL_PENDING: ${count} routine(s) vibe created are still recorded for removal; vibe retries on the next cloud run`;
}

/** Machine-local folders under one home: the ledger and its lock. */
export function ledgerPath(home = os.homedir()) { return path.join(home, ".codex", "vibe", "cloud", "routines.json"); }
export function routineLockDir(home = os.homedir()) { return path.join(home, ".codex", "vibe", "locks", "cloud-routine"); }

function emptyLedger() { return { schema: LEDGER_SCHEMA, standing: null, intents: [], removal: [], removed: [], runs: [], connectorRefreshes: [] }; }

/** The ledger, or an empty one when none exists; an unreadable or unknown one is refused, never overwritten. */
export function readLedger(home = os.homedir()) {
  const file = ledgerPath(home);
  if (!existsSync(file)) return emptyLedger();
  let ledger;
  try { ledger = regularJson(file); } catch { ledger = null; }
  if (ledger?.schema !== LEDGER_SCHEMA) throw new Error(`${file} is not a ${LEDGER_SCHEMA} ledger`);
  return { ...emptyLedger(), ...ledger };
}

function writeLedger(home, ledger) {
  writeAtomic(ledgerPath(home), { ...ledger, runs: ledger.runs.slice(-KEEP_RUNS) });
}

/** True only when `token` is an intent this ledger recorded before its create was sent. */
export function hasIntent(home, token) {
  try { return typeof token === "string" && readLedger(home).intents.some((intent) => intent.token === token); }
  catch { return false; }
}

/** The routines vibe will retry removing: its queued removals. */
export function pendingCount(ledger) { return ledger.removal.length; }

/** Run `fn` holding the machine's routine lock; a wait past `waitMs` refuses with CLOUD_ROUTINE_BUSY. */
async function withRoutineLock(home, waitMs, fn) {
  const lockDir = routineLockDir(home);
  const owner = { pid: process.pid, token: randomUUID(), purpose: "cloud-routine" };
  const attempt = await acquire(lockDir, owner, { waitSeconds: Math.max(0, waitMs) / 1000, pollMs: Math.min(LOCK_POLL_MS, Math.max(1, waitMs)) });
  if (!attempt.acquired) throw Object.assign(new Error(ROUTINE_BUSY), { code: "CLOUD_ROUTINE_BUSY" });
  try { return await fn(); }
  finally { release(lockDir, owner); }
}

function userEvent(content) {
  return { data: { uuid: randomUUID(), session_id: randomUUID(), type: "user", parent_tool_use_id: null, message: { role: "user", content } } };
}

function queueRemoval(ledger, entry) {
  if (!ROUTINE_ID.test(entry.id ?? "") || ledger.standing?.id === entry.id) return false;
  if (ledger.removal.some((item) => item.id === entry.id) || ledger.removed.some((item) => item.id === entry.id)) return false;
  ledger.removal.push({ attempts: 0, lastAttemptAt: null, lastError: null, recordedAt: new Date().toISOString(), ...entry });
  return true;
}

function retireStanding(ledger) {
  const old = ledger.standing;
  ledger.standing = null;
  if (old) queueRemoval(ledger, { id: old.id, name: old.name ?? ROUTINE_NAME, reason: "retired-standing", source: "ledger" });
}

/** Create the standing routine with its intent on record first; a refused (4xx) create drops the intent. */
function createStanding(ledger, { home, remote, ccr, environment, refusal }) {
  const token = randomUUID();
  ledger.intents.push({ token, name: ROUTINE_NAME, requestedAt: new Date().toISOString(), pid: process.pid });
  writeLedger(home, ledger);
  let created;
  try {
    created = remote("create", { body: {
      name: ROUTINE_NAME, enabled: false, cron_expression: STANDING_CRON,
      job_config: { ccr: { ...ccr, events: [userEvent(`${TOKEN_LINE} ${token}`)] } },
    } }, { intent: token, home });
  } catch (error) {
    if (error?.httpStatus >= 400 && error.httpStatus < 500) {
      ledger.intents = ledger.intents.filter((intent) => intent.token !== token);
      writeLedger(home, ledger);
    }
    throw refusal ? refusal(error) : error;
  }
  const id = created?.trigger?.id;
  if (!id) throw new Error("RemoteTrigger create returned no routine id");
  ledger.intents = ledger.intents.filter((intent) => intent.token !== token);
  ledger.standing = {
    id, name: ROUTINE_NAME, environmentId: environment.id, createdAt: new Date().toISOString(),
    // Connector descriptors exist only in a create answer; an allow-listed run attaches them by update.
    connectors: Array.isArray(created.trigger.mcp_connections) ? created.trigger.mcp_connections : null,
  };
  writeLedger(home, ledger);
  return ledger.standing;
}

/** The descriptors an allow list names, or null when the recorded ones do not hold every name. */
function allowedConnectors(standing, allowlist) {
  if (!Array.isArray(standing?.connectors)) return null;
  const allowed = allowlist.map((name) => standing.connectors.find((entry) => entry?.name?.toLowerCase() === name));
  return allowed.some((entry) => !entry) ? null : allowed;
}

/** The update body: this run's job_config plus its connector state. */
function updateBody(ccr, brief, connectors) {
  const body = { job_config: { ccr: { ...ccr, events: [userEvent(brief)] } } };
  return connectors.length === 0 ? { ...body, clear_mcp_connections: true } : { ...body, mcp_connections: connectors };
}

function confirmConnectors(updated, allowlist) {
  const names = updated?.trigger?.mcp_connections;
  if (allowlist.length === 0) {
    if (!Array.isArray(names) || names.length !== 0) throw new Error("Claude routine connector clearing was not confirmed; run refused");
    return;
  }
  if (JSON.stringify(names?.map((entry) => entry.name?.toLowerCase())) !== JSON.stringify(allowlist)) throw new Error("Claude routine connector state did not match the explicit allow list; run refused");
}

/**
 * Run one brief on this machine's standing routine: create it once (intent first), update its job_config,
 * run it, and record the run's session id in the ledger before the lock is released.
 */
export async function runOnStanding({ remote, home = os.homedir(), environment, ccr, brief, allowlist = [], label, waitMs, refusal }) {
  return withRoutineLock(home, waitMs, () => {
    const ledger = readLedger(home);
    let standing = ledger.standing;
    const wanted = JSON.stringify([...allowlist].sort());
    const noDetails = standing && allowlist.length > 0 && !Array.isArray(standing.connectors);
    const staleDetails = standing && allowlist.length > 0 && !noDetails && !allowedConnectors(standing, allowlist) && !ledger.connectorRefreshes.includes(wanted);
    if (noDetails || staleDetails) {
      // Only a create answer carries the account's connector details: make one replacement with them attached and
      // queue the old routine. Recorded details that lack a connector are refreshed once per allow list.
      if (staleDetails) ledger.connectorRefreshes.push(wanted);
      retireStanding(ledger);
      writeLedger(home, ledger);
      standing = null;
    }
    standing ??= createStanding(ledger, { home, remote, ccr, environment, refusal });
    // An allow-listed connector is set on the same routine through update; one a fresh create did not attach is refused.
    const connectorsFor = (routine) => {
      if (allowlist.length === 0) return [];
      const allowed = allowedConnectors(routine, allowlist);
      if (!allowed) throw new Error("approved ClosedLoop connector was not attached to the account; run refused");
      return allowed;
    };
    let updated;
    try { updated = remote("update", { trigger_id: standing.id, body: updateBody(ccr, brief, connectorsFor(standing)) }); }
    catch (error) {
      if (error?.httpStatus !== 404) throw error;
      // The standing routine is gone from the account: that is its proof of removal; make a new one.
      ledger.removed.push({ id: standing.id, provedAt: new Date().toISOString() });
      ledger.standing = null;
      standing = createStanding(ledger, { home, remote, ccr, environment, refusal });
      updated = remote("update", { trigger_id: standing.id, body: updateBody(ccr, brief, connectorsFor(standing)) });
    }
    confirmConnectors(updated, allowlist);
    const started = remote("run", { trigger_id: standing.id });
    const runId = started?.run_id ?? started?.run?.id ?? started?.session_id;
    if (!runId) throw new Error("RemoteTrigger run returned no run or session id");
    const sessionId = started?.session_id ?? null;
    ledger.runs.push({ runId, sessionId, routineId: standing.id, label: label ?? null, startedAt: new Date().toISOString(), status: "started", maxWallMs: waitMs });
    writeLedger(home, ledger);
    return { routineId: standing.id, runId, sessionId };
  });
}

/** Mark a recorded run imported, abandoned or finished; an unknown run id changes nothing. */
export async function markRun(home, runId, status, waitMs) {
  return withRoutineLock(home, waitMs, () => {
    const ledger = readLedger(home);
    const run = ledger.runs.find((entry) => entry.runId === runId);
    if (!run) return false;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    writeLedger(home, ledger);
    return true;
  });
}

/** Every Git metadata folder of the repository holding `worktree`: the common one and each linked worktree's. */
function gitDirs(worktree) {
  const result = spawnSync("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return [];
  const common = result.stdout.trim();
  const linked = path.join(common, "worktrees");
  let names = [];
  try { names = readdirSync(linked); } catch { /* no linked worktrees */ }
  return [common, ...names.map((name) => path.join(linked, name))];
}

/** Routine ids that ended runs of older vibe versions recorded in this repository's receipts. */
function legacyRoutines(worktree) {
  if (typeof worktree !== "string" || !worktree) return [];
  const found = [];
  for (const dir of gitDirs(worktree)) {
    let files = [];
    try { files = readdirSync(dir).filter((name) => RECEIPT_NAME.test(name)); } catch { continue; }
    for (const name of files) {
      try {
        const file = path.join(dir, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > RECEIPT_BYTES) continue;
        const receipt = JSON.parse(readFileSync(file, "utf8"));
        // A run still in flight keeps its routine until it ends; poll reads that routine's runs.
        if (receipt?.provider === "claude" && ROUTINE_ID.test(receipt.routineId ?? "") && TERMINAL.has(receipt.status)) {
          found.push({ id: receipt.routineId, name: legacyRoutineName(name), reason: "legacy-receipt", source: name });
        }
      } catch { /* an unreadable receipt names nothing */ }
    }
  }
  return found;
}

function notFound(remote, id) {
  try { remote("get", { trigger_id: id }); return { gone: false, error: null }; }
  catch (error) { return error?.httpStatus === 404 ? { gone: true, error: null } : { gone: false, error: String(error?.message ?? error).split("\n")[0] }; }
}

/**
 * Drop every queued routine `get` proves gone. A Chrome removal attempt (`attempts`, `lastAttemptAt`, which the
 * backoff reads) is counted only on an entry `counted` names, after the Chrome run had it; a check with no
 * Chrome run (`routines --confirm`) records only `lastCheckedAt`.
 */
function prove(ledger, remote, { counted = () => false, at = new Date() } = {}) {
  const proved = [];
  const now = at.toISOString();
  ledger.removal = ledger.removal.filter((entry) => {
    const { gone, error } = notFound(remote, entry.id);
    if (gone) {
      proved.push(entry.id);
      ledger.removed.push({ id: entry.id, provedAt: now });
      return false;
    }
    entry.lastCheckedAt = now;
    if (counted(entry)) Object.assign(entry, { attempts: (entry.attempts ?? 0) + 1, lastAttemptAt: now, lastError: error ?? "the routine still answers get" });
    return true;
  });
  return proved;
}

/** True while a failed removal's backoff window is open: 30 minutes, doubling per attempt, at most a day. */
function inBackoff(entry, now) {
  const last = Date.parse(entry.lastAttemptAt ?? "");
  if (!(entry.attempts > 0) || !Number.isFinite(last)) return false;
  return now - last < Math.min(BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), BACKOFF_MAX_MS);
}

/**
 * A run on that routine that has not ended: the routine is kept until it does, like a legacy receipt in flight. A
 * run still marked started past its wall time ended unmarked (its poll gave up), so it no longer holds the routine.
 */
function inFlight(ledger, id, now) {
  return ledger.runs.some((run) => run.routineId === id && run.status === "started"
    && now - Date.parse(run.startedAt ?? "") < (Number.isFinite(run.maxWallMs) ? run.maxWallMs : RUN_WALL_MS));
}

/** The first prompt a listed routine carries, in either body form the API returns. */
function firstPrompt(routine) {
  const text = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((item) => item?.text ?? "").join("") : "";
  return [
    text(routine?.job_config?.ccr?.events?.[0]?.data?.message?.content),
    text(routine?.session_request?.events?.[0]?.payload?.message?.content),
    typeof routine?.derived_state?.prompt === "string" ? routine.derived_state.prompt : "",
  ];
}

function processGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code !== "EPERM"; }
}

/**
 * Find the routine of each stale intent (its create answer was lost) by its token on the first list page (the
 * RemoteTrigger list takes no cursor): with no standing routine it becomes the standing one, otherwise it is queued
 * for removal. An intent not found is looked for again at each sweep, at most INTENT_LOOKUPS times, then dropped.
 */
function resolveIntents(ledger, remote, now) {
  const stale = ledger.intents.filter((intent) => processGone(intent.pid) || now - Date.parse(intent.requestedAt ?? "") > STALE_INTENT_MS);
  if (stale.length === 0) return;
  let routines;
  try { routines = remote("list", {})?.data ?? []; } catch { return; }
  for (const intent of stale) {
    const line = `${TOKEN_LINE} ${intent.token}`;
    const routine = routines.find((item) => firstPrompt(item).some((prompt) => prompt.trim() === line));
    if (!ROUTINE_ID.test(routine?.id ?? "")) {
      intent.lookups = (intent.lookups ?? 0) + 1;
      if (intent.lookups >= INTENT_LOOKUPS) ledger.intents = ledger.intents.filter((entry) => entry.token !== intent.token);
      continue;
    }
    ledger.intents = ledger.intents.filter((entry) => entry.token !== intent.token);
    if (ledger.standing?.id === routine.id) continue;
    if (!ledger.standing) {
      ledger.standing = {
        id: routine.id, name: ROUTINE_NAME, environmentId: routine.job_config?.ccr?.environment_id ?? null, createdAt: intent.requestedAt,
        connectors: Array.isArray(routine.mcp_connections) ? routine.mcp_connections : null,
      };
      ledger.removal = ledger.removal.filter((entry) => entry.id !== routine.id);
    } else queueRemoval(ledger, { id: routine.id, name: ROUTINE_NAME, reason: "lost-create", source: "ledger intent" });
  }
}

/** The removal brief: only the given recorded ids, each on its own routine page, nothing else touched. */
function removalBrief(entries) {
  // The name comes from the account (a routine's own name): quoted as JSON, so it stays one quoted value.
  const lines = entries.map(({ id, name }) => `- ${id}: open https://claude.ai/code/routines/${id}; its name should be ${JSON.stringify(name ?? ROUTINE_NAME)}`);
  return [
    "Delete these Claude Code routines, which vibe created and recorded, in the Chrome browser that is already signed in to claude.ai. Use only the Chrome tools.",
    lines.join("\n"),
    "For each one: open its page; if the page does not show a routine with that id, or shows another name, leave it and go to the next. Otherwise use the page's Delete for that routine and confirm it. Do nothing else: do not open, change, run or delete any other routine, page or setting, and never sign in, create an account or type a credential.",
    "End with one line per id: REMOVED <id>, or LEFT <id> <why>.",
  ].join("\n\n") + "\n";
}

/**
 * The removal executor (operator ruling q5, option B): one headless `claude -p --chrome` confined to the Claude in
 * Chrome tools removal needs (see CHROME above), run from the system temp folder, given only the recorded ids on
 * stdin and bounded by its own timeout. A run that cannot start, fails or times out (no Chrome connection
 * included) is a removal failure; the sweep trusts only `get` afterwards either way.
 */
export function chromeRemoval({ claude = "claude", cwd = os.tmpdir(), run = spawnSync, timeoutMs = REMOVAL_MS } = {}) {
  return async (entries) => {
    const recorded = entries.filter((entry) => ROUTINE_ID.test(entry?.id ?? ""));
    if (recorded.length === 0) return;
    const args = ["-p", "--no-session-persistence", "--chrome", "--strict-mcp-config", "--setting-sources", "", "--tools", "",
      "--permission-mode", "dontAsk", "--allowedTools", CHROME_ALLOWED, "--disallowedTools", CHROME_DENIED];
    const result = run(claude, args, { cwd, input: removalBrief(recorded), encoding: "utf8", timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`claude --chrome exited ${result.status ?? result.signal}: ${String(result.stderr || result.stdout || "").trim().split("\n")[0]}`);
  };
}

/** No executor: queued routines are only proved by `get` (`routines --confirm`). */
export const NO_EXECUTOR = null;

/**
 * Resolve lost creates, queue legacy routines, drop the ones `get` proves gone, hand the rest to the executor
 * (except one still serving a run, or inside its backoff window), prove again, and record each failure for the
 * next run. Never throws: a removal problem never stops a cloud run.
 */
export async function sweepRemovals({ home = os.homedir(), remote, worktree, executor = chromeRemoval(), waitMs = 60_000, now = Date.now, stderr = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const outcome = { proved: [], pending: 0 };
  try {
    let queued = [];
    await withRoutineLock(home, waitMs, () => {
      const ledger = readLedger(home);
      resolveIntents(ledger, remote, now());
      for (const entry of legacyRoutines(worktree)) queueRemoval(ledger, entry);
      outcome.proved.push(...prove(ledger, remote, { at: new Date(now()) }));
      queued = ledger.removal.filter((entry) => !inFlight(ledger, entry.id, now()) && !inBackoff(entry, now()))
        .map(({ id, name }) => ({ id, name, url: `https://claude.ai/code/routines/${id}` }));
      writeLedger(home, ledger);
      outcome.pending = pendingCount(ledger);
    });
    if (queued.length > 0 && executor) {
      let failure = null;
      try { await executor(queued); } catch (error) { failure = String(error?.message ?? error).split("\n")[0]; }
      const handed = new Set(queued.map(({ id }) => id));
      await withRoutineLock(home, waitMs, () => {
        const ledger = readLedger(home);
        outcome.proved.push(...prove(ledger, remote, { counted: (entry) => handed.has(entry.id), at: new Date(now()) }));
        if (failure) for (const entry of ledger.removal) if (handed.has(entry.id)) entry.lastError = failure;
        writeLedger(home, ledger);
        outcome.pending = pendingCount(ledger);
      });
    }
  } catch {
    try { outcome.pending = pendingCount(readLedger(home)); } catch { /* the line below still reports what is known */ }
  }
  if (outcome.pending > 0) stderr(pendingLine(outcome.pending));
  return outcome;
}

/**
 * Queue routine `id` for removal after one `get` shows a name starting "vibe cloud worker" (a routine made for
 * vibe outside a cloud run, such as a probe); its name goes into the removal brief like every entry. It is never
 * made standing, and a retired standing routine stops being one. A routine `get` answers 404 for is already gone:
 * nothing is recorded and `{ gone: true }` is returned.
 */
export async function retireRoutine({ home = os.homedir(), remote, id, waitMs = 60_000 }) {
  if (!ROUTINE_ID.test(id ?? "")) throw new Error("a routine id is required");
  return withRoutineLock(home, waitMs, () => {
    let trigger;
    try {
      const answer = remote("get", { trigger_id: id });
      trigger = answer?.trigger ?? answer;
    } catch (error) {
      if (error?.httpStatus === 404) return { id, gone: true };
      throw error;
    }
    if (typeof trigger?.name !== "string" || !trigger.name.startsWith(ROUTINE_NAME)) throw new Error(`routine ${id} is not named ${ROUTINE_NAME}`);
    const ledger = readLedger(home);
    if (ledger.standing?.id === id) retireStanding(ledger);
    else queueRemoval(ledger, { id, name: trigger.name, reason: "retired", source: "routines --retire" });
    writeLedger(home, ledger);
    return { id, gone: false, name: trigger.name };
  });
}

/** Record routine `id` as this machine's standing routine after `get` shows it is named "vibe cloud worker". */
export async function adoptStanding({ home = os.homedir(), remote, id, waitMs = 60_000 }) {
  if (!ROUTINE_ID.test(id ?? "")) throw new Error("a routine id is required");
  return withRoutineLock(home, waitMs, () => {
    const answer = remote("get", { trigger_id: id });
    const trigger = answer?.trigger ?? answer;
    if (trigger?.name !== ROUTINE_NAME) throw new Error(`routine ${id} is not named ${ROUTINE_NAME}`);
    const ledger = readLedger(home);
    if (ledger.standing?.id !== id) retireStanding(ledger);
    ledger.standing = { id, name: ROUTINE_NAME, environmentId: trigger.job_config?.ccr?.environment_id ?? null, createdAt: trigger.created_at ?? new Date().toISOString(), connectors: null };
    ledger.removal = ledger.removal.filter((entry) => entry.id !== id);
    writeLedger(home, ledger);
    return ledger;
  });
}
