import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { APPENDED_SECTIONS, checkLiveTicket, parseSections, TICKET_SECTIONS, VIBE_TICKET_MARKER } from "./live-ticket-check.mjs";
import { renderRecordSections, vercelAliases } from "../../vibe/scripts/vibe-session-data.mjs";
import { localPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { bindProviderInProcess, PROVIDER_BINDING, git, makeCheckout, makeHome, runNode } from "../../vibe/scripts/test-fixtures.mjs";
import { HUMAN_RULINGS, SETTLED_BY_ORCHESTRATOR, TRADE_TWIN } from "./settlement-test-fixture.mjs";

// The live ticket exists only with a tracker bound, so these run bound to the ClosedLoop provider.
bindProviderInProcess(after);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "live-ticket-check.mjs");
const PROVIDER = path.join(HERE, "..", "..", "..", "..", "vibe-closedloop-provider");
const TEMPLATE = path.join(PROVIDER, "skills", "closedloop-provider", "references", "ticket-template.md");
const RECIPE = JSON.parse(readFileSync(path.join(PROVIDER, "provider.json"), "utf8")).data.recipes.environment;
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
    "What this is": `Bulk select with tag editing on Sessions and Branches.\n\n${VIBE_TICKET_MARKER} Dana Lee.`,
    "Scope and acceptance criteria": "- Scope: both lists\n- Newest ruling: ISS-12592, 2026-10-15, \"tag editing stays on the list page\"\n- Prior removal: none found (searched: fts_search tag editor remove)\n- Acceptance criteria:\n  - [ ] Select several rows and edit their tags",
    Environment: ENVIRONMENT,
    Progress: "- 2026-10-06: added bulk select to `<SessionsTable>`",
    "Backend built": "- `PATCH /sessions/tags` in `apps/api/app/sessions/tags/route.ts`",
    "Backend still missing": "None.",
    "Production flag snapshot": "Taken 2026-10-06T15:00:00Z as PostHog user `user_1`. 1 flags.\n\n| Flag | Value |\n|---|---|\n| `a` | true |\n\n### Keys to see this work\n\n| Surface | Hosts | Key | Origin | Approval | In this snapshot |\n|---|---|---|---|---|---|\n| Tags | web | `a` | existing key | on main | true |",
    Sessions: "- Codex session (orchestrator): `01a11209-54a0-72c0-8255-68692884c10f`",
    Handoff: "- Checks: all pass\n- Assumptions: None: no Spec Card",
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
  assert.ok(body.includes(VIBE_TICKET_MARKER), "a ticket created from the template carries the marker that keeps it fully checked");
});

test("a complete ticket passes", () => {
  assert.deepEqual(checkLiveTicket(completeTicket()), { ok: true, problems: [] });
});

