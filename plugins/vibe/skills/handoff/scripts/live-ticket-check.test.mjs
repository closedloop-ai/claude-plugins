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

const DESIGN_REVIEW = [
  "- App and Storybook previews: https://app.example.invalid and https://storybook.example.invalid, fixture commit `abcdef1234567890abcdef1234567890abcdef1234`; protection unverified.",
  "- Scope: fixture UI, web source-only; Desktop unverified.",
  "- Storybook inventory: fixture component/story, controls/Docs/play declared; no actual browser inspection.",
  "- Footprint/catalog: synthetic fixture evidence only.",
  "- Visual evidence: no inspection; known gap is unverified appearance; remaining design decision is review at pickup.",
].join("\n");

function completeTicket(overrides = {}) {
  const sections = {
    "What this is": "Bulk select with tag editing on Sessions and Branches.",
    "Scope and acceptance criteria": "- Scope: both lists\n- Acceptance criteria:\n  - [ ] Select several rows and edit their tags",
    Environment: ENVIRONMENT,
    Progress: "- 2026-10-06: added bulk select to `<SessionsTable>`",
    "Backend built": "- `PATCH /sessions/tags` in `apps/api/app/sessions/tags/route.ts`",
    "Backend still missing": "None.",
    "Production flag snapshot": "Taken 2026-10-06T15:00:00Z as PostHog user `user_1`. 1 flags.\n\n| Flag | Value |\n|---|---|\n| `a` | true |",
    Sessions: "- Codex session (orchestrator): `01a11209-54a0-72c0-8255-68692884c10f`",
    Handoff: "- Checks: all pass",
    "Design Review": DESIGN_REVIEW,
    Grading: "Set `Design grade` or `Eng grade`.\n\n```\nGrade: High / Medium / Low\n```",
    "Engineering checklist": "- [ ] Open the pull request",
    ...overrides,
  };
  return TICKET_SECTIONS.map((heading) => `## ${heading}\n\n${sections[heading]}\n`).join("\n");
}

test("the checked sections are exactly the template's headings, in order", () => {
  const body = TEMPLATE_BODY.exec(readFileSync(TEMPLATE, "utf8"))?.[1];
  assert.ok(body, "the template has a fenced markdown body");
  assert.deepEqual([...parseSections(body).keys()], TICKET_SECTIONS);
});

test("a complete ticket passes", () => {
  assert.deepEqual(checkLiveTicket(completeTicket()), { ok: true, problems: [] });
});

test("the template itself is never complete", () => {
  const body = TEMPLATE_BODY.exec(readFileSync(TEMPLATE, "utf8"))[1];
  const result = checkLiveTicket(body);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(({ problem }) => problem.startsWith("still has the template placeholder")));
});

test("pending markers, placeholders, and missing record fields are each reported", () => {
  const ticket = completeTicket({
    Progress: "Pending.",
    "What this is": "<Two or three sentences in the person's words>",
    Environment: ENVIRONMENT.replace(/- Storybook: \S+/, "- Storybook: Pending."),
    Sessions: "Pending.",
    "Production flag snapshot": "Pending.",
  });
  const result = checkLiveTicket(ticket);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    { section: "What this is", problem: "still has the template placeholder <Two or three sentences in the person's words>" },
    { section: "Environment", problem: "still has a Pending. marker" },
    { section: "Environment", problem: "has no Storybook URL" },
    { section: "Progress", problem: "still has a Pending. marker" },
    { section: "Production flag snapshot", problem: "still has a Pending. marker" },
    { section: "Production flag snapshot", problem: "has no flag table" },
    { section: "Sessions", problem: "still has a Pending. marker" },
    { section: "Sessions", problem: "lists no orchestrator session id" },
  ]);
});

