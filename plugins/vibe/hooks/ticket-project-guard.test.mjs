import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindProvider, makeHome } from "../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { rememberBacklogProject } from "../skills/vibe/scripts/ticket-project.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";
import { observeTicketProject, ticketProjectGuard } from "./ticket-project-guard.mjs";

const PRE = fileURLToPath(new URL("./pre-tool-use.mjs", import.meta.url));
const POST = fileURLToPath(new URL("./post-tool-use.mjs", import.meta.url));
const ME = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
const BACKLOG = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", organizationId: ME.organizationId, slug: "PRO-7", name: "Own Backlog" };
const day = new Date();
const today = `${day.getUTCMonth() + 1}/${day.getUTCDate()}`;
const WEEK = { ...BACKLOG, id: "dddddddd-dddd-dddd-dddd-dddddddddddd", slug: "PRO-8", name: `${today}-${today}` };

function hookFixture(t, skill) {
  const { root, home, cleanup } = makeHome("vibe-ticket-project-hooks-");
  t.after(cleanup);
  const conversation = "project-guard-fixture";
  const env = { ...process.env, HOME: home, ...bindProvider(home, { conversation }) };
  recordHookSkill(conversation, `vibe:${skill}`, home);
  const invoke = (script, tool, input, output) => {
    const event = { tool_name: `mcp__closedloop__${tool}`, tool_input: input, tool_response: output, cwd: root, session_id: conversation };
    const finished = spawnSync(process.execPath, [script], { cwd: root, env, input: JSON.stringify(event), encoding: "utf8", timeout: 5000 });
    assert.equal(finished.status, 0, finished.stderr || finished.error?.message);
    return finished.stdout.trim() ? JSON.parse(finished.stdout).hookSpecificOutput : null;
  };
  return { home, pre: (tool, input) => invoke(PRE, tool, input), observe: (tool, input, output) =>
    invoke(POST, tool, input, { content: [{ type: "text", text: JSON.stringify(output) }] }) };
}

test("ISS-14476 a non-MCP tool call never reads the session's provider record in either ticket-project hook", (t) => {
  const { root, home, cleanup } = makeHome("vibe-ticket-project-scope-");
  t.after(cleanup);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, ".git", "vibe-session.json"), "{broken");
  const event = (tool) => ({ tool_name: tool, tool_input: {}, tool_response: {}, cwd: root, session_id: "scope-fixture" });
  assert.throws(() => ticketProjectGuard(event("mcp__closedloop__create-document"), home), /cannot be read/,
    "a tracker-shaped call reaches the session's provider record");
  for (const tool of ["Bash", "Read", "Edit"]) {
    assert.equal(observeTicketProject(event(tool), home), null, tool);
    assert.equal(ticketProjectGuard(event(tool), home), null, tool);
  }
});

test("AC-76 ISS-14476 actual tracker hook protects direct Vibe, split and seed issue creation", async (t) => {
  for (const skill of ["vibe", "cl-split", "vibe-seed-refresh"]) {
    const f = hookFixture(t, skill);
    f.observe("get_me", {}, ME);
    const content = "Delivery placement: unrelated: separate fixture";
    const create = (projectId, status = "BACKLOG") => f.pre("create_document", { projectId, status, type: "ISSUE", content, repositorySelection: { primary: { fullName: "acme/widgets" } } });
    assert.match(create(BACKLOG.id).permissionDecisionReason, /saved backlog project/);
    await rememberBacklogProject(ME, BACKLOG, f.home);
    assert.equal(create(BACKLOG.id), null);
    assert.match(create(WEEK.id).permissionDecisionReason, /exact saved backlog project ID/);
    assert.match(create(BACKLOG.id, "IN_PROGRESS").permissionDecisionReason, /separate In Progress/);
    assert.equal(f.pre("create_document", { type: "DOC", projectId: WEEK.id }), null);
  }
});

test("ISS-14476 actual tracker project move requires the live previous ticket and exact weekly In Progress transition", (t) => {
  const f = hookFixture(t, "cl-execute");
  f.observe("get_me", {}, ME);
  // The live list-projects page and get-document reply carry no organizationId (read-only tracker calls, 2026-11-24).
  f.observe("list_projects", { limit: 10 }, { total: 2, offset: 0, limit: 10, returned: 2, hasMore: false, nextOffset: null,
    items: [BACKLOG, WEEK].map(({ id, name, slug }) => ({ id, name, slug, status: "NOT_STARTED", updatedAt: "2026-11-02T23:58:19.474Z" })) });
  const ticket = { id: "01a1f1d2-9e26-745f-8907-28c7dbab95e6", title: "Fixture ticket", slug: "ISS-7", type: "FEATURE", status: "BACKLOG",
    projectId: BACKLOG.id, priority: null, assigneeId: ME.id, latestVersion: 1 };
  f.observe("get_document", { documentId: "ISS-7" }, ticket);
  const update = (input) => f.pre("update_document", { documentId: "ISS-7", ...input });
  const exact = { projectId: WEEK.id, status: "IN_PROGRESS", expectedStatus: "BACKLOG" };
  assert.equal(update(exact), null);
  assert.equal(update({ status: "TODO" }), null);
  assert.match(update({ projectId: WEEK.id }).permissionDecisionReason, /only on the verified/);
  assert.match(update({ ...exact, expectedStatus: "TODO" }).permissionDecisionReason, /exact verified/);
  assert.match(update({ ...exact, documentId: "ISS-8" }).permissionDecisionReason, /exact verified/);
  f.observe("get_document", {}, { ...ticket, status: "IN_PROGRESS" });
  assert.match(update(exact).permissionDecisionReason, /exact verified/);
});