test("ISS-14304: a classified no-UI diff accepts a recorded no-environment ruling, never fake URLs", () => {
  const ruling = "- No environment: operator, 2026-11-16, AskUserQuestion: approved code-only handoff";
  const noEnvironment = completeTicket({
    Environment: `${ENVIRONMENT.split("\n").slice(0, 2).join("\n")}\n${ruling}`,
    "Production flag snapshot": ruling,
  });
  const rulingsText = `${ruling}\n`;
  assert.deepEqual(checkLiveTicket(noEnvironment, { diffFiles: [{ path: "tools/vibe-workers/src/ledger.ts", status: "M" }], rulingsText }),
    { ok: true, problems: [] });
  assert.ok(checkLiveTicket(noEnvironment, { diffFiles: [{ path: "tools/vibe-workers/src/ledger.ts", status: "M" }] }).problems
    .some(({ problem }) => /canonical private vibe-changes/.test(problem)));
  const orchestratorOnly = noEnvironment.replace("operator, 2026-11-16, AskUserQuestion: approved", "(orchestrator), approved");
  assert.ok(checkLiveTicket(orchestratorOnly, { diffFiles: [{ path: "tools/vibe-workers/src/ledger.ts", status: "M" }], rulingsText }).problems
    .some(({ problem }) => /canonical private vibe-changes/.test(problem)));
  for (const untrusted of [
    "reviewer, 2026-11-16, chat: approved code-only handoff",
    "vibe agent, 2026-11-16, ticket: approved code-only handoff",
    "operator, approved code-only handoff",
    "operator, 2026-11-16, approved code-only handoff",
  ]) {
    const body = noEnvironment.replace("operator, 2026-11-16, AskUserQuestion: approved code-only handoff", untrusted);
    assert.ok(checkLiveTicket(body, { diffFiles: [{ path: "tools/vibe-workers/src/ledger.ts", status: "M" }], rulingsText }).problems
      .some(({ problem }) => /canonical private vibe-changes/.test(problem)), untrusted);
  }
  const ui = checkLiveTicket(noEnvironment, { diffFiles: [{ path: "packages/app/issues/page.tsx", status: "M" }], rulingsText });
  assert.ok(ui.problems.some(({ problem }) => /diff touches a UI path/.test(problem)));
  for (const rendered of ["apps/web/index.html", "apps/web/logo.png", "apps/web/brand.woff2", "apps/web/intro.mp4"]) {
    assert.ok(checkLiveTicket(noEnvironment, { diffFiles: [{ path: rendered, status: "M" }], rulingsText }).problems
      .some(({ problem }) => /diff touches a UI path/.test(problem)), `${rendered} remains a UI change`);
  }

  const fake = completeTicket({ Environment: ENVIRONMENT.replaceAll("preview.closedloop-stage.ai", "preview.closedloop-stage.ai (not deployed)") });
  const problems = checkLiveTicket(fake).problems.filter(({ section }) => section === "Environment");
  assert.deepEqual(problems.map(({ problem }) => problem), ["has no App URL", "has no API URL", "has no Storybook URL"]);
});

