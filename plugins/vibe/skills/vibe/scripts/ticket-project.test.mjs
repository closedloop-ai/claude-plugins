import assert from "node:assert/strict";
import test from "node:test";
import { bindProviderInProcess, makeHome } from "./test-fixtures.mjs";
import { backlogProjectQuestion, rememberBacklogProject, readTicketProjectEvidence, recordTicketProjectObservation, resolveBacklogProject, savedBacklogProject, ticketWorkStart } from "./ticket-project.mjs";
import { readVibeUserConfig, updateVibeUserConfig } from "../../../lib/vibe/scripts/vibe-user-config.mjs";

bindProviderInProcess(test.after);

const ACTOR = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
const PERSON = { ...ACTOR, id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" };
const PROJECT = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", organizationId: ACTOR.organizationId, slug: "PRO-7", name: "Product Backlog" };
const DUPLICATE = { ...PROJECT, id: "dddddddd-dddd-dddd-dddd-dddddddddddd", slug: "PRO-8" };
const WEEK = { ...PROJECT, id: "99999999-9999-9999-9999-999999999999", slug: "PRO-9", name: "11/16-11/20" };
const NOW = Date.parse("2026-11-19T21:25:00Z");
const expected = { id: PROJECT.id, name: PROJECT.name, slug: PROJECT.slug };
// The live tracker reply shapes (read-only get-me, list-projects and get-document calls, 2026-11-24): only the current-user
// record carries organizationId; a project page and a ticket do not, and a project's slug may be null.
const projectsPage = (projects, { offset = 0, limit = 50, total = projects.length } = {}) => ({ total, offset, limit,
  returned: projects.length, hasMore: offset + projects.length < total, nextOffset: offset + projects.length < total ? offset + projects.length : null,
  items: projects.map(({ id, name, slug }) => ({ id, name, slug, status: "NOT_STARTED", updatedAt: "2026-11-02T23:58:19.474Z" })) });
const liveTicket = (slug, status) => ({ id: "01a1f1d2-9e26-745f-8907-28c7dbab95e6", title: "Fixture ticket", slug, type: "FEATURE", status,
  projectId: PROJECT.id, priority: null, assigneeId: ACTOR.id, latestVersion: 1, updatedAt: "2026-11-19T16:48:05.017Z" });

test("AC-76 ISS-14476 resolves full project URL, exact name, UUID and slug using tracked projects only", () => {
  for (const input of [`https://app.closedloop.ai/projects/${PROJECT.id}`, PROJECT.name, PROJECT.id, PROJECT.slug]) {
    assert.deepEqual(resolveBacklogProject(input, [PROJECT], ACTOR), { status: "confirmed", project: expected });
  }
  assert.deepEqual(resolveBacklogProject(PROJECT.name, [PROJECT, DUPLICATE], ACTOR), { status: "ambiguous", count: 2 });
  assert.equal(resolveBacklogProject("no project", [PROJECT], ACTOR).status, "not-found");
  assert.equal(resolveBacklogProject(PROJECT.name, [PROJECT], ACTOR, { complete: false }).status, "incomplete");
  assert.equal(resolveBacklogProject("https://not-closedloop.example/projects/PRO-7", [PROJECT], ACTOR).status, "not-found");
  assert.equal(resolveBacklogProject(WEEK.id, [WEEK], ACTOR).status, "weekly");
  assert.equal(resolveBacklogProject(PROJECT.id, [{ ...PROJECT, organizationId: PERSON.id }], ACTOR).status, "not-found");
});

test("AC-76 ISS-14476 asks once, asks anew only after unresolved answers, and saves by person without replacing repo config", async (t) => {
  const { home, cleanup } = makeHome("vibe-backlog-choice-");
  t.after(cleanup);
  await updateVibeUserConfig(home, (current) => ({ config: { ...current, repo: "/existing" } }));
  const ask = (options = {}) => backlogProjectQuestion(ACTOR, { home, ...options });
  const first = await ask();
  assert.equal(first.ask, true);
  assert.equal((await ask()).ask, false);
  assert.equal((await ask({ answer: PROJECT.name, projects: [PROJECT], complete: false })).status, "incomplete");
  const ambiguous = await ask({ answer: PROJECT.name, projects: [PROJECT, DUPLICATE], complete: true });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.ask, true);
  assert.notEqual(ambiguous.key, first.key);
  assert.equal((await ask()).ask, false);
  const missing = await ask({ answer: "no candidate", projects: [PROJECT], complete: true });
  assert.equal(missing.status, "not-found");
  assert.equal(missing.ask, true);
  const accepted = await ask({ answer: PROJECT.id, projects: [PROJECT] });
  assert.deepEqual(accepted.project, expected);
  assert.deepEqual(await ask(), { status: "saved", project: expected, ask: false });
  assert.equal(savedBacklogProject(PERSON, home), null);
  await rememberBacklogProject(PERSON, { ...DUPLICATE, slug: null }, home);
  assert.equal(savedBacklogProject(PERSON, home).slug, null);
  assert.deepEqual(savedBacklogProject(ACTOR, home), expected);
  assert.equal(readVibeUserConfig(home).repo, "/existing");
});

