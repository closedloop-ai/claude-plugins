import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentityStatus, readProcessIdentity } from "../../../shared/process-identity.mjs";
import { acquire, release } from "./e2e-lock.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

// A standing routine owns its configuration and its current provider run until the run is terminal.
export const CLOUD_VALIDATION_CAPACITY = 1;
// An accepted run logs its launch marker within minutes. Past this window a launch whose launcher is gone, that no
// provider run acknowledged and that every provider read proved absent is reclaimed, so the queue never waits on it forever.
export const LAUNCH_WINDOW_MS = 10 * 60 * 1000;
const BUSY = "CLOUD_VALIDATION_QUEUE_TIMEOUT";
const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "archived"]);
// Recovery's answers when the provider proves nothing: every read succeeded, or a read threw.
const UNPROVEN = new Set(["unknown", "unreadable"]);

function identityKey(account) {
  return createHash("sha256").update(account).digest("hex");
}

function queuesDir(home) { return path.join(home, ".codex", "vibe", "cloud", "validation-queues"); }

function readQueue(file) {
  if (!existsSync(file)) return { version: 1, active: null, queued: [], abandoned: [] };
  const state = regularJson(file);
  if (state?.version !== 1 || !Array.isArray(state.queued) || !Array.isArray(state.abandoned)) throw new Error("cloud validation queue has an unsupported record");
  return state;
}

/** Change one account's queue under its lock. */
async function updateQueue(file, change) {
  const lock = path.join(path.dirname(file), "queue.lock");
  const holder = { pid: process.pid, token: randomUUID(), purpose: "cloud-validation-queue" };
  const locked = await acquire(lock, holder, { waitSeconds: 5, pollMs: 10 });
  if (!locked.acquired) throw new Error("cloud validation queue state is busy; retry the exact request");
  try {
    const current = readQueue(file);
    const answer = change(current);
    writeAtomic(file, current);
    return answer;
  } finally { release(lock, holder); }
}

/** A queue entry's launcher is alive unless it has no pid or its pid and recorded start time prove it gone. */
function launcherAlive(entry, identityOf) {
  return Boolean(entry?.pid) && processIdentityStatus(entry.pid, entry.identity, { identityOf }) !== "dead";
}

function abandonedRecord(entry, reason) {
  return { key: entry.key, reason, ...(entry.launch?.sessionId ? { sessionId: entry.launch.sessionId } : {}) };
}

