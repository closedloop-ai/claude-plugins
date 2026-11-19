// An orchestrator chat's handoff to its successor, as one gated step (operator ruling, 2026-11-18: "each chat should
// have its own handoff file", and the handoff runbook belongs in a script). The outgoing chat runs
// `fleet-home.mjs handoff`: it writes the program's own handover.md, lists who must hear the successor's address,
// records each send and the stop of this chat's watcher and crons, and `--check` fails until all of that is recorded.
// The successor's `fleet-home.mjs resume` prints HANDOFF-INCOMPLETE until then.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const HANDOVER_FILE = "handover.md";
const STATE_FILE = "handoff.json";
export const OPERATOR = "operator";
export const Via = Object.freeze({ SendMessage: "sendmessage", Mesh: "mesh" });

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** The pid in the program's watch.lock, or NaN with no lock. */
function lockPid(dir) {
  const file = path.join(dir, "watch.lock", "pid");
  return Number(existsSync(file) ? readFileSync(file, "utf8").trim() : NaN);
}

function readState(dir) {
  return readJson(path.join(dir, STATE_FILE), null);
}

function saveState(dir, state) {
  writeFileSync(path.join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Each board writer not retired (`board.mjs retire`) with its address: the SendMessage name of a Claude writer, the
 * recorded thread of a Codex one.
 */
function liveWriters(dir) {
  const board = readJson(path.join(dir, "board.json"), {});
  return Object.entries(board.writers ?? {}).filter(([, row]) => !row?.retiredAt).map(([name, row]) => {
    const session = readJson(path.join(dir, "sessions", `${name}.json`), null) ?? readJson(path.join(dir, "sessions", `${name}.remote.json`), null);
    return { name, runtime: row.runtime ?? null, address: session?.threadId ? `codex thread ${session.threadId}` : name, pr: row.pr ?? null, status: row.status ?? null };
  });
}

/** Everyone the successor's address must reach: live writers, the peers this chat named, the program's peer orchestrators and the operator. */
export function recipients(dir, state) {
  const program = readJson(path.join(dir, "program.json"), {});
  const names = [...liveWriters(dir).map((writer) => writer.name), ...(state?.peers ?? []), ...(Array.isArray(program.peers) ? program.peers : []), OPERATOR];
  return [...new Set(names)];
}

/** What `--check` still needs, as lines; empty when the handoff is complete. */
export function handoffProblems(dir) {
  const state = readState(dir);
  if (!state) return [`HANDOFF-NOT-STARTED: run fleet-home.mjs handoff --successor <name> --mesh <id>`];
  // A completed handoff stays complete: writers the successor starts later are its own, not the outgoing chat's to tell.
  if (state.completedAt) return [];
  const writers = new Set(liveWriters(dir).map((writer) => writer.name));
  const problems = recipients(dir, state).filter((name) => !state.told?.[name])
    .map((name) => `NOT-TOLD ${name}: send it the successor ${state.successor.name} (Mesh ${state.successor.mesh}), then fleet-home.mjs handoff --told ${name} --via sendmessage|mesh${writers.has(name) ? `; a writer that has ended is retired instead: board.mjs <orchDir> retire ${name} --reason <why>` : ""}`);
  const watcher = readJson(path.join(dir, "watcher.json"), null);
  if (outgoingWatcher(state, watcher) && !watcher.exitedAt && lockPid(dir) === watcher.pid && state.watcherStopped?.pid !== watcher.pid) {
    problems.push(`WATCHER-RUNNING ${watcher.pid}: fleet-home.mjs handoff --stop-watcher`);
  }
  for (const id of state.crons ?? []) if (!state.cronsDeleted?.includes(id)) problems.push(`CRON-LIVE ${id}: delete it with CronDelete, then fleet-home.mjs handoff --cron-deleted ${id}`);
  return problems;
}

/** Write handover.md and the handoff record for `successor`; `notes` is the chat's own text (promises, first steps). */
export function startHandoff(dir, { successor, mesh, peers = [], crons = [], notes = "", now = new Date() }) {
  if (!successor || !mesh) throw new Error("handoff needs --successor <SendMessage name> and --mesh <Mesh id>");
  // A rerun for the same successor keeps what is already recorded; a new successor is a new handoff, told nobody yet.
  const prior = readState(dir);
  const same = prior?.successor?.name === successor && prior?.successor?.mesh === mesh ? prior : null;
  if (same?.completedAt) {
    // A completed handoff to the same successor only gets its file rewritten (new notes); it is not reopened.
    writeFileSync(path.join(dir, HANDOVER_FILE), handoverText(dir, same, notes));
    return same;
  }
  // A same-successor rerun keeps the first writtenAt, so a watcher the successor started in between stays its own.
  const state = { successor: { name: successor, mesh }, writtenAt: same?.writtenAt ?? now.toISOString(), peers: [...new Set([...(same?.peers ?? []), ...peers])],
    crons: [...new Set([...(same?.crons ?? []), ...crons])], told: same?.told ?? {}, cronsDeleted: same?.cronsDeleted ?? [], watcherStopped: same?.watcherStopped ?? null };
  saveState(dir, state);
  writeFileSync(path.join(dir, HANDOVER_FILE), handoverText(dir, state, notes));
  return state;
}

function handoverText(dir, state, notes) {
  const writers = liveWriters(dir);
  const board = readJson(path.join(dir, "board.json"), {});
  const questions = Object.entries(board.questions ?? {}).map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const attention = existsSync(path.join(dir, "attention.md")) ? readFileSync(path.join(dir, "attention.md"), "utf8").trim() : "";
  const watcher = readJson(path.join(dir, "watcher.json"), null);
  const helpers = existsSync(path.join(dir, "helpers")) ? readdirSync(path.join(dir, "helpers")).sort() : [];
  return [
    `# Handover (${state.writtenAt})`, "",
    `Successor: ${state.successor.name} (Mesh ${state.successor.mesh}). Run \`fleet-home.mjs handoff --check\` before acting; it lists anything not yet handed over.`, "",
    "## Writers and pull requests", ...(writers.length ? writers.map((writer) => `- ${writer.name} (${writer.runtime ?? "unknown runtime"}), address ${writer.address}${writer.pr ? `, PR ${writer.pr}` : ""}: ${writer.status ?? ""}`) : ["- none live"]), "",
    "## Peers told", ...recipients(dir, state).map((name) => `- ${name}`), "",
    "## Open operator questions", ...(questions.length ? questions : ["- none on the board"]), ...(attention ? ["", "attention.md:", "", attention] : []), "",
    "## Background workers", `- watcher: ${watcher?.pid ? `pid ${watcher.pid}` : "none recorded"}`, ...state.crons.map((id) => `- cron ${id}`), ...helpers.map((name) => `- helper ${name}`), "",
    "## Promises and first steps", notes.trim() || "- none recorded", "",
  ].join("\n");
}

/** Mark the handoff complete once nothing is missing, so later board changes never reopen it; returns whether it is. */
export function completeHandoff(dir, now = new Date()) {
  const state = readState(dir);
  if (!state || handoffProblems(dir).length > 0) return false;
  if (!state.completedAt) saveState(dir, { ...state, completedAt: now.toISOString() });
  return true;
}

/** Record that `name` was told the successor's address. */
export function recordTold(dir, name, via, now = new Date()) {
  const state = readState(dir);
  if (!state) throw new Error("HANDOFF-NOT-STARTED: run fleet-home.mjs handoff --successor <name> --mesh <id> first");
  if (!Object.values(Via).includes(via)) throw new Error(`--via is ${Object.values(Via).join(" or ")}`);
  state.told = { ...state.told, [name]: { via, at: now.toISOString() } };
  saveState(dir, state);
  return state;
}

/** Record a cron this chat deleted with CronDelete; a script cannot delete a Claude cron. */
export function recordCronDeleted(dir, id) {
  const state = readState(dir);
  if (!state) throw new Error("HANDOFF-NOT-STARTED: run fleet-home.mjs handoff --successor <name> --mesh <id> first");
  state.cronsDeleted = [...new Set([...(state.cronsDeleted ?? []), id])];
  saveState(dir, state);
  return state;
}

/** Stop this chat's watcher: only the pid watcher.json records, and only when watch.lock names the same pid. */
export function stopWatcher(dir, { kill = (pid) => process.kill(pid, "SIGTERM"), now = new Date() } = {}) {
  const state = readState(dir);
  if (!state) throw new Error("HANDOFF-NOT-STARTED: run fleet-home.mjs handoff --successor <name> --mesh <id> first");
  const watcher = readJson(path.join(dir, "watcher.json"), {});
  const pid = Number(watcher?.pid);
  if (!(pid > 1)) return { stopped: false, line: "WATCHER-NONE: no watcher recorded" };
  if (!outgoingWatcher(state, watcher)) throw new Error(`WATCHER-SUCCESSOR: watcher ${pid} started after the handoff was written; it is the successor's, not this chat's to stop`);
  const locked = lockPid(dir);
  if (locked !== pid) throw new Error(`WATCHER-MISMATCH: watcher.json names ${pid} but watch.lock names ${Number.isFinite(locked) ? locked : "none"}; stop nothing by guess`);
  try {
    kill(pid);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  state.watcherStopped = { pid, at: now.toISOString() };
  saveState(dir, state);
  return { stopped: true, line: `WATCHER-STOPPED ${pid}` };
}

/**
 * Whether the recorded watcher is the outgoing chat's: started no later than the handoff was first written. The
 * successor's own watcher is never this chat's to report or stop.
 */
function outgoingWatcher(state, watcher) {
  return Boolean(watcher?.pid) && !(Date.parse(watcher.startedAt ?? "") > Date.parse(state.writtenAt));
}
