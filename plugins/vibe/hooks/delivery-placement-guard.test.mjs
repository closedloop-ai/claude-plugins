import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deliveryPlacementProblem } from "../lib/fleet-orchestrator/scripts/delivery-placement.mjs";
import { rememberBacklogProject, recordTicketProjectObservation } from "../../vibe/skills/vibe/scripts/ticket-project.mjs";
import { bindProvider, makeHome } from "../../vibe/skills/vibe/scripts/test-fixtures.mjs";

const STEP = fileURLToPath(new URL("./pre-tool-use.mjs", import.meta.url));
const BOARD = {
  units: { composer: { repo: "acme/widgets", writer: "current" }, "old-unit": { repo: "acme/widgets", closed: true }, other: { repo: "acme/other" } },
  writers: { current: { repo: "acme/widgets", pr: 42 } },
};

test("the tracker issue tool requires a delivery destination or accounted unrelated work", async (t) => {
  const fixture = makeHome("issue-placement-guard-");
  const { root, home } = fixture;
  t.after(fixture.cleanup);
  const transcript = path.join(root, "events.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /cache/vibe/1.0.85/skills/fleet-orchestrator" } }) + "\n");
  writeFileSync(path.join(root, "board.json"), JSON.stringify(BOARD));
  const conversation = "issue-placement-fixture";
  const actor = { id: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), organizationId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
  const project = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", organizationId: actor.organizationId, name: "Fixture backlog", slug: "PRO-9" };
  await rememberBacklogProject(actor, project, home);
  recordTicketProjectObservation(conversation, "identity", {}, actor, { home });
  const env = { ...process.env, HOME: home, FLEET_HOME: root, ...bindProvider(home, { conversation }) };
  const invoke = (content, type = "ISSUE") => {
    const event = { tool_name: "mcp__closedloop__create_document", cwd: root, transcript_path: transcript, session_id: conversation,
      tool_input: { type, content, projectId: project.id, repositorySelection: { primary: { fullName: "acme/widgets" } } } };
    const result = spawnSync(process.execPath, [STEP], { cwd: root, env, input: JSON.stringify(event), encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  };
  assert.match(invoke("Ticket body").permissionDecisionReason, /record one Delivery placement line/);
  assert.match(invoke("```markdown\nDelivery placement: unit composer\n```").permissionDecisionReason, /record one Delivery placement line/);
  assert.equal(invoke("Ticket body", "DOC"), null);
  assert.equal(invoke("Delivery placement: unit composer", "FEATURE"), null);
  assert.match(invoke("Delivery placement: unit old-unit").permissionDecisionReason, /not open/);
  assert.match(invoke("Delivery placement: unrelated: Independent.").permissionDecisionReason, /composer/);
  assert.equal(invoke("Delivery placement: unrelated: composer owns document creation; this changes the release tool."), null);
});

test("existing open PR delivery cannot admit a duplicate fresh PR", () => {
  const base = { repository: "acme/widgets", board: BOARD, isOpenPullRequest: (repo, number) => repo === "acme/widgets" && number === "42" };
  const content = "Delivery placement: open PR #42";
  assert.equal(deliveryPlacementProblem({ ...base, content, operation: "issue" }), null);
  assert.match(deliveryPlacementProblem({ ...base, content, operation: "pull-request" }), /already takes this work/);
  assert.match(deliveryPlacementProblem({ ...base, content: "Delivery placement: unit composer", operation: "pull-request" }), /already delivers unit/);
  assert.match(deliveryPlacementProblem({ ...base, content: "Delivery placement: unit composer", operation: "pull-request", isOpenPullRequest: () => null }), /could not be verified/);
});