/** Serialize local admission state for one pinned Claude account and preserve an interrupted running reservation. */
export async function withCloudValidationAdmission({ home, account, key, receipt, metadata, timeoutMs, signal, recover, now = Date.now,
  wait = (ms, currentSignal) => delay(ms, undefined, { signal: currentSignal }), sleepMs = 500,
  drainUnbound = false, report = (line) => process.stderr.write(`${line}\n`), identityOf = readProcessIdentity, launchWindowMs = LAUNCH_WINDOW_MS,
}, action) {
  const queues = queuesDir(home);
  // The first verified pin must wait for any earlier unbound provider run, including an interrupted launch.
  if (!drainUnbound && account !== "unbound-validation" && existsSync(path.join(queues,identityKey("unbound-validation"),"queue.json"))) {
    await withCloudValidationAdmission({home, account:"unbound-validation", key:"drain:"+account+":"+key, receipt, metadata,
      timeoutMs,signal,recover,now,wait,sleepMs,report,identityOf,launchWindowMs,drainUnbound:true},async()=>{});
  }
  const dir = path.join(queues,identityKey(account));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "queue.json");
  const owner = { token: randomUUID(), pid: process.pid, identity: identityOf(process.pid), key, receipt, metadata };
  const deadline = now() + timeoutMs;
  if (!owner.identity) throw new Error("cloud validation could not determine its exact queue process identity");
  report(`CLOUD_VALIDATION_CAPACITY ${CLOUD_VALIDATION_CAPACITY}: one active validation per account; excess requests wait in order`);
  const alive = (entry) => launcherAlive(entry, identityOf);
  const update = (change) => updateQueue(file, change);

  await update((state) => {
    const previous = state.queued.find((entry) => entry.key === key);
    if (previous && alive(previous)) throw new Error("CLOUD_VALIDATION_BUSY: this exact request is queued already");
    if (previous) Object.assign(previous, owner);
    else state.queued.push(owner);
  });
  let selected = false;
  let unresolved = false;
  try {
    while (!selected) {
      signal?.throwIfAborted();
      const active = await update((state) => {
        const gone = state.queued.filter((entry) => entry.token !== owner.token && !alive(entry));
        state.queued = state.queued.filter((entry) => !gone.includes(entry));
        state.abandoned = [...state.abandoned, ...gone.map(({ key: queuedKey }) => ({ key: queuedKey, reason: "owner exited before launch" }))].slice(-200);
        if (!state.active && state.queued[0]?.token === owner.token) {
          state.queued.shift();
          state.active = { ...owner, phase: "reserved" };
          selected = true;
        }
        return state.active;
      });
      if (selected) break;
      if (active && !alive(active)) {
        const disposition = active.phase === "reserved" ? "terminal" : await recover(active);
        const launch = active.phase === "launching";
        const recorded = existsSync(active.receipt) ? regularJson(active.receipt) : null;
        // A run the provider acknowledged, or a receipt, holds the account until the provider ends it, however old.
        // Only a launch with neither, past its window, whose every provider read proved nothing, is reclaimed.
        const reclaim = launch && !active.launch?.runId && recorded === null && disposition === "unknown" &&
          !(now() - Date.parse(active.launchingAt ?? active.launch?.startedAt) < launchWindowMs);
        const identical = !drainUnbound && active.key === key && active.receipt === receipt;
        // The identical request adopts the run its receipt names, active or launched but not yet listed or readable.
        const resume = identical && recorded?.status !== "abandoned" &&
          (disposition === "active" || (launch && UNPROVEN.has(disposition) && recorded !== null));
        if (disposition === "terminal" || resume || reclaim) await update((state) => {
          if (state.active?.token !== active.token) return;
          if (resume) {
            state.queued = state.queued.filter((entry) => entry.token !== owner.token);
            state.active = { ...owner, phase: active.phase, ...(active.launch ? { launch: active.launch, launchingAt: active.launchingAt } : {}) };
            selected = true;
            return;
          }
          if (reclaim) state.abandoned = [...state.abandoned, abandonedRecord(active, "launcher exited during launch; no provider run was proven")].slice(-200);
          state.active = null;
        });
      }
      if (selected) break;
      if (now() >= deadline) throw Object.assign(new Error(`${BUSY}: this request did not launch; retry the same request after the active reservation settles`), { code: BUSY });
      await wait(Math.min(sleepMs, Math.max(1, deadline - now())), signal);
    }
    // Called before the provider run with its launch nonce, and again with the run and session ids the moment it is acknowledged.
    const launching = (launch, requirements) => update((state) => {
      if (state.active?.token !== owner.token) throw new Error("cloud validation admission no longer belongs to this request");
      state.active.phase = "launching";
      state.active.launchingAt ??= new Date(now()).toISOString();
      if (launch) state.active.launch = launch;
      if (requirements?.outcomeTransport) state.active.metadata={...state.active.metadata,outcomeTransport:requirements.outcomeTransport};
      if (requirements?.managedHost === true) state.active.metadata = {...state.active.metadata,managedHost:true};
    });
    return await action({ launching });
  } catch (error) {
    unresolved = error?.launchUncertain || ["CLOUD_CALL_TIMEOUT", "CLOUD_RUN_NOT_CREATED"].includes(error?.code);
    throw error;
  } finally {
    await update((state) => {
      state.queued = state.queued.filter((entry) => entry.token !== owner.token);
      if (state.active?.token !== owner.token) return;
      if (drainUnbound) { state.active = null; return; }
      const latest = existsSync(receipt) ? regularJson(receipt) : null;
      if (latest && !TERMINAL.has(latest.status)) Object.assign(state.active, { phase: "running", pid: null, identity: null });
      else if (!latest && unresolved && state.active.phase === "launching") Object.assign(state.active, { pid: null, identity: null });
      else state.active = null;
    });
  }
}