test("ISS-14476 ADV-1 live list-projects and get-document replies without organizationId resolve the backlog by name and start work", (t) => {
  const { home, cleanup } = makeHome("vibe-project-live-shape-");
  t.after(cleanup);
  const session = "live-shape-reads";
  const write = (action, input, output) => recordTicketProjectObservation(session, action, input, output, { home, now: NOW });
  write("identity", {}, { ...ACTOR, email: "person@example.invalid", role: "ENGINEER" });
  write("projects", { limit: 2 }, projectsPage([PROJECT, WEEK], { limit: 2 }));
  write("ticket", { documentId: "ISS-7" }, liveTicket("ISS-7", "BACKLOG"));
  const evidence = readTicketProjectEvidence(session, home, NOW);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.projects.length, 2, "project rows without organizationId are kept");
  assert.deepEqual(resolveBacklogProject(PROJECT.name, evidence.projects, evidence.actor), { status: "confirmed", project: expected });
  assert.deepEqual(ticketWorkStart(evidence.actor, evidence.tickets["ISS-7"], evidence.projects, NOW), {
    documentId: "ISS-7", projectId: WEEK.id, status: "IN_PROGRESS", expectedStatus: "BACKLOG",
  });
  const elsewhere = { ...liveTicket("ISS-7", "BACKLOG"), organizationId: PERSON.id };
  assert.throws(() => ticketWorkStart(evidence.actor, elsewhere, evidence.projects, NOW), /unstarted ticket/, "another organization is still refused");
  assert.equal(resolveBacklogProject(PROJECT.id, [{ ...PROJECT, organizationId: PERSON.id }], ACTOR).status, "not-found");
});

test("ISS-14476 combines contiguous tracker pages and produces only the verified start-work project/status update", (t) => {
  const { home, cleanup } = makeHome("vibe-project-observation-");
  t.after(cleanup);
  const session = "tracker-reads";
  const write = (action, input, output) => recordTicketProjectObservation(session, action, input, output, { home, now: NOW });
  write("identity", {}, ACTOR);
  write("projects", { offset: 1, limit: 1 }, [WEEK]);
  assert.equal(readTicketProjectEvidence(session, home, NOW).complete, false);
  write("projects", { offset: 0, limit: 1 }, [PROJECT]);
  assert.equal(readTicketProjectEvidence(session, home, NOW).complete, false);
  write("projects", { offset: 2, limit: 1 }, []);
  const ticket = liveTicket("ISS-7", "BACKLOG");
  write("ticket", {}, ticket);
  const evidence = readTicketProjectEvidence(session, home, NOW);
  assert.equal(evidence.complete, true);
  assert.deepEqual(ticketWorkStart(evidence.actor, evidence.tickets["ISS-7"], evidence.projects, NOW), {
    documentId: "ISS-7", projectId: WEEK.id, status: "IN_PROGRESS", expectedStatus: "BACKLOG",
  });
  assert.throws(() => ticketWorkStart(ACTOR, { ...ticket, status: "IN_PROGRESS" }, [WEEK], NOW), /unstarted ticket/);
  assert.throws(() => ticketWorkStart(ACTOR, ticket, [WEEK, { ...WEEK, id: DUPLICATE.id }], NOW), /exactly one/);
  assert.equal(readTicketProjectEvidence(session, home, NOW + 31 * 60_000).actor, undefined);
});