test("a missing or empty section fails, and code spans never count as placeholders", () => {
  const missing = completeTicket().replace(/## Backend still missing\n\nNone\.\n/, "");
  assert.deepEqual(checkLiveTicket(missing).problems, [{ section: "Backend still missing", problem: "missing" }]);
  const empty = completeTicket({ Handoff: "" });
  assert.deepEqual(checkLiveTicket(empty).problems, [{ section: "Handoff", problem: "empty" }]);
  const withCode = completeTicket({ Progress: "- uses `<Link>` and\n```tsx\n<Badge>\n```" });
  assert.equal(checkLiveTicket(withCode).ok, true);
});

test("the CLI prints the result and exits non-zero when incomplete", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-ticket-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ticket.md");
  writeFileSync(file, completeTicket());
  const pass = runNode(SCRIPT, ["--file", file], dir);
  assert.equal(pass.status, 0);
  assert.equal(pass.json.ok, true);
  writeFileSync(file, completeTicket({ Progress: "Pending." }));
  const fail = runNode(SCRIPT, ["--file", file], dir);
  assert.equal(fail.status, 1);
  assert.deepEqual(fail.json.problems, [{ section: "Progress", problem: "still has a Pending. marker" }]);
  const noFile = runNode(SCRIPT, [], dir);
  assert.equal(noFile.status, 1);
  assert.match(noFile.json.error, /--file/);
});

test("the real final-ticket CLI rejects missing, empty or Pending Design Review without claiming visual proof", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-ticket-design-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ticket.md");
  const complete = completeTicket();
  writeFileSync(file, complete);
  const pass = runNode(SCRIPT, ["--file", file], dir);
  assert.equal(pass.status, 0);
  assert.equal(pass.json.ok, true);
  const missing = [...parseSections(complete)].filter(([heading]) => heading !== "Design Review")
    .map(([heading, content]) => `## ${heading}\n\n${content}`).join("\n");
  const cases = [
    [missing, "missing"],
    [completeTicket({ "Design Review": "" }), "empty"],
    [completeTicket({ "Design Review": "Pending." }), "still has a Pending. marker"],
  ];
  for (const [body, problem] of cases) {
    writeFileSync(file, body);
    const fail = runNode(SCRIPT, ["--file", file], dir);
    assert.equal(fail.status, 1, problem);
    assert.deepEqual(fail.json.problems, [{ section: "Design Review", problem }]);
  }
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
  const pending = checkLiveTicket(completeTicket(Object.fromEntries(rendered)));
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
  assert.deepEqual(checkLiveTicket(completeTicket(Object.fromEntries(filled))).problems, []);
});

test("with --base-commit, the Environment section must name the branch's current base", (t) => {
  const ticket = completeTicket();
  assert.deepEqual(checkLiveTicket(ticket, { baseCommit: "abcdef1234567890aa" }).problems, []);

  // ISS-12135: the branch merged main after the session started, so its base moved.
  const stale = checkLiveTicket(ticket, { baseCommit: "a55ebc7cfb00000000" });
  assert.deepEqual(stale.problems, [
    { section: "Environment", problem: "names base abcdef1234, but the branch's base is a55ebc7cfb" },
  ]);

  const unnamed = completeTicket({
    Environment: ENVIRONMENT.replace(" (base: origin/main at `abcdef1234`)", ""),
  });
  assert.deepEqual(checkLiveTicket(unnamed, { baseCommit: "a55ebc7cfb" }).problems, [
    { section: "Environment", problem: "names no base commit; the branch's base is a55ebc7cfb" },
  ]);
  assert.deepEqual(checkLiveTicket(unnamed).problems, []);

  const dir = mkdtempSync(path.join(tmpdir(), "live-ticket-base-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ticket.md");
  writeFileSync(file, ticket);
  const cli = runNode(SCRIPT, ["--file", file, "--base-commit", "a55ebc7cfb"], dir);
  assert.equal(cli.status, 1);
  assert.deepEqual(cli.json.problems.map(({ section }) => section), ["Environment"]);
});