/** A queue entry as `abandon` reports it, without its request metadata. */
function entryView(entry) {
  if (!entry) return null;
  const { metadata: _metadata, ...view } = entry;
  return view;
}

/**
 * Abandon's one release step for a request, with or without its receipt: the request's queue reservation, found by its
 * request key in any account's queue, is released once its launcher is gone. A launcher that is still alive keeps it:
 * without a receipt abandon refuses, and with one abandon still marks the receipt. `receipt` is null when the launch
 * wrote none, else `{ plan, write, runId }`: the dry run's receipt change, its synchronous write, done under the queue
 * lock so no resume or release interleaves, and the run id it ends (null for a terminal receipt). Without confirm it
 * reports the plan and changes nothing. Every run this abandon ends is marked abandoned in the routine ledger through
 * `markRun`; the release is the person's way out when the provider never ends or lists that run.
 */
export async function releaseValidationReservation({ home, key, receipt = null, confirm = false, unconfirmed, markRun, identityOf = readProcessIdentity }) {
  const queues = queuesDir(home);
  const file = (existsSync(queues) ? readdirSync(queues) : []).map((name) => path.join(queues, name, "queue.json"))
    .find((candidate) => existsSync(candidate) && readQueue(candidate).active?.key === key);
  if (!file && !receipt) throw new Error("no cloud task exists to poll and no queue reservation holds this request");
  const live = (entry) => {
    if (!launcherAlive(entry, identityOf)) return false;
    if (!receipt) throw new Error(`cloud validation launcher ${entry.pid} still holds this reservation; stop it before abandoning`);
    return true;
  };
  // The runs this abandon ends: a receipt it abandons names its run, normally the one the reservation recorded too; a
  // terminal receipt's run has ended already, so nothing is marked.
  const ends = (entry) => [...new Set(receipt ? (receipt.runId ? [receipt.runId, entry?.launch?.runId] : []) : [entry?.launch?.runId])].filter(Boolean);
  if (!confirm) {
    const held = file ? readQueue(file).active : null;
    const kept = held?.key === key && live(held);
    const release = held?.key === key && !kept ? { queue: file, active: entryView(held), releases: held.token,
      ...(held.launch?.runId && ends(held).includes(held.launch.runId) ? { marksRunAbandoned: held.launch.runId } : {}) } : {};
    return unconfirmed({ ...receipt?.plan, ...release, ...(kept ? { keepsReservation: held.token } : {}) });
  }
  const released = !file ? (receipt.write(), null) : await updateQueue(file, (state) => {
    const entry = state.active?.key === key ? state.active : null;
    if (!entry && !receipt) throw new Error("the queue reservation changed during abandon; rerun abandon");
    const kept = entry !== null && live(entry);
    receipt?.write();
    if (!entry || kept) return null;
    state.abandoned = [...state.abandoned, abandonedRecord(entry, receipt ? "abandoned locally with its receipt" : "abandoned locally; its launch wrote no receipt")].slice(-200);
    state.active = null;
    return entry;
  });
  // After the queue lock is released: a launch takes the routine lock, then the queue lock.
  for (const runId of ends(released)) await markRun(runId);
  return { status: "abandoned", queue: file ?? null, released: entryView(released), active: file ? entryView(readQueue(file).active) : null };
}

const LIST_RUNS_PAGES = 10;
class IncompleteRunInventory extends Error {}
/** A routine's run by id: the standing routine serves every run, so pages after the newest are read too. */
function *routineRuns(remote,routineId) {
  let cursor;
  for (let page = 0; page < LIST_RUNS_PAGES; page += 1) {
    const listed = remote("list_runs", { trigger_id: routineId, ...(cursor ? { cursor } : {}) });
    yield* listed?.data ?? [];
    if (!listed?.next_cursor) return;
    cursor = listed.next_cursor;
  }
  throw new IncompleteRunInventory("routine run inventory exceeded the pagination limit");
}

