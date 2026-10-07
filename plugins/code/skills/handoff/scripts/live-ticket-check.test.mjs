import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkLiveTicket, parseSections, TICKET_SECTIONS } from "./live-ticket-check.mjs";
import { renderRecordSections, vercelAliases } from "../../vibe/scripts/vibe-session-data.mjs";
import { runNode } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "live-ticket-check.mjs");
const TEMPLATE = path.join(HERE, "..", "..", "vibe", "references", "ticket-template.md");
const TEMPLATE_BODY = /````markdown\n([\s\S]*?)\n````\n?$/;

const ENVIRONMENT = [
  "- Branch: `vibe/tags` (base: origin/main at `abcdef1234`)",
  "- Data: seeded (Acme Co sample data)",
  "- App: https://app-stage-git-vibe-tags.preview.closedloop-stage.ai",
  "- API: https://api-stage-git-vibe-tags.preview.closedloop-stage.ai",
  "- Storybook: https://prototypes-git-vibe-tags.preview.closedloop-stage.ai/storybook",
  "- Last deployed: `abcdef1234` at 2026-10-06T16:00:00.000Z",
].join("\n");

function completeTicket(scope, overrides = {}) {
  const sections = {
    "What this is": "Bulk select with tag editing on Sessions and Branches.",
    "Scope and acceptance criteria": "- Scope: both lists\n- Acceptance criteria:\n  - [ ] Select several rows and edit their tags",
    Environment: ENVIRONMENT,
    Progress: "- 2026-10-06: added bulk select to `<SessionsTable>`",
    "API requirements": "### 1. Save tags for many sessions\n\n- Kind: write",
    "Backend built": "- `PATCH /sessions/tags` in `apps/api/app/sessions/tags/route.ts`",
    "Backend still missing": "None.",
    "Production flag snapshot": "Taken 2026-10-06T15:00:00Z as PostHog user `user_1`. 1 flags.\n\n| Flag | Value |\n|---|---|\n| `a` | true |",
    Sessions: "- Codex session (orchestrator): `01a11209-54a0-72c0-8255-68692884c10f`",
    Handoff: "- Checks: all pass",
    Grading: "Set `Design grade` or `Eng grade`.\n\n```\nGrade: High / Medium / Low\n```",
    "Engineering checklist": "- [ ] Open the pull request",
    ...overrides,
  };
  return TICKET_SECTIONS.filter(({ scopes }) => scopes.includes(scope))
    .map(({ heading }) => `## ${heading}\n\n${sections[heading]}\n`)
    .join("\n");
}

test("the checked sections are exactly the template's headings, in order", () => {
  const body = TEMPLATE_BODY.exec(readFileSync(TEMPLATE, "utf8"))?.[1];
  assert.ok(body, "the template has a fenced markdown body");
  assert.deepEqual([...parseSections(body).keys()], TICKET_SECTIONS.map(({ heading }) => heading));
});

test("a complete ticket passes for its own scope", () => {
  assert.deepEqual(checkLiveTicket(completeTicket("draft"), "draft"), { ok: true, scope: "draft", problems: [] });
  assert.deepEqual(checkLiveTicket(completeTicket("full"), "full"), { ok: true, scope: "full", problems: [] });
});

test("the template itself is never complete", () => {
  const body = TEMPLATE_BODY.exec(readFileSync(TEMPLATE, "utf8"))[1];
  const result = checkLiveTicket(body, "draft");
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(({ problem }) => problem.startsWith("still has the template placeholder")));
});

test("pending markers, placeholders, missing record fields, and wrong-scope sections are each reported", () => {
  const draft = completeTicket("draft", {
    Progress: "Pending.",
    "What this is": "<Two or three sentences in the person's words>",
    Environment: ENVIRONMENT.replace(/- Storybook: \S+/, "- Storybook: Pending."),
    Sessions: "Pending.",
    "Production flag snapshot": "Pending.",
  });
  const result = checkLiveTicket(`${draft}\n## Backend built\n\n- something\n`, "draft");
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    { section: "What this is", problem: "still has the template placeholder <Two or three sentences in the person's words>" },
    { section: "Environment", problem: "still has a Pending. marker" },
    { section: "Environment", problem: "has no Storybook URL" },
    { section: "Progress", problem: "still has a Pending. marker" },
    { section: "Backend built", problem: "belongs only to a full scope session" },
    { section: "Production flag snapshot", problem: "still has a Pending. marker" },
    { section: "Production flag snapshot", problem: "has no flag table" },
    { section: "Sessions", problem: "still has a Pending. marker" },
    { section: "Sessions", problem: "lists no orchestrator session id" },
  ]);
});

