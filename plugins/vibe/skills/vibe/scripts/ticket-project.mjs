#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { askQuestion, answerQuestion } from "./session-questions.mjs";
import { readVibeUserConfig, updateVibeUserConfig } from "../../../lib/vibe/scripts/vibe-user-config.mjs";
import { regularJson, writeAtomic } from "../../../lib/vibe/scripts/owned-state.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

import { providerDataOr, sessionBinding } from "../../../lib/vibe/scripts/provider.mjs";

const ticketConfig = (key) => providerDataOr(sessionBinding(), "tickets", key, null);
const isIssue = (slug) => {
  const pattern = ticketConfig("issuePattern");
  return typeof pattern === "string" && typeof slug === "string" && new RegExp(pattern, "i").test(slug);
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RANGE = /(\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2})\/(\d{1,2})/;
const SOURCE_STATUS = new Set(["TRIAGE", "BACKLOG", "TODO"]);
const INITIAL_STATUS = new Set([undefined, "TRIAGE", "BACKLOG", "TODO"]);
const SESSION_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const DAY_MS = 86_400_000;
const OBSERVATION_AGE_MS = 30 * 60_000;
const QUESTION = "Which backlog project should Vibe use for new tickets? Give the full project URL, exact name, ID or slug.";

const normalize = (input) => String(input ?? "").trim().normalize("NFKC").toLowerCase();

function validActor(actor) {
  return UUID.test(actor?.id ?? "") && UUID.test(actor?.organizationId ?? "");
}

function actorKey(actor) {
  if (!validActor(actor)) throw new Error("Read the tracker's current-user record for this conversation before choosing a ticket project");
  return createHash("sha256").update(`${normalize(actor.organizationId)}:${normalize(actor.id)}`).digest("hex");
}

/**
 * The tracker scopes its ticket and project-list replies to the signed-in user's organization and may leave
 * organizationId out of them, so a record without one belongs to the recorded actor's organization; a record that
 * names another organization never does.
 */
function inActorOrganization(record, actor) {
  return validActor(actor) && (record?.organizationId == null || record.organizationId === actor.organizationId);
}

/** A tracker row with an exact ID and, when it names one, an exact organization. */
function trackerRow(value) {
  return UUID.test(value?.id ?? "") && (value.organizationId == null || UUID.test(value.organizationId));
}

function projectedProject(project, actor) {
  if (!validActor(actor) || !UUID.test(project?.id ?? "") || !inActorOrganization(project, actor) ||
    typeof project.name !== "string" || !project.name.trim() || (project.slug != null && typeof project.slug !== "string")) return null;
  return { id: project.id, name: project.name, slug: project.slug ?? null };
}

function queryKey(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 1024) return null;
  if (!/^https?:\/\//i.test(input)) return normalize(input);
  try {
    const url = new URL(input);
    if (url.origin !== ticketConfig("projectTracker")?.origin) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const project = segments.findLastIndex((segment) => segment === "project" || segment === "projects");
    if (project < 0 || project + 2 !== segments.length) return null;
    return normalize(decodeURIComponent(segments.at(-1)));
  } catch { return null; }
}

/** Resolve URL, UUID, slug or exact name using projects proven by the tracker's own read tools. */
export function resolveBacklogProject(input, projects, actor, { complete = true } = {}) {
  const target = queryKey(input);
  if (!target) return { status: "not-found" };
  const inventory = [...new Map(projects.map((project) => [project?.id, projectedProject(project, actor)]).filter(([, entry]) => entry)).values()];
  const exact = inventory.filter((project) => normalize(project.id) === target || normalize(project.slug) === target);
  const named = inventory.filter((project) => normalize(project.name) === target);
  const matches = exact.length ? exact : complete ? named : [];
  if (!matches.length) return { status: complete ? "not-found" : "incomplete" };
  if (matches.length !== 1) return { status: "ambiguous", count: matches.length };
  if (RANGE.test(matches[0].name)) return { status: "weekly" };
  return { status: "confirmed", project: matches[0] };
}

/** The saved backlog choice belongs to the authenticated tracker identity, never another login on the same machine. */
export function savedBacklogProject(actor, home = os.homedir()) {
  if (!validActor(actor)) return null;
  return readVibeUserConfig(home).ticketProjects?.[actorKey(actor)]?.project ?? null;
}

function saveChoice(home, actor, change) {
  const key = actorKey(actor);
  return updateVibeUserConfig(home, (config) => {
    const all = config.ticketProjects ?? {};
    const current = all[key] ?? {};
    const { record, result } = change(current);
    return { config: record === current ? config : { ...config, ticketProjects: { ...all, [key]: record } }, result };
  });
}

