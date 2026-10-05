#!/usr/bin/env node
/** Additive, best-effort display telemetry. Never changes worker lifecycle. */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
const phases = new Set(['coding', 'planning', 'reviewing', 'waiting', 'waiting_for_human', null]);
const reviewKinds = new Set(['plan', 'code']);
const automaticWaitKinds = new Set(['merge_queue', 'review', 'ci', 'monitoring', 'dependency', 'other']);
const humanWaitKinds = new Set(['plan_review', 'human_merge', 'human_input', 'product_decision', 'manual_qa']);
const utc = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const word = value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,200}$/.test(value);
/** A deliberately public action request, never copied from private routing or transcripts. */
export function normalizeWaitReason(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) throw Error('Invalid public wait reason');
  const reason = value.trim();
  if (!reason || reason.length > 300) throw Error('Invalid public wait reason length');
  return reason;
}
/** Whitelist public display fields; reject arbitrary text and unverified shapes. */
export function normalizeDisplayEvent(input) {
  if (!word(input.sweepId) || !word(input.workerId) || !Number.isSafeInteger(input.ownerGeneration) || input.ownerGeneration < 1) throw Error('Invalid owner identity');
  const event = { schema: 'CL_SWEEP_DISPLAY_EVENT v1', id: input.id || randomUUID(), sweepId: input.sweepId, workerId: input.workerId, ownerGeneration: input.ownerGeneration, kind: input.kind, at: input.at || new Date().toISOString() };
  if (!word(event.id) || !Number.isFinite(Date.parse(event.at))) throw Error('Invalid event identity or timestamp');
  if (input.kind === 'phase') {
    if (!phases.has(input.phase)) throw Error('Invalid display phase');
    if (input.waitReason !== undefined) {
      if (input.phase !== 'waiting_for_human') throw Error('Wait reason requires a human wait');
      event.waitReason = normalizeWaitReason(input.waitReason);
    }
    event.phase = input.phase;
    if (input.phase === 'reviewing') {
      if (!reviewKinds.has(input.reviewKind)) throw Error('Reviewing requires plan or code reviewKind');
      event.reviewKind = input.reviewKind;
    } else if (input.reviewKind !== undefined) throw Error('reviewKind is valid only while reviewing');
    if (input.phase === 'waiting') {
      if (input.waitKind !== undefined && !automaticWaitKinds.has(input.waitKind)) throw Error('Invalid automatic waitKind');
      if (input.waitKind !== undefined) event.waitKind = input.waitKind;
    } else if (input.phase === 'waiting_for_human') {
      const waitKind = input.waitKind === 'ui_plan_approval' ? 'plan_review' : input.waitKind;
      if (waitKind !== undefined && !humanWaitKinds.has(waitKind)) throw Error('Invalid human waitKind');
      if (waitKind !== undefined) event.waitKind = waitKind;
    } else if (input.waitKind !== undefined) throw Error('waitKind is valid only while waiting');
  } else if (input.kind === 'message') {
    if (!['to_worker', 'to_orchestrator'].includes(input.direction) || !['sent', 'delivered'].includes(input.stage) || !word(input.messageId)) throw Error('Invalid message metadata');
    Object.assign(event, { direction: input.direction, stage: input.stage, messageId: input.messageId });
  } else if (input.kind === 'pr') {
    const pr = input.pr;
    const url = new URL(pr?.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) || !Number.isSafeInteger(pr.number) || pr.number < 1 || Number(url.pathname.split('/').at(-1)) !== pr.number || !['draft', 'open', 'merged', 'closed', 'unknown'].includes(pr.state)) throw Error('Invalid PR metadata');
    const relation = pr.relation;
    if (relation !== undefined && !['own', 'dependency', 'reference'].includes(relation)) throw Error('Invalid PR relation');
    const ticket = pr.ticket;
    if (ticket !== undefined && !/^(?:ISS|FEA)-[1-9]\d*$/.test(ticket)) throw Error('Invalid PR ticket');
    if (['own', 'dependency'].includes(relation) && !ticket) throw Error('Owned and dependency PRs require ticket attribution');
    event.pr = { url: url.href, number: pr.number, state: pr.state };
    if (relation !== undefined) event.pr.relation = relation;
    if (ticket !== undefined) event.pr.ticket = ticket;
  } else throw Error('Invalid display event kind');
  return event;
}
/** Record a separately scoped manual-QA obligation; ownership and activity are independent. */
export function normalizeGate(input) {
  if (!word(input.sweepId) || !/^(?:ISS|FEA)-[1-9]\d*$/.test(input.ticket || '')
    || !word(input.gateId) || input.kind !== 'manual_qa'
    || !['open', 'completed', 'canceled'].includes(input.state) || !utc(input.verifiedAt)) throw Error('Invalid explicit gate');
  const event = { schema: 'CL_SWEEP_GATE v1', id: input.id || randomUUID(), sweepId: input.sweepId,
    ticket: input.ticket, gateId: input.gateId, kind: input.kind, state: input.state,
    verifiedAt: input.verifiedAt, at: input.at || new Date().toISOString() };
  if (!word(event.id) || !utc(event.at) || Date.parse(event.verifiedAt) > Date.parse(event.at)) throw Error('Invalid gate timestamp');
  if (input.action !== undefined) event.action = normalizeWaitReason(input.action);
  return event;
}
/** Append only explicit gate observations; never closes gates because work or PR state changed. */
export function recordGate(sweepRoot, input) {
  try {
    const event = normalizeGate(input);
    if (!sweepRoot || !existsSync(resolve(sweepRoot))) return false;
    appendFileSync(resolve(sweepRoot, 'gates.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    broadcastDisplayEvent(event);
    return true;
  } catch { return false; }
}
/** Validate an explicitly observed directed dependency without inferring ticket state. */
export function normalizeDependency(input) {
  const ticket = value => typeof value === 'string' && /^(?:ISS|FEA)-[1-9]\d*$/.test(value);
  if (!word(input.sweepId) || !ticket(input.blockedTicket) || !ticket(input.blockingTicket)
    || input.blockedTicket === input.blockingTicket || !['blocked', 'cleared'].includes(input.state)
    || !utc(input.verifiedAt)) throw Error('Invalid explicit dependency');
  const event = { schema: 'CL_SWEEP_DEPENDENCY v1', id: input.id || randomUUID(),
    sweepId: input.sweepId, blockedTicket: input.blockedTicket, blockingTicket: input.blockingTicket,
    state: input.state, verifiedAt: input.verifiedAt, at: input.at || new Date().toISOString() };
  if (!word(event.id) || !utc(event.at) || Date.parse(event.verifiedAt) > Date.parse(event.at)) throw Error('Invalid dependency timestamp');
  return event;
}
/** Append only known dependency transitions; never queries services or clears inferred edges. */
export function recordDependency(sweepRoot, input) {
  try {
    const event = normalizeDependency(input);
    if (!sweepRoot || !existsSync(resolve(sweepRoot))) return false;
    appendFileSync(resolve(sweepRoot, 'dependencies.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    broadcastDisplayEvent(event);
    return true;
  } catch { return false; }
}
/** Normalize business status observed by an existing authenticated ClosedLoop read. */
export function normalizeTicketStatus(input) {
  const statuses = new Set(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELED']);
  if (!word(input.sweepId) || !/^(?:ISS|FEA)-[1-9]\d*$/.test(input.ticket || '')
    || !statuses.has(input.status) || !utc(input.verifiedAt)) throw Error('Invalid verified ticket status');
  const event = { schema: 'CL_SWEEP_TICKET_STATUS v1', id: input.id || randomUUID(),
    sweepId: input.sweepId, ticket: input.ticket, status: input.status,
    verifiedAt: input.verifiedAt, at: input.at || new Date().toISOString(), source: 'closedloop' };
  if (!word(event.id) || !utc(event.at) || Date.parse(event.verifiedAt) > Date.parse(event.at)) throw Error('Invalid business status timestamp');
  return event;
}
/** Metadata-only reporting; never calls ClosedLoop and never changes ticket ownership. */
export function recordTicketStatus(sweepRoot, input) {
  try {
    const event = normalizeTicketStatus(input);
    if (!sweepRoot || !existsSync(resolve(sweepRoot))) return false;
    appendFileSync(resolve(sweepRoot, 'ticket-status.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    broadcastDisplayEvent(event);
    return true;
  } catch { return false; }
}
/** Normalize explicit accepted root resumes separately from ticket-owner events. */
export function normalizeDisplayActivation(input) {
  if (!word(input.sweepId) || !word(input.projectId) || !word(input.ownerThreadId)
    || !Number.isSafeInteger(input.ownerGeneration) || input.ownerGeneration < 1
    || !Number.isSafeInteger(input.afterRegistrySequence) || input.afterRegistrySequence < 1
    || input.kind !== 'resumed') throw Error('Invalid root activation');
  const event = {
    schema: 'CL_SWEEP_DISPLAY_ACTIVATION v1', id: input.id || randomUUID(),
    sweepId: input.sweepId, projectId: input.projectId,
    ownerThreadId: input.ownerThreadId, ownerGeneration: input.ownerGeneration,
    kind: 'resumed', at: input.at || new Date().toISOString(),
    afterRegistrySequence: input.afterRegistrySequence,
  };
  if (!word(event.id) || !Number.isFinite(Date.parse(event.at))) throw Error('Invalid activation identity or timestamp');
  return event;
}
/** Called only after root ownership validation and ACTIVE authority persistence. */
export function recordDisplayActivation(stateBase, input) {
  try {
    const event = normalizeDisplayActivation(input);
    if (!stateBase || !existsSync(resolve(stateBase))) return false;
    appendFileSync(resolve(stateBase, 'display-activations.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    broadcastDisplayEvent(event, stateBase);
    return true;
  } catch { return false; }
}
/** Completed callbacks clear work poses; explicit human waits remain participating. */
export function callbackDisplayDetail(event) {
  const rawWaitKind = event?.payload?.summary?.wait_kind;
  const status = event?.status;
  const planWait = ['implementation_plan_approval', 'exact_plan_approval', 'ui_plan_approval', 'plan_review', 'WAITING_UI_PLAN_APPROVAL'].includes(rawWaitKind)
    || (typeof rawWaitKind === 'string' && /(?:^|_)plan_(?:review|approval)(?:_|$)/.test(rawWaitKind))
    || status === 'WAITING_UI_PLAN_APPROVAL';
  const mergeWait = status === 'WAITING_HUMAN_MERGE' || ['human_merge', 'WAITING_HUMAN_MERGE'].includes(rawWaitKind);
  const productWait = ['PRODUCT_BLOCKED', 'WAITING_PRODUCT_DECISION'].includes(status) || rawWaitKind === 'product_decision';
  const manualQaWait = status === 'WAITING_MANUAL_QA' || rawWaitKind === 'manual_qa';
  if (event?.kind === 'WAITING_HUMAN' || planWait || mergeWait || productWait || manualQaWait || ['human', 'waiting_for_human', 'human_input'].includes(rawWaitKind)) {
    const waitKind = status === 'WAITING_UI_PLAN_APPROVAL' ? 'plan_review'
      : status === 'WAITING_HUMAN_MERGE' ? 'human_merge'
      : status === 'WAITING_MANUAL_QA' ? 'manual_qa'
      : planWait ? 'plan_review' : mergeWait ? 'human_merge' : productWait ? 'product_decision'
      : manualQaWait ? 'manual_qa' : 'human_input';
    const detail = { kind: 'phase', phase: 'waiting_for_human', waitKind };
    if (event?.payload?.summary?.wait_reason !== undefined) {
      try { detail.waitReason = normalizeWaitReason(event.payload.summary.wait_reason); } catch { /* Invalid optional public copy must not discard the phase. */ }
    }
    return detail;
  }
  if (event?.kind === 'PR_MONITORING_HANDOFF') return { kind: 'phase', phase: 'waiting', waitKind: 'monitoring' };
  if (status === 'WAITING_CI') return { kind: 'phase', phase: 'waiting', waitKind: 'ci' };
  if (status === 'WAITING_REVIEW') return { kind: 'phase', phase: 'waiting', waitKind: 'review' };
  return { kind: 'phase', phase: null };
}
/** Compatibility for earlier accepted-callback hooks; lifecycle belongs to Detail. */
export function callbackDisplayMetadata(event) {
  const { kind, ...metadata } = callbackDisplayDetail(event);
  return metadata;
}
export function callbackDisplayPhase(event) {
  return callbackDisplayDetail(event).phase;
}
/** Best-effort socket fast path; durable journal remains the recovery source. */
function broadcastDisplayEvent(event, stateBase = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'cl-sweep-state')) {
  try {
    const socketPath = resolve(stateBase, 'display-events.sock');
    const socket = createConnection(socketPath);
    socket.setTimeout(100, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => socket.end(`${JSON.stringify(event)}\n`));
  } catch { /* Optional display listener is not a workflow dependency. */ }
}
/** Append one bounded line to an existing sweep root; failures never block work. */
export function recordDisplayEvent(root, input) {
  try {
    const event = normalizeDisplayEvent(input);
    if (!root || !existsSync(resolve(root))) return false;
    appendFileSync(resolve(root, 'display-events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    broadcastDisplayEvent(event);
    return true;
  } catch { return false; }
}
/** Resolve a sweep binding by manifest location, without reading private files. */
export function recordSessionDisplayEvent(sessionPath, session, detail) {
  try {
    const base = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'cl-sweep-state');
    const records = readFileSync(resolve(base, 'registry.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const roots = new Map(records.map(record => [record.sweepId, record]));
    const root = [...roots.values()].find(record => record.schema === 'CL_SWEEP_ROOT_REGISTRY v1' && typeof record.rootPath === 'string' && resolve(sessionPath).startsWith(resolve(record.rootPath, 'sessions') + sep));
    if (!root) return false;
    return recordDisplayEvent(root.rootPath, { ...detail, sweepId: root.sweepId, workerId: session.ownerId, ownerGeneration: session.generation });
  } catch { return false; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
    const input = { sweepId: args['sweep-id'], workerId: args['worker-id'], ownerGeneration: Number(args['owner-generation']), kind: args.kind, id: args.id };
    if (args.kind === 'phase') Object.assign(input, {
      phase: args.phase === 'null' ? null : args.phase,
      reviewKind: args['review-kind'],
      waitKind: args['wait-kind'],
      waitReason: args['wait-reason'],
    });
    if (args.kind === 'message') Object.assign(input, { direction: args.direction, stage: args.stage, messageId: args['message-id'] });
    if (args.kind === 'pr') input.pr = { url: args.url, number: Number(args.number), state: args.state, relation: args.relation, ticket: args.ticket };
    const recorded = args.kind === 'gate'
      ? recordGate(args.root, { sweepId: args['sweep-id'], ticket: args.ticket, gateId: args['gate-id'], kind: args['gate-kind'], state: args['gate-state'], verifiedAt: args['verified-at'], action: args.action, id: args.id })
      : args.kind === 'ticket_status'
      ? recordTicketStatus(args.root, { sweepId: args['sweep-id'], ticket: args.ticket, status: args.status, verifiedAt: args['verified-at'], id: args.id })
      : args.kind === 'dependency'
        ? recordDependency(args.root, { sweepId: args['sweep-id'], blockedTicket: args['blocked-ticket'], blockingTicket: args['blocking-ticket'], state: args.state, verifiedAt: args['verified-at'], id: args.id })
        : recordDisplayEvent(args.root, input);
    process.stdout.write(JSON.stringify({ recorded }) + '\n');
  } catch { process.stdout.write('{"recorded":false}\n'); }
}