test("ISS-14304: the CLI trusts only the worktree's canonical private rulings log", () => {
  const root = mkdtempSync(path.join(tmpdir(), "live-ticket-no-environment-"));
  try {
    const worktree = path.join(root, "wt");
    mkdirSync(worktree);
    git(worktree, ["init", "--quiet", "--initial-branch=main"], process.env.HOME);
    mkdirSync(path.join(worktree, "src"));
    writeFileSync(path.join(worktree, "src/logic.ts"), "export const value = 1;\n");
    git(worktree, ["add", "."], process.env.HOME);
    git(worktree, ["-c", "user.name=t", "-c", "user.email=fixture.invalid", "commit", "--quiet", "-m", "base"], process.env.HOME);
    const base = git(worktree, ["rev-parse", "HEAD"], process.env.HOME);
    writeFileSync(path.join(worktree, "src/logic.ts"), "export const value = 2;\n");
    const ruling = "- No environment: operator, 2026-11-16, AskUserQuestion: approved code-only handoff";
    const ticket = path.join(root, "ticket.md");
    writeFileSync(ticket, completeTicket({
      Environment: `${ENVIRONMENT.split("\n").slice(0, 2).join("\n")}\n${ruling}`,
      "Production flag snapshot": ruling,
    }).replace("abcdef1234", base.slice(0, 10)));
    const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"], process.env.HOME);
    writeFileSync(path.join(gitDir, "vibe-changes.md"), `${ruling}\n`);
    const run = () => runNode(SCRIPT, ["--file", ticket, "--worktree", worktree, "--base-commit", base], process.env.HOME);
    const accepted = run();
    assert.equal(accepted.status, 0, JSON.stringify(accepted.json) + accepted.stderr);
    writeFileSync(path.join(gitDir, "vibe-changes.md"), "No human no-environment ruling.\n");
    const refused = run();
    assert.equal(refused.status, 1);
    assert.match(JSON.stringify(refused.json), /canonical private vibe-changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real Claude orchestrator session satisfies the Sessions contract without a Codex thread", () => {
  const id = "36ee02c3-2de3-45a8-8c33-ae3e5302f554";
  const claude = completeTicket({ Sessions: "- Implementation writer: claude `7b7bdd07-4820-4def-bb4a-0d0fc6de5b1c`\n- Claude Code session (orchestrator): `" + id + "`" });
  assert.deepEqual(checkLiveTicket(claude), { ok: true, problems: [] });
  const missing = completeTicket({ Sessions: "- Implementation writer: claude `7b7bdd07-4820-4def-bb4a-0d0fc6de5b1c`" });
  assert.deepEqual(checkLiveTicket(missing).problems, [{ section: "Sessions", problem: "lists no orchestrator session id" }]);
  for (const sessions of [
    "- Imaginary session (orchestrator): `made-up`",
    "- Claude Code session (orchestrator): `made-up`",
  ]) {
    assert.deepEqual(checkLiveTicket(completeTicket({ Sessions: sessions })).problems,
      [{ section: "Sessions", problem: "lists no orchestrator session id" }]);
  }
  const record = { codexSessions: { orchestrators: [], subagents: [] },
    claudeSessions: { orchestrators: [{ id }] }, flagKeys: { surfaces: [] } };
  assert.deepEqual(checkLiveTicket(claude, { record }).problems, []);
  assert.deepEqual(checkLiveTicket(completeTicket({ Sessions: "- Claude Code session (orchestrator): `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`" }), { record }).problems,
    [{ section: "Sessions", problem: "does not match the session record's orchestrator ids" }]);
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
    "What this is": `<Two or three sentences in the person's words>\n\n${VIBE_TICKET_MARKER} Dana Lee.`,
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
    { section: "Production flag snapshot", problem: "lists no keys to see the work" },
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
    vercel: { ...vercelAliases(branch, RECIPE), lastDeployedCommit: null, lastDeployedAt: null },
    flagSnapshot: null,
    codexSessions: { orchestrators: [], subagents: [] },
  };
  const rendered = parseSections(renderRecordSections(fresh, null, RECIPE));
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
  // Operator ruling, 2026-10-20: the keys to see the work stay Pending until recorded.
  const unrecordedKeys = parseSections(renderRecordSections(finished, snapshot, RECIPE));
  assert.deepEqual(checkLiveTicket(completeTicket(Object.fromEntries(unrecordedKeys))).problems, [
    { section: "Production flag snapshot", problem: "still has a Pending. marker" },
  ]);

  const flagKeys = { surfaces: [{ surface: "Tags", hosts: ["web"], keys: [{ key: "a", origin: "existing", readAt: ["apps/app/tags.tsx"] }] }] };
  const filled = parseSections(renderRecordSections({ ...finished, flagKeys }, snapshot, RECIPE));
  assert.deepEqual(checkLiveTicket(completeTicket(Object.fromEntries(filled))).problems, []);
});

test("the scope must carry the newest ruling on the capability, dated, or the searches that found none", () => {
  const removal = "- Prior removal: ISS-6005 removed the cloud pill; not rebuilt\n";
  const scope = (line, prior = removal) => checkLiveTicket(completeTicket({ "Scope and acceptance criteria": `- Scope: both lists\n${line}${prior}- Acceptance criteria:\n  - [ ] Edit tags` }));
  for (const line of ["", "- Newest ruling: the ticket\n", "- Newest ruling: none found\n"]) {
    assert.deepEqual(scope(line).problems.map(({ section }) => section), ["Scope and acceptance criteria"]);
  }
  const ruled = "- Newest ruling: none found (searched: fts_search tag editing, search_memory_facts, ticket comments)\n";
  assert.equal(scope(ruled).ok, true);
  for (const prior of ["", "- Prior removal: none\n", "- Prior removal: the pill was removed once\n", "- Prior removal: checked the UTF-8 encoder only\n"]) {
    assert.deepEqual(scope(ruled, prior).problems.map(({ problem }) => problem), ["has no Prior removal line (the removing ticket, or none found with the searches run)"]);
  }
});

test("a flag snapshot without the keys to see the work fails the check", () => {
  const withoutKeys = completeTicket({
    "Production flag snapshot": "Taken 2026-10-06T15:00:00Z as PostHog user `user_1`. 1 flags.\n\n| Flag | Value |\n|---|---|\n| `a` | true |",
  });
  assert.deepEqual(checkLiveTicket(withoutKeys).problems, [
    { section: "Production flag snapshot", problem: "lists no keys to see the work" },
  ]);
});

test("a ticket naming a path on the operator's machine or a local plan fails the check", () => {
  const body = completeTicket({ Handoff: "- Screenshot: /Users/x/file.png\n- Log: ~/foo\n- Capture: `.control/runs/a.png`\n- QA plan: .closedloop-ai/vibe-plans/qa.md\n- Attached: `qa-plan.md`\n- Assumptions: None: no Spec Card" });
  // The provider keeps the plans in its in-worktree folder.
  const problems = checkLiveTicket(body, { planPrefix: localPlanPrefix(PROVIDER_BINDING) }).problems;
  const lines = body.split("\n");
  assert.deepEqual(problems.map(({ section, problem }) => [section, lines[Number(/^line (\d+)/.exec(problem)[1]) - 1]]), [
    ["Body", "- Screenshot: /Users/x/file.png"], ["Body", "- Log: ~/foo"], ["Body", "- Capture: `.control/runs/a.png`"],
    ["Body", "- QA plan: .closedloop-ai/vibe-plans/qa.md"],
  ]);
  assert.match(problems[0].problem, /upload and embed/);
  assert.match(problems[3].problem, /link the plan document or attach the file/);
  assert.ok(problems.every(({ problem }) => !problem.includes("/Users/x") && !problem.includes("~/foo")));
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

test("a session with local plans needs its PLN recorded and APPROVED before the ticket is complete", () => {
  const ticket = completeTicket();
  const record = { branch: "vibe/tags", livePlan: null, livePlanStatus: null, flagKeys: { surfaces: [] } };
  assert.deepEqual(checkLiveTicket(ticket, { record, planCount: 0 }).problems, []);
  assert.deepEqual(checkLiveTicket(ticket, { record, planCount: 1 }).problems, [
    { section: "Session plan", problem: "the session has a local plan but no plan document is recorded" },
  ]);
  assert.deepEqual(checkLiveTicket(ticket, { record: { ...record, livePlan: "PLN-7", livePlanStatus: "DRAFT" }, planCount: 1 })
    .problems, [{ section: "Session plan", problem: "PLN-7 is DRAFT, not APPROVED" }]);
  for (const status of ["APPROVED", "EXECUTED"]) {
    assert.deepEqual(checkLiveTicket(ticket, { record: { ...record, livePlan: "PLN-7", livePlanStatus: status }, planCount: 1 })
      .problems, [], status);
  }
});

test("the CLI reads the worktree's plans and record for the session plan check", (t) => {
  const fixture = makeHome("live-ticket-plan-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout });
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], fixture.home);
  const recordFile = path.join(gitDir, "vibe-session.json");
  writeFileSync(recordFile, JSON.stringify({ branch: "main", livePlan: "PLN-7", livePlanStatus: "DRAFT", flagKeys: { surfaces: [] } }));
  mkdirSync(path.join(checkout, ".closedloop-ai/vibe-plans"), { recursive: true });
  writeFileSync(path.join(checkout, ".closedloop-ai/vibe-plans/request-1.md"), "# Plan\n");
  const file = path.join(gitDir, "vibe-live-ticket.md");
  writeFileSync(file, completeTicket());
  const draft = runNode(SCRIPT, ["--file", file, "--worktree", checkout], fixture.home);
  assert.equal(draft.status, 1);
  assert.deepEqual(draft.json.problems, [{ section: "Session plan", problem: "PLN-7 is DRAFT, not APPROVED" }]);
  writeFileSync(recordFile, JSON.stringify({ branch: "main", livePlan: "PLN-7", livePlanStatus: "APPROVED", flagKeys: { surfaces: [] } }));
  const approved = runNode(SCRIPT, ["--file", file, "--worktree", checkout], fixture.home);
  assert.equal(approved.status, 0, JSON.stringify(approved.json));
});

test("a session's flag keys must be recorded, and every proposed key approved and read, before the ticket is complete", () => {
  const ticket = completeTicket();
  const proposed = {
    key: "branches-list-v2", origin: "new", readAt: ["packages/app/branches/branches-list.tsx"],
    reason: "net-new-screen", repoRule: "A flag is required for a net-new screen.", source: "PRD-729: a new screen",
  };
  const flagKeys = { surfaces: [{ surface: "Branches list", hosts: ["web"], keys: [proposed] }] };
  const problems = (record) => checkLiveTicket(ticket, { record }).problems;
  assert.deepEqual(problems({ branch: "vibe/tags" }), [
    { section: "Flag keys", problem: "no keys to see the work are recorded (flag-keys.mjs record)" },
  ]);
  assert.match(problems({ branch: "vibe/tags", flagKeys })[0].problem, /`branches-list-v2` has no approval from the person \(pending\)/);
  // A cited source is not approval, and an answer given for another proposal does not carry over.
  const stale = { ...flagKeys, approvals: { "branches-list-v2": { decision: "approved", fingerprint: "000000000000" } } };
  assert.match(problems({ branch: "vibe/tags", flagKeys: stale })[0].problem, /no approval from the person \(pending\)/);
});

test("a Handoff section with no Assumptions line fails the check", () => {
  const body = completeTicket({ Handoff: "- Checks: all pass" });
  assert.ok(checkLiveTicket(body).problems.some((entry) => entry.section === "Handoff" && entry.problem.includes("no Assumptions line")));
});

// A human-authored engineering ticket from a PRD, adopted by a session, with the sections vibe appended.
const PRD_CHILD_TICKET = [
  "## Summary", "", "Engineering ticket from PRD-321: show the owner on each Branch row.", "",
  "## Requirements", "", "- [ ] AC-1 The owner column shows the assignee's name", "",
  "## Technical notes", "", "Reuse the existing owner chip.", "",
  "## Sessions", "", "- Codex session (orchestrator): `01a11209-54a0-72c0-8255-68692884c10f`", "",
  "## Handoff", "", "- Checks: all pass", "- Assumptions: None: no Spec Card", "",
  "## Grading", "", "Set `Design grade` or `Eng grade`.", "",
].join("\n");

test("ISS-14116: a ticket vibe did not create is checked only for the sections vibe appends", () => {
  const created = { liveTicketCreatedBySession: true, flagKeys: { surfaces: [] } };
  const adopted = { liveTicketCreatedBySession: false, flagKeys: { surfaces: [] } };
  const withoutHandoff = PRD_CHILD_TICKET.replace(/## Handoff\n[\s\S]*?(?=## Grading)/, "");
  const vibeTicketMissing = completeTicket().replace(/## Backend still missing\n\nNone\.\n/, "");
  // Decision table: template marker in the body x the record's ticket provenance.
  const rows = [
    ["human PRD child, no record", PRD_CHILD_TICKET, undefined, []],
    ["human PRD child, adopted record", PRD_CHILD_TICKET, adopted, []],
    ["human PRD child body, created record", PRD_CHILD_TICKET, created, "full"],
    ["human PRD child missing Handoff, adopted record", withoutHandoff, adopted, [{ section: "Handoff", problem: "missing" }]],
    ["vibe ticket missing a section, no record", vibeTicketMissing, undefined, [{ section: "Backend still missing", problem: "missing" }]],
    ["vibe ticket missing a section, created record", vibeTicketMissing, created, [{ section: "Backend still missing", problem: "missing" }]],
    ["vibe-template body, adopted record", vibeTicketMissing, adopted, []],
  ];
  for (const [name, body, record, problems] of rows) {
    if (problems === "full") {
      assert.ok(checkLiveTicket(body, { record }).problems.some((item) => item.section === "Environment" && item.problem === "missing"), name);
      continue;
    }
    assert.deepEqual(checkLiveTicket(body, { record }).problems, problems, name);
  }
  const pendingGrading = PRD_CHILD_TICKET.replace("Set `Design grade` or `Eng grade`.", "Pending.");
  assert.deepEqual(checkLiveTicket(pendingGrading, { record: adopted }).problems,
    [{ section: "Grading", problem: "still has a Pending. marker" }]);
  assert.deepEqual(APPENDED_SECTIONS.filter((heading) => !TICKET_SECTIONS.includes(heading)), []);
});

test("ISS-14679: the handoff ticket check refuses an orchestrator's AC reading and accepted cost, and passes once each quotes a human ruling", (t) => {
  const scope = (entries) => [
    "- Scope: both lists",
    "- Newest ruling: ISS-12592, 2026-10-15, \"tag editing stays on the list page\"",
    "- Prior removal: none found (searched: fts_search tag editor remove)",
    "- Acceptance criteria:",
    "  - [ ] Select several rows and edit their tags",
    ...HUMAN_RULINGS,
    ...entries,
  ].join("\n");
  const settled = completeTicket({
    "Scope and acceptance criteria": scope([`- ${SETTLED_BY_ORCHESTRATOR.optionC}`, `- ${SETTLED_BY_ORCHESTRATOR.acMet}`, `- ${SETTLED_BY_ORCHESTRATOR.lanes}`]),
    "Engineering checklist": `- [ ] Open the pull request\n- ${TRADE_TWIN}`,
  });
  const refused = checkLiveTicket(settled);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.problems.map(({ section }) => section), ["Rulings", "Rulings", "Rulings"]);
  assert.match(refused.problems[1].problem, /^"- Decision \(orchestrator\): ISS-13117 AC-3 .* reads an acceptance criterion with no cited human ruling.*NEEDS_PERSON \(behavior\)/);

  const ruling = '- Ruling 2026-11-24 (designer): "a new saved view is fine for AC-3"; amends: AC-3';
  const answered = completeTicket({
    "Scope and acceptance criteria": scope([ruling, `- ${SETTLED_BY_ORCHESTRATOR.acMet} Per Ruling 2026-11-24 (designer): "a new saved view is fine for AC-3".`]),
  });
  assert.equal(checkLiveTicket(answered).ok, false, "the candidate cannot authenticate its own ruling");
  assert.deepEqual(checkLiveTicket(answered, { rulingSources: [ruling] }), { ok: true, problems: [] });
  const fromRecord = completeTicket({
    "Scope and acceptance criteria": scope([`- ${SETTLED_BY_ORCHESTRATOR.acMet} Per "a new saved view is fine for AC-3".`]),
  });
  assert.equal(checkLiveTicket(fromRecord).ok, false, "a quote no ruling carries is refused");
  assert.equal(checkLiveTicket(fromRecord, { rulingsText: ruling }).ok, false, "a private change-log entry cannot settle behavior");
  assert.deepEqual(checkLiveTicket(fromRecord, { rulingSources: [ruling] }), { ok: true, problems: [] });
  const { root, home, cleanup } = makeHome("settlement-authority-");
  t.after(cleanup);
  const file = path.join(root, "candidate.md");
  writeFileSync(file, answered);
  const chat = "settlement-operator";
  const run = () => runNode(SCRIPT, ["--file", file], home, { CODEX_THREAD_ID: chat, CLAUDE_CODE_SESSION_ID: chat });
  assert.equal(run().status, 1, "a ticket draft's self-citation fails at the CLI");
  const program = path.join(home, "programs", "scope");
  const binding = path.join(home, ".vibe-hook-scope", "fleet-binding");
  mkdirSync(program, { recursive: true });
  mkdirSync(binding, { recursive: true });
  writeFileSync(path.join(binding, chat + ".json"), JSON.stringify({ chat, home, program: "scope" }));
  writeFileSync(path.join(program, "rulings.md"), '- Ruling 2026-11-24 (operator message: transcript 8): "a new saved view is fine for AC-3"');
  assert.equal(run().status, 0, "the same CLI accepts independently recorded program words");
});

test("ISS-14679: on an adopted ticket only the sections vibe appends are checked for settlements", () => {
  const adopted = { liveTicketCreatedBySession: false, flagKeys: { surfaces: [] } };
  const humanScope = PRD_CHILD_TICKET.replace("Reuse the existing owner chip.", `- ${SETTLED_BY_ORCHESTRATOR.acMet}`);
  assert.deepEqual(checkLiveTicket(humanScope, { record: adopted }).problems, [], "a human-authored section is never vibe's to refuse");
  const appended = PRD_CHILD_TICKET.replace("- Assumptions: None: no Spec Card", `- Assumptions: None: no Spec Card\n- ${SETTLED_BY_ORCHESTRATOR.acMet}`);
  assert.deepEqual(checkLiveTicket(appended, { record: adopted }).problems.map(({ section }) => section), ["Rulings"]);
});