/** Find an exact run id, including older pages on a shared standing routine. */
export function findRun(remote,routineId,runId) {
  for (const run of routineRuns(remote,routineId)) if (run.id === runId) return run;
}

/** Retry an incomplete bounded inventory until the original deadline. An unseen run may still be active. */
export async function visibleRun(remote, receipt, {waitForVisibility, deadline, now, sleep, pollMs}) {
  for (;;) {
    let incomplete = false;
    try {
      const run = findRun(remote, receipt.routineId, receipt.runId ?? receipt.taskId);
      if (run || !waitForVisibility) return {run};
    } catch (error) {
      if (!(error instanceof IncompleteRunInventory) || !waitForVisibility) throw error;
      incomplete = true;
    }
    const observedAt = now();
    if (observedAt >= deadline) return incomplete ? {unknownAt:observedAt} : {};
    await sleep(Math.min(pollMs, deadline-observedAt));
  }
}

/** Recover a lost acknowledgement only when a provider log proves the pre-dispatch nonce. */
function locateLaunch(launch, remote) {
  if (!launch?.routineId || !launch.launchToken) return null;
  const marker = "VIBE_VALIDATION_LAUNCH " + launch.launchToken;
  for (const run of routineRuns(remote,launch.routineId)) {
    if (!run.id || !run.session_id) continue;
    const evidence = remote("get_run_log",{session_id:run.session_id});
    if (typeof evidence?.log === "string" && evidence.log.split(/\r?\n/).some(line => line.replace(/^\[[^\]\n]+\] assistant:\s*/, "").trim() === marker)) {
      return {...launch,routineId:launch.routineId,runId:run.id,sessionId:run.session_id,startedAt:launch.startedAt,launchToken:launch.launchToken};
    }
  }
  return null;
}

// An inventory cut at LIST_RUNS_PAGES is read, not refused, so a lost launch is still reclaimed past its window on a
// standing routine whose run history outgrew the limit. Runs are listed newest first and no other validation launches
// while a reservation holds the account, but dispatch runs on the same standing routine outside the queue, so enough
// newer dispatch runs can push a launch that did happen past the limit; that rare launch is then reclaimed while it may
// still run. Any other thrown provider read leaves the run unreadable.
const unproven = (error) => error instanceof IncompleteRunInventory ? "unknown" : "unreadable";

/**
 * Reconcile a known reservation from its exact local receipt or code-owned routine run entry: `active` or `terminal`
 * from the provider's listing of the run, `unknown` when every provider read succeeded and proved nothing,
 * `unreadable` when a provider read threw.
 */
export function recoverValidationReservation(entry, { ledger, remote }) {
  const receipt = existsSync(entry.receipt) ? regularJson(entry.receipt) : null;
  if (receipt && TERMINAL.has(receipt.status)) return "terminal";
  let run = receipt ?? ledger.runs.find(row => row.requestKey === entry.key && (!entry.launch?.launchToken || row.launchToken === entry.launch.launchToken));
  // The reservation records an acknowledged run before the ledger row and the receipt are written.
  if (!run && entry.launch?.runId) run = entry.launch;
  if (!run) {
    try { run = locateLaunch(entry.launch,remote); } catch (error) { return unproven(error); }
  }
  if (!run?.routineId || !run.runId) return "unknown";
  if (!receipt) writeAtomic(entry.receipt, { ...entry.metadata, ...run, provider: "claude", taskId: run.runId,
    status: "running", requestDigest: entry.key });
  try {
    const observed = findRun(remote, run.routineId, run.runId);
    if (!observed) return "unknown";
    if (TERMINAL.has(observed.status) || (observed.status === "active" && observed.worker_status === "idle")) return "terminal";
    return "active";
  } catch (error) { return unproven(error); }
}