/** Seed or confirm the exact project already chosen by this authenticated user. */
export function rememberBacklogProject(actor, project, home = os.homedir()) {
  const verified = projectedProject(project, actor);
  if (!verified || RANGE.test(verified.name)) throw new Error("Select an exact backlog project from the authenticated tracker's project response");
  return saveChoice(home, actor, (record) => ({ record: { ...record, project: verified }, result: verified }));
}

/** One durable question per ambiguity attempt, with the same canonical question machinery as session intake. */
export function backlogProjectQuestion(actor, { answer, projects = [], complete, home = os.homedir() } = {}) {
  return saveChoice(home, actor, (record) => {
    if (record.project) return { record, result: { status: "saved", project: record.project, ask: false } };
    let questions = record.questions ?? [];
    let attempt = record.attempt ?? 1;
    let status = "needs-choice";
    if (answer !== undefined) {
      const decision = resolveBacklogProject(answer, projects, actor, { complete });
      if (decision.status === "confirmed") {
        return { record: { ...record, project: decision.project }, result: { ...decision, ask: false } };
      }
      if (decision.status === "incomplete") return { record, result: { ...decision, ask: false } };
      status = decision.status;
      const key = `ticket-backlog:${attempt}`;
      if (!questions.some((entry) => entry.key === key)) {
        const first = askQuestion(questions, { key, question: QUESTION, fallback: "leave ticket creation waiting for the chosen backlog project", deadlineMinutes: 30 });
        questions = first.questions;
      }
      questions = answerQuestion(questions, { key, answer }).questions;
      attempt += 1;
    }
    const key = `ticket-backlog:${attempt}`;
    const known = status === "needs-choice" ? QUESTION : `That exact backlog project was ${status === "weekly" ? "a weekly project" : status}. ${QUESTION}`;
    const pending = askQuestion(questions, { key, question: known, fallback: "leave ticket creation waiting for the chosen backlog project", deadlineMinutes: 30 });
    return { record: { ...record, questions: pending.questions, attempt }, result: { status, ...pending.result } };
  });
}

function hitsWeek(project, now) {
  const match = RANGE.exec(project.name);
  if (!match) return false;
  const [, month, day, endMonth, endDay] = match.map(Number);
  const year = new Date(now).getUTCFullYear();
  return [year - 1, year].some((startYear) => {
    const start = Date.UTC(startYear, month - 1, day);
    const end = Date.UTC(startYear + Number(endMonth < month), endMonth - 1, endDay);
    return end >= start && end - start <= 7 * DAY_MS && now >= start && now < end + DAY_MS;
  });
}

/** Find the single current-week project and form one stale-write-guarded In Progress transition. */
export function ticketWorkStart(actor, ticket, projects, now = Date.now()) {
  if (!ticket || !inActorOrganization(ticket, actor) || !SOURCE_STATUS.has(ticket.status) || !isIssue(ticket.slug)) {
    throw new Error("Read the exact unstarted ticket from the tracker before moving it into this week's project");
  }
  const active = projects.map((project) => projectedProject(project, actor)).filter((project) => project && hitsWeek(project, now));
  const unique = [...new Map(active.map((project) => [project.id, project])).values()];
  if (unique.length !== 1) throw new Error("The tracker did not confirm exactly one current-week project. Leave the ticket in its backlog.");
  return { documentId: ticket.slug, projectId: unique[0].id, status: "IN_PROGRESS", expectedStatus: ticket.status };
}

/** Explain why the tracker write must wait for a backlog choice or a verified start-work transition. */
export function projectWriteProblem({ input, action, actor, projects = [], complete = true, ticket, home, now }) {
  if (action === "create") {
    if (!INITIAL_STATUS.has(input.status)) return "Create the ticket in backlog, then use the separate In Progress work-start update.";
    const choice = savedBacklogProject(actor, home);
    if (!choice) return "Read the tracker’s current-user record and run ticket-project.mjs ask for the existing question or saved backlog project before creating a ticket.";
    if (input.projectId !== choice.id) return "Use the exact saved backlog project ID reported by ticket-project.mjs ask.";
    return null;
  }
  if (input.projectId === undefined) return null;
  if (input.projectId === null || input.status !== "IN_PROGRESS") return "Project moves are allowed only on the verified start-work transition to In Progress.";
  try {
    if (!complete) throw new Error("project list is incomplete");
    const expected = ticketWorkStart(actor, ticket, projects, now);
    if (input.documentId === expected.documentId && input.projectId === expected.projectId && input.expectedStatus === expected.expectedStatus) return null;
  } catch { /* The reason below covers absent, stale, ambiguous and unrelated sources. */ }
  return "Read this unstarted ticket and the current-week projects through the tracker, then use ticket-project.mjs start for the exact verified status/project update.";
}

