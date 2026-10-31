// How a Codex thread the fleet starts appears in the person's Codex app sidebar (ISS-13279, operator ruling
// 2026-10-28): it carries a readable name, sits in one "Fleet workers" section, and is archived only after
// the fleet has recorded the worker stopped or merged. Every thread started through the App Server is an
// ordinary sidebar chat, titled by its first prompt, so a fleet once filled the person's chat list.
// An archived thread stays readable (thread/read) but thread/resume is refused until thread/unarchive, so a
// live writer is never archived.
import { readThreadState } from './liveness.mjs';

export const FLEET_SECTION_NAME = 'Fleet workers';
// Sent on thread/start for every worker thread, never for the orchestrator's own thread (operator ruling,
// 2026-10-28). The Codex app leaves a thread with this source out of its sidebar, but thread/list does not
// return the field (0.163 to 0.165), so today it does not keep workers out of the app: after an app restart a
// marked worker is listed (on the app's very first launch it may be missing until then). Workers drop out of
// the app once a server returns the field. The CLI and the App Server never read it.
export const WORKER_THREAD_SOURCE = 'chatgpt_hidden';
export const END_REASONS = Object.freeze(['stopped', 'merged']);

/** `<writer> · <ticket>`, or the writer alone when there is no ticket (a single-use run). */
export function workerThreadName(writer, ticket) {
  return ticket ? `${writer} · ${ticket}` : writer;
}

/** The id of the "Fleet workers" section, created when missing. Several with that name: the oldest (UUIDv7). */
export async function fleetSectionId(client) {
  const found = [];
  let cursor = null;
  do {
    const page = await client.request('threadSection/list', cursor ? { cursor } : {});
    found.push(...(page?.data ?? []).filter((section) => section?.name === FLEET_SECTION_NAME));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  if (found.length) return found.map((section) => section.id).sort()[0];
  const created = await client.request('threadSection/create', { name: FLEET_SECTION_NAME });
  if (!created?.section?.id) throw new Error('App Server returned no section id');
  return created.section.id;
}

/**
 * Names a just-started thread and moves it into the "Fleet workers" section. The thread already exists, so a
 * step an older App Server lacks is returned as a warning instead of failing the worker's start.
 */
export async function labelWorkerThread(client, threadId, name) {
  const warnings = [];
  try {
    await client.request('thread/name/set', { threadId, name });
  } catch (error) {
    warnings.push(`thread/name/set failed: ${error.message}`);
  }
  try {
    await client.request('thread/section/move', { threadId, sectionId: await fleetSectionId(client) });
  } catch (error) {
    warnings.push(`moving the thread into "${FLEET_SECTION_NAME}" failed: ${error.message}`);
  }
  return warnings;
}

export function endRecord(reason, at = new Date().toISOString()) {
  if (!END_REASONS.includes(reason)) throw new Error(`reason must be one of: ${END_REASONS.join(', ')}`);
  return { reason, at };
}

/** Refuses a thread whose turn is still running: an archived thread cannot be resumed or steered. */
export async function assertWorkerNotLive(client, threadId) {
  const { thread, turn } = await readThreadState(client, threadId);
  if (thread?.status?.type === 'active' || turn?.status === 'inProgress') {
    throw new Error(`thread ${threadId} has a running turn; a live writer is never archived`);
  }
}

/** Archives a worker's thread; `ended` is the stop or merge the caller has already recorded. */
export async function archiveEndedWorker(client, threadId, ended) {
  if (!END_REASONS.includes(ended?.reason) || !ended?.at) {
    throw new Error('archive needs the worker recorded stopped or merged first');
  }
  await client.request('thread/archive', { threadId });
}