test("the Engineering checklist keeps only the session's own scope's lines", () => {
  const template = parseSections(TEMPLATE_BODY.exec(readFileSync(TEMPLATE, "utf8"))[1]).get("Engineering checklist");
  assert.match(template, /\(draft scope\)/);
  assert.match(template, /\(full scope\)/);

  const both = [
    "- [ ] Replace each stub with the real API call (draft scope)",
    "- [ ] Review the backend listed under Backend built (full scope)",
    "- [ ] Open the pull request",
  ].join("\n");
  const draft = checkLiveTicket(completeTicket("draft", { "Engineering checklist": both }), "draft");
  assert.deepEqual(draft.problems, [
    { section: "Engineering checklist", problem: "has a line marked (full scope) in a draft scope session" },
  ]);
  const full = checkLiveTicket(completeTicket("full", { "Engineering checklist": both }), "full");
  assert.deepEqual(full.problems, [
    { section: "Engineering checklist", problem: "has a line marked (draft scope) in a full scope session" },
  ]);

  const ownLines = both.split("\n").filter((line) => !line.includes("(full scope)")).join("\n");
  assert.equal(checkLiveTicket(completeTicket("draft", { "Engineering checklist": ownLines }), "draft").ok, true);
  const handoff = "- Checks: lint, typecheck, tests (full scope: every lane), each pass";
  assert.equal(checkLiveTicket(completeTicket("draft", { Handoff: handoff }), "draft").ok, true);
});

test("a missing or empty section fails, and code spans never count as placeholders", () => {
  const missing = completeTicket("full").replace(/## Backend still missing\n\nNone\.\n/, "");
  assert.deepEqual(checkLiveTicket(missing, "full").problems, [{ section: "Backend still missing", problem: "missing" }]);
  const empty = completeTicket("full", { Handoff: "" });
  assert.deepEqual(checkLiveTicket(empty, "full").problems, [{ section: "Handoff", problem: "empty" }]);
  const withCode = completeTicket("draft", { Progress: "- uses `<Link>` and\n```tsx\n<Badge>\n```" });
  assert.equal(checkLiveTicket(withCode, "draft").ok, true);
});

test("the CLI prints the result and exits non-zero when incomplete", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-ticket-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ticket.md");
  writeFileSync(file, completeTicket("draft"));
  const pass = runNode(SCRIPT, ["--file", file, "--scope", "draft"], dir);
  assert.equal(pass.status, 0);
  assert.equal(pass.json.ok, true);
  const fail = runNode(SCRIPT, ["--file", file, "--scope", "full"], dir);
  assert.equal(fail.status, 1);
  assert.ok(fail.json.problems.some(({ section }) => section === "API requirements"));
  const badScope = runNode(SCRIPT, ["--file", file, "--scope", "huge"], dir);
  assert.equal(badScope.status, 1);
  assert.match(badScope.json.error, /--scope/);
});

test("the sections ticket-sections renders from a finished record pass the check, and a fresh one does not", () => {
  const branch = "vibe/tags";
  const fresh = {
    branch,
    baseCommit: "abcdef1234567890",
    mode: "seeded",
    vercel: { ...vercelAliases(branch), lastDeployedCommit: null, lastDeployedAt: null },
    flagSnapshot: null,
    codexSessions: { orchestrators: [], subagents: [] },
  };
  const rendered = parseSections(renderRecordSections(fresh, null));
  const pending = checkLiveTicket(
    completeTicket("draft", Object.fromEntries(rendered)),
    "draft"
  );
  assert.deepEqual(
    pending.problems.map(({ section }) => section),
    [
      "Environment",
      "Environment",
      "Environment",
      "Environment",
      "Production flag snapshot",
      "Production flag snapshot",
      "Sessions",
      "Sessions",
    ]
  );

  const finished = {
    ...fresh,
    vercel: {
      ...fresh.vercel,
      lastDeployedCommit: "abcdef1234567890",
      lastDeployedAt: "2026-10-06T16:00:00.000Z",
      verifiedAt: "2026-10-06T16:00:00.000Z",
    },
    flagSnapshot: { takenAt: "2026-10-06T15:00:00Z" },
    codexSessions: { orchestrators: [{ id: "thread-1" }], subagents: [{ id: "child-1", role: "vibe-change-worker" }] },
  };
  const snapshot = { takenAt: "2026-10-06T15:00:00Z", distinctId: "user_1", flags: { a: true } };
  const filled = parseSections(renderRecordSections(finished, snapshot));
  assert.deepEqual(checkLiveTicket(completeTicket("draft", Object.fromEntries(filled)), "draft").problems, []);
});

test("with --base-commit, the Environment section must name the branch's current base", (t) => {
  const ticket = completeTicket("draft");
  assert.deepEqual(checkLiveTicket(ticket, "draft", { baseCommit: "abcdef1234567890aa" }).problems, []);

  // ISS-12135: the branch merged main after the session started, so its base moved.
  const stale = checkLiveTicket(ticket, "draft", { baseCommit: "a55ebc7cfb00000000" });
  assert.deepEqual(stale.problems, [
    { section: "Environment", problem: "names base abcdef1234, but the branch's base is a55ebc7cfb" },
  ]);

  const unnamed = completeTicket("draft", {
    Environment: ENVIRONMENT.replace(" (base: origin/main at `abcdef1234`)", ""),
  });
  assert.deepEqual(checkLiveTicket(unnamed, "draft", { baseCommit: "a55ebc7cfb" }).problems, [
    { section: "Environment", problem: "names no base commit; the branch's base is a55ebc7cfb" },
  ]);
  assert.deepEqual(checkLiveTicket(unnamed, "draft").problems, []);

  const dir = mkdtempSync(path.join(tmpdir(), "live-ticket-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ticket.md");
  writeFileSync(file, ticket);
  const cli = runNode(SCRIPT, ["--file", file, "--scope", "draft", "--base-commit", "a55ebc7cfb"], dir);
  assert.equal(cli.status, 1);
  assert.deepEqual(cli.json.problems.map(({ section }) => section), ["Environment"]);
});
