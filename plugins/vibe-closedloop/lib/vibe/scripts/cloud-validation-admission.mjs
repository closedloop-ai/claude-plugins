import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentityStatus, readProcessIdentity } from "../../../shared/process-identity.mjs";
import { acquire, release } from "./e2e-lock.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

// A standing routine owns its configuration and its current provider run until the run is terminal.
export const CLOUD_VALIDATION_CAPACITY = 1;
const BUSY = "CLOUD_VALIDATION_QUEUE_TIMEOUT";
const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "archived"]);

function identityKey(account) {
  return createHash("sha256").update(account).digest("hex");
}

function readQueue(file) {
  if (!existsSync(file)) return { version: 1, active: null, queued: [], abandoned: [] };
  const state = regularJson(file);
  if (state?.version !== 1 || !Array.isArray(state.queued) || !Array.isArray(state.abandoned)) throw new Error("cloud validation queue has an unsupported record");
  return state;
}

/** Serialize local admission state for one pinned Claude account and preserve an interrupted running reservation. */
export async function withCloudValidationAdmission({ home, account, key, receipt, metadata, timeoutMs, signal, recover, now = Date.now,
  wait = (ms, currentSignal) => delay(ms, undefined, { signal: currentSignal }), sleepMs = 500,
  drainUnbound = false, report = (line) => process.stderr.write(`${line}\n`), identityOf = readProcessIdentity,
}, action) {
  const queues = path.join(home, ".codex", "vibe", "cloud", "validation-queues");
  // The first verified pin must wait for any earlier unbound provider run, including an interrupted launch.
  if (!drainUnbound && account !== "unbound-validation" && existsSync(path.join(queues,identityKey("unbound-validation"),"queue.json"))) {
    await withCloudValidationAdmission({home, account:"unbound-validation", key:"drain:"+account+":"+key, receipt, metadata,
      timeoutMs,signal,recover,now,wait,sleepMs,report,identityOf,drainUnbound:true},async()=>{});
  }
  const dir = path.join(queues,identityKey(account));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "queue.json");
  const lock = path.join(dir, "queue.lock");
  const owner = { token: randomUUID(), pid: process.pid, identity: identityOf(process.pid), key, receipt, metadata };
  const deadline = now() + timeoutMs;
  if (!owner.identity) throw new Error("cloud validation could not determine its exact queue process identity");
  report(`CLOUD_VALIDATION_CAPACITY ${CLOUD_VALIDATION_CAPACITY}: one active validation per account; excess requests wait in order`);
  const alive = (entry) => entry.pid && processIdentityStatus(entry.pid, entry.identity, { identityOf }) !== "dead";
  async function update(change) {
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
        const resume = !drainUnbound && active.key === key && active.receipt === receipt && disposition === "active" &&
          !(existsSync(receipt) && regularJson(receipt).status === "abandoned");
        if (disposition === "terminal" || resume) await update((state) => {
          if (state.active?.token !== active.token) return;
          if (!resume) state.active = null;
          else {
            state.queued = state.queued.filter((entry) => entry.token !== owner.token);
            state.active = { ...owner, phase: active.phase };
            selected = true;
          }
        });
      }
      if (selected) break;
      if (now() >= deadline) throw Object.assign(new Error(`${BUSY}: this request did not launch; retry the same request after the active reservation settles`), { code: BUSY });
      await wait(Math.min(sleepMs, Math.max(1, deadline - now())), signal);
    }
    const launching = (launch, requirements) => update((state) => {
      if (state.active?.token !== owner.token) throw new Error("cloud validation admission no longer belongs to this request");
      state.active.phase = "launching";
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

const LIST_RUNS_PAGES = 10;
export class IncompleteRunInventory extends Error {}
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

/** Reconcile a known reservation from its exact local receipt or code-owned routine run entry. */
export function recoverValidationReservation(entry, { ledger, remote }) {
  const receipt = existsSync(entry.receipt) ? regularJson(entry.receipt) : null;
  if (receipt && TERMINAL.has(receipt.status)) return "terminal";
  let run = receipt ?? ledger.runs.find(row => row.requestKey === entry.key && (!entry.launch?.launchToken || row.launchToken === entry.launch.launchToken));
  if (!run) {
    try { run = locateLaunch(entry.launch,remote); } catch { return "unknown"; }
  }
  if (!run?.routineId || !run.runId) return "unknown";
  if (!receipt) writeAtomic(entry.receipt, { ...entry.metadata, ...run, provider: "claude", taskId: run.runId,
    status: "running", requestDigest: entry.key });
  try {
    const observed = findRun(remote, run.routineId, run.runId);
    if (!observed) return "unknown";
    if (TERMINAL.has(observed.status) || (observed.status === "active" && observed.worker_status === "idle")) return "terminal";
    return "active";
  } catch { return "unknown"; }
}