/** Keep tracker observations in separate private slots so parallel project/identity reads cannot erase each other. */
export function ticketProjectEvidencePath(session, home = os.homedir()) {
  if (!SESSION_KEY.test(session ?? "")) throw new Error("a valid harness conversation ID is required");
  return path.join(home, ".vibe-hook-scope", "ticket-project", session);
}

/** Persist only authority-bearing project, identity and ticket fields from the tracker's successful read response. */
export function recordTicketProjectObservation(session, kind, input, response, { home = os.homedir(), now = Date.now() } = {}) {
  const directory = ticketProjectEvidencePath(session, home);
  const actor = (value) => ({ id: value?.id, organizationId: value?.organizationId ?? null });
  const project = (value) => ({ ...actor(value), name: value.name, slug: value.slug ?? null });
  let key;
  let observed;
  if (kind === "identity" && validActor(response)) {
    key = "actor";
    observed = actor(response);
  } else if (kind === "project" && trackerRow(response) && response.name) {
    key = `project-${response.id}`;
    observed = project(response);
  } else if (kind === "ticket" && trackerRow(response) && isIssue(response.slug)) {
    key = `ticket-${response.slug.toUpperCase()}`;
    observed = { ...actor(response), slug: response.slug, status: response.status };
  } else if (kind === "projects") {
    const rows = Array.isArray(response) ? response : response?.projects ?? response?.items ?? response?.data;
    if (!Array.isArray(rows)) return;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return;
    key = `page-${offset}`;
    const hasMore = response?.hasMore ?? response?.pagination?.hasMore ?? (typeof response?.total === "number" ? offset + rows.length < response.total : rows.length >= limit);
    observed = { projects: rows.filter((row) => trackerRow(row) && row.name).map(project), next: hasMore ? offset + rows.length : null };
  }
  if (key) writeAtomic(path.join(directory, `${key}.json`), { at: now, observed });
}

/** Read fresh, exact tracker evidence for this conversation without printing its identity or raw tool replies. */
export function readTicketProjectEvidence(session, home = os.homedir(), now = Date.now()) {
  const directory = ticketProjectEvidencePath(session, home);
  if (!existsSync(directory)) return {};
  const rows = new Map();
  for (const filename of readdirSync(directory)) {
    if (!/^(?:actor|(?:project|ticket|page)-[a-z0-9-]+)\.json$/i.test(filename)) continue;
    const { at, observed } = regularJson(path.join(directory, filename));
    if (Number.isFinite(at) && at <= now && now - at < OBSERVATION_AGE_MS) rows.set(filename.slice(0, -5), observed);
  }
  const projects = [...rows].filter(([key]) => key.startsWith("project-")).map(([, item]) => item);
  const tickets = Object.fromEntries([...rows].filter(([key]) => key.startsWith("ticket-")).map(([key, item]) => [key.slice(7), item]));
  let offset = 0;
  let complete = false;
  while (rows.has(`page-${offset}`)) {
    const page = rows.get(`page-${offset}`);
    projects.push(...page.projects);
    if (page.next === null) { complete = true; break; }
    if (page.next <= offset) break;
    offset = page.next;
  }
  return { actor: rows.get("actor"), projects, tickets, complete };
}

async function main(argv, home = os.homedir()) {
  const [action, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { session: { type: "string" }, answer: { type: "string" }, repo: { type: "string" },
    "verified-choice": { type: "string" }, ticket: { type: "string" } } });
  if (action === "remember-repo") {
    if (!values.repo) throw new Error("remember-repo needs --repo");
    return updateVibeUserConfig(home, (config) => ({ config: { ...config, repo: path.resolve(values.repo) }, result: { ok: true } }));
  }
  if (action === "seed") {
    const choice = JSON.parse(readFileSync(values["verified-choice"], "utf8"));
    return { ok: true, project: await rememberBacklogProject(choice.actor, choice.project, home) };
  }
  const observed = readTicketProjectEvidence(values.session, home);
  if (action === "ask") return backlogProjectQuestion(observed.actor, { home, answer: values.answer, projects: observed.projects ?? [], complete: observed.complete === true });
  if (action === "start") {
    if (!observed.complete) throw new Error("Read every tracker project page before resolving the current week");
    return ticketWorkStart(observed.actor, observed.tickets?.[values.ticket?.toUpperCase()], observed.projects ?? []);
  }
  throw new Error("Use ask, start, remember-repo, or seed with a verified choice");
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
