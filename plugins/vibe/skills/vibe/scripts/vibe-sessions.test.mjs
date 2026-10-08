import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-sessions.mjs");
const SPACED_CHECKOUT = ["Documents", "Closedloop.ai - Active Work", "symphony-alpha"];
const OPERATOR_ARGS = ["--operator-id", "user-andy", "--operator-email", "andy@example.com", "--operator-name", "Andy Example"];

function rememberRepo(home, repo) {
  const dir = path.join(home, ".codex", "vibe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ repo }, null, 2)}\n`);
}

function setup(t) {
  const fixture = makeHome("vibe-sessions-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, ...SPACED_CHECKOUT);
  makeCheckout({ root: fixture.root, home: fixture.home, checkout });
  return { ...fixture, checkout };
}

function recordFile(worktree, home) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"], home), "vibe-session.json");
}

test("repo reports a missing remembered checkout instead of guessing", (t) => {
  const { home } = setup(t);
  const result = runNode(SCRIPT, ["repo"], home);
  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /vibe-preflight\.sh/);
});

test("repo, list, and new use the remembered checkout, including a path with spaces", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);

  const repo = runNode(SCRIPT, ["repo"], home);
  assert.equal(repo.json.repo, checkout);

  const created = runNode(
    SCRIPT,
    ["new", "--slug", "board-chips", "--summary", "Board chips", "--mode", "seeded", ...OPERATOR_ARGS],
    home
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.session.worktree, path.join(checkout, ".claude", "worktrees", "vibe-board-chips"));
  assert.deepEqual(created.json.session.localFixes, []);

  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(
    listed.json.sessions.map((session) => [session.slug, session.localFixes]),
    [["board-chips", []]]
  );
});

test("--repo wins over the remembered checkout", (t) => {
  const { root, home, checkout } = setup(t);
  const other = path.join(root, "elsewhere", "symphony-alpha");
  makeCheckout({ root, home, checkout: other });
  rememberRepo(home, checkout);
  const result = runNode(SCRIPT, ["repo", "--repo", other], home);
  assert.equal(result.json.repo, other);
});

test("local-fix records paths per ticket, merges repeats, and list reports them", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const { json } = runNode(
    SCRIPT,
    ["new", "--slug", "fix-me", "--summary", "Fix me", "--mode", "seeded", ...OPERATOR_ARGS],
    home
  );
  const worktree = json.session.worktree;

  const first = runNode(
    SCRIPT,
    ["local-fix", "--worktree", worktree, "--ticket", "ISS-1", "--path", "scripts/b.sh", "--path", "./apps/app/a.ts"],
    home
  );
  assert.equal(first.status, 0, first.stderr);
  runNode(SCRIPT, ["local-fix", "--worktree", worktree, "--ticket", "ISS-1", "--path", "scripts/b.sh", "--path", "scripts/c.sh"], home);
  runNode(SCRIPT, ["local-fix", "--worktree", worktree, "--ticket", "ISS-2", "--path", "apps/api/d.ts"], home);

  const record = JSON.parse(readFileSync(recordFile(worktree, home), "utf8"));
  assert.deepEqual(
    record.localFixes.map((fix) => [fix.ticket, fix.paths]),
    [
      ["ISS-1", ["apps/app/a.ts", "scripts/b.sh", "scripts/c.sh"]],
      ["ISS-2", ["apps/api/d.ts"]],
    ]
  );
  assert.equal(record.summary, "Fix me");

  // touch keeps the fixes it does not know about.
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--summary", "Renamed"], home);
  const listed = runNode(SCRIPT, ["list"], home);
  assert.deepEqual(
    listed.json.sessions[0].localFixes.map((fix) => fix.ticket),
    ["ISS-1", "ISS-2"]
  );
});

test("local-fix rejects paths outside the worktree and missing inputs", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const { json } = runNode(
    SCRIPT,
    ["new", "--slug", "guarded", "--summary", "Guarded", "--mode", "seeded", ...OPERATOR_ARGS],
    home
  );
  const worktree = json.session.worktree;
  const cases = [
    [["--ticket", "ISS-1", "--path", "/etc/hosts"], /relative to the worktree/],
    [["--ticket", "ISS-1", "--path", "../outside.ts"], /relative to the worktree/],
    [["--ticket", "ISS-1"], /--path is required/],
    [["--path", "scripts/a.sh"], /--ticket is required/],
    [["--ticket", "not a slug", "--path", "scripts/a.sh"], /ClosedLoop slug/],
  ];
  for (const [args, message] of cases) {
    const result = runNode(SCRIPT, ["local-fix", "--worktree", worktree, ...args], home);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.json.error, message);
  }
  const record = JSON.parse(readFileSync(recordFile(worktree, home), "utf8"));
  assert.deepEqual(record.localFixes, []);
});

function newSession(t, slug, extra = []) {
  const fixture = setup(t);
  rememberRepo(fixture.home, fixture.checkout);
  const created = runNode(
    SCRIPT,
    ["new", "--slug", slug, "--summary", slug, "--mode", "blank", ...OPERATOR_ARGS, ...extra],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

/**
 * A `gh` first on PATH that logs each call's arguments and exits with
 * `exitCode`, so discard's schema-drop request is observed without GitHub.
 */
function ghStub(root, exitCode) {
  const dir = path.join(root, `gh-stub-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\necho "$*" >> "${log}"\nexit ${exitCode}\n`, { mode: 0o755 });
  return {
    env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("new requires a seeded or blank mode and records the branch's Vercel URLs", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const missing = runNode(SCRIPT, ["new", "--slug", "no-mode", "--summary", "x", ...OPERATOR_ARGS], home);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /--mode is required/);
  const wrong = runNode(
    SCRIPT,
    ["new", "--slug", "wrong-mode", "--summary", "x", "--mode", "local", ...OPERATOR_ARGS],
    home
  );
  assert.equal(wrong.status, 1);
  assert.match(wrong.json.error, /seeded, blank/);

  const created = runNode(
    SCRIPT,
    ["new", "--slug", "tag-edit", "--summary", "Tag edit", "--mode", "seeded", ...OPERATOR_ARGS],
    home
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.session.mode, "seeded");
  assert.deepEqual(created.json.session.vercel, {
    appUrl: "https://app-stage-git-vibe-tag-edit.preview.closedloop-stage.ai",
    apiUrl: "https://api-stage-git-vibe-tag-edit.preview.closedloop-stage.ai",
    storybookUrl: "https://prototypes-git-vibe-tag-edit.preview.closedloop-stage.ai/storybook",
    lastDeployedCommit: null,
    lastDeployedAt: null,
    deploymentIds: null,
    verifiedAt: null,
  });
  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.json.sessions[0].mode, "seeded");
  assert.equal(listed.json.sessions[0].liveTicket, null);
});

test("new records the person running the session and refuses to start without them", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const base = ["new", "--summary", "x", "--mode", "blank"];
  const missing = runNode(SCRIPT, [...base, "--slug", "no-operator"], home);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /--operator-id and --operator-email are required/);
  const noEmail = runNode(SCRIPT, [...base, "--slug", "no-email", "--operator-id", "user-andy"], home);
  assert.equal(noEmail.status, 1);
  assert.match(noEmail.json.error, /--operator-email/);
  const badId = runNode(
    SCRIPT,
    [...base, "--slug", "bad-id", "--operator-id", "Andy Example", "--operator-email", "andy@example.com"],
    home
  );
  assert.equal(badId.status, 1);
  assert.match(badId.json.error, /--operator-id/);
  assert.equal(git(checkout, ["branch", "--list", "vibe/no-operator"], home), "");

  const created = runNode(SCRIPT, [...base, "--slug", "with-operator", ...OPERATOR_ARGS], home);
  assert.equal(created.status, 0, created.stderr);
  const expected = { id: "user-andy", email: "andy@example.com", name: "Andy Example" };
  assert.deepEqual(created.json.session.operator, expected);
  assert.deepEqual(JSON.parse(readFileSync(recordFile(created.json.session.worktree, home), "utf8")).operator, expected);
  const listed = runNode(SCRIPT, ["list"], home);
  assert.deepEqual(listed.json.sessions[0].operator, expected);

  const nameless = runNode(
    SCRIPT,
    [...base, "--slug", "nameless", "--operator-id", "user-dan", "--operator-email", "dan+08252026@example.com"],
    home
  );
  assert.deepEqual(nameless.json.session.operator, { id: "user-dan", email: "dan+08252026@example.com", name: null });
});

test("touch sets the operator on a record written before it existed and keeps it otherwise", (t) => {
  const { home, worktree } = newSession(t, "older");
  const file = recordFile(worktree, home);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.operator;
  writeFileSync(file, JSON.stringify(legacy));
  const shown = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.equal(shown.json.session.operator, null);

  const kept = runNode(SCRIPT, ["touch", "--worktree", worktree, "--summary", "again"], home);
  assert.equal(kept.json.session.operator, null);
  const partial = runNode(SCRIPT, ["touch", "--worktree", worktree, "--operator-email", "andy@example.com"], home);
  assert.equal(partial.status, 1);
  assert.match(partial.json.error, /--operator-id/);
  const set = runNode(
    SCRIPT,
    ["touch", "--worktree", worktree, "--operator-id", "user-andy", "--operator-email", "andy@example.com"],
    home
  );
  assert.deepEqual(set.json.session.operator, { id: "user-andy", email: "andy@example.com", name: null });
  const later = runNode(SCRIPT, ["touch", "--worktree", worktree, "--live-ticket", "ISS-20"], home);
  assert.deepEqual(later.json.session.operator, { id: "user-andy", email: "andy@example.com", name: null });
});

test("touch records the live ticket, accepts the old --handoff-ticket name, and reads old records", (t) => {
  const { home, worktree } = newSession(t, "live-ticket");
  const set = runNode(SCRIPT, ["touch", "--worktree", worktree, "--live-ticket", "ISS-10"], home);
  assert.equal(set.json.session.liveTicket, "ISS-10");
  const alias = runNode(SCRIPT, ["touch", "--worktree", worktree, "--handoff-ticket", "ISS-11"], home);
  assert.equal(alias.json.session.liveTicket, "ISS-11");
  const bad = runNode(SCRIPT, ["touch", "--worktree", worktree, "--live-ticket", "ticket 11"], home);
  assert.equal(bad.status, 1);

  // A record written before the live ticket existed.
  const file = recordFile(worktree, home);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["liveTicket", "mode", "vercel", "flagSnapshot", "codexSessions"]) {
    delete legacy[key];
  }
  legacy.handoffTicket = "ISS-12";
  writeFileSync(file, JSON.stringify(legacy));
  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.json.sessions[0].liveTicket, "ISS-12");
  assert.equal(listed.json.sessions[0].mode, null);
  assert.equal(listed.json.sessions[0].vercel.appUrl, "https://app-stage-git-vibe-live-ticket.preview.closedloop-stage.ai");
  const touched = runNode(SCRIPT, ["touch", "--worktree", worktree, "--summary", "again"], home);
  assert.equal(touched.json.session.liveTicket, "ISS-12");
  assert.equal("handoffTicket" in JSON.parse(readFileSync(file, "utf8")), false);
});

function environmentResult(worktree, home, overrides = {}) {
  return {
    requestId: "req-12345678",
    branch: git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"], home),
    mode: "blank",
    headSha: git(worktree, ["rev-parse", "HEAD"], home),
    appUrl: "https://app-stage-git-vibe-deploys.preview.closedloop-stage.ai",
    apiUrl: "https://api-stage-git-vibe-deploys.preview.closedloop-stage.ai",
    storybookUrl: "https://prototypes-git-vibe-deploys.preview.closedloop-stage.ai/storybook/",
    deploymentIds: { app: "dpl_app", api: "dpl_api", storybook: "dpl_sb" },
    verifiedAt: "2026-10-07T03:00:00Z",
    ...overrides,
  };
}

test("environment-result records only a result verified for this request, branch, mode, and HEAD", (t) => {
  const { root, home, worktree } = newSession(t, "deploys");
  const file = path.join(root, "vibe-environment-result.json");
  const record = (extra = []) =>
    runNode(SCRIPT, ["environment-result", "--worktree", worktree, "--file", file, "--request-id", "req-12345678", ...extra], home);

  const head = git(worktree, ["rev-parse", "HEAD"], home);
  const cases = [
    [{ requestId: "req-other-0001" }, /requestId is "req-other-0001", expected "req-12345678"/],
    [{ branch: "vibe/someone-else" }, /branch is/],
    [{ mode: "seeded" }, /mode is "seeded", expected "blank"/],
    [{ headSha: "0".repeat(40) }, new RegExp(`headSha is "${"0".repeat(40)}", expected "${head}"`)],
    [{ appUrl: "http://app.example" }, /appUrl must be an https URL/],
    [{ storybookUrl: undefined }, /storybookUrl must be an https URL/],
    [{ deploymentIds: { app: "dpl_app", api: "dpl_api" } }, /deploymentIds\.storybook/],
    [{ deploymentIds: undefined }, /deploymentIds must name/],
    [{ verifiedAt: "yesterday" }, /verifiedAt must be an ISO/],
    [{ extra: true }, /unknown field "extra"/],
  ];
  for (const [overrides, message] of cases) {
    writeJson(file, environmentResult(worktree, home, overrides));
    const refused = record();
    assert.equal(refused.status, 1, JSON.stringify(overrides));
    assert.match(refused.json.error, message);
  }
  const unchanged = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.equal(unchanged.json.session.vercel.verifiedAt, null);
  assert.equal(unchanged.json.session.vercel.lastDeployedCommit, null);

  writeJson(file, "not json");
  assert.match(record().json.error, /Could not read a JSON environment result/);
  writeJson(file, environmentResult(worktree, home));
  assert.match(
    runNode(SCRIPT, ["environment-result", "--worktree", worktree, "--file", file], home).json.error,
    /--request-id is required/
  );

  const saved = record();
  assert.equal(saved.status, 0, saved.stderr);
  const vercel = saved.json.session.vercel;
  assert.equal(vercel.storybookUrl, "https://prototypes-git-vibe-deploys.preview.closedloop-stage.ai/storybook");
  assert.equal(vercel.appUrl, "https://app-stage-git-vibe-deploys.preview.closedloop-stage.ai");
  assert.equal(vercel.lastDeployedCommit, head);
  assert.ok(Date.parse(vercel.lastDeployedAt));
  assert.deepEqual(vercel.deploymentIds, { app: "dpl_app", api: "dpl_api", storybook: "dpl_sb" });
  assert.equal(vercel.verifiedAt, "2026-10-07T03:00:00Z");
});

test("flag-snapshot saves a snapshot that matches the contract and refuses one that does not", (t) => {
  const { root, home, worktree } = newSession(t, "flags");
  const file = path.join(root, "snapshot.json");
  writeJson(file, {
    takenAt: "2026-10-06T15:00:00.000Z",
    distinctId: "user_abc",
    orgId: "org-1",
    flags: { "zeta-flag": false, "alpha-flag": true, "beta-test": "variant-b" },
  });
  const saved = runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", file], home);
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(
    { ...saved.json.session.flagSnapshot, file: undefined },
    { takenAt: "2026-10-06T15:00:00.000Z", distinctId: "user_abc", orgId: "org-1", flagCount: 3, file: undefined }
  );
  const stored = JSON.parse(readFileSync(saved.json.session.flagSnapshot.file, "utf8"));
  assert.deepEqual(Object.keys(stored.flags), ["alpha-flag", "beta-test", "zeta-flag"]);
  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.json.sessions[0].flagSnapshotTakenAt, "2026-10-06T15:00:00.000Z");

  const tooMany = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`flag-${i}`, true]));
  const invalid = [
    [{ takenAt: "yesterday", distinctId: "u", flags: {} }, /takenAt/],
    [{ takenAt: "2026-10-06T15:00:00Z", distinctId: "", flags: {} }, /distinctId/],
    [{ takenAt: "2026-10-06T15:00:00Z", distinctId: "u", flags: { a: 1 } }, /flag "a"/],
    [{ takenAt: "2026-10-06T15:00:00Z", distinctId: "u", flags: {}, extra: 1 }, /unknown field "extra"/],
    [{ takenAt: "2026-10-06T15:00:00Z", distinctId: "u", flags: tooMany }, /at most 1000/],
    [{ takenAt: "2026-10-06T15:00:00Z", distinctId: "u", flags: { [`k${"x".repeat(150)}`]: "v".repeat(200), ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${"y".repeat(150)}${i}`, "v".repeat(200)])) } }, /under 65536/],
    ["not json", /Could not read/],
  ];
  for (const [value, message] of invalid) {
    writeJson(file, value);
    const result = runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", file], home);
    assert.equal(result.status, 1, String(message));
    assert.match(result.json.error, message);
  }
  const unchanged = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.equal(unchanged.json.session.flagSnapshot.flagCount, 3);

  // ISS-12135 bug 43: taken once; only a flag refresh (--replace) retakes it.
  writeJson(file, { takenAt: "2026-10-07T07:45:00.000Z", distinctId: "user_abc", flags: { "only-flag": true } });
  const retaken = runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", file], home);
  assert.equal(retaken.status, 1);
  assert.match(retaken.json.error, /already has a flag snapshot \(taken 2026-10-06T15:00:00\.000Z\)/);
  const kept = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.equal(kept.json.session.flagSnapshot.takenAt, "2026-10-06T15:00:00.000Z");
  const refreshed = runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", file, "--replace"], home);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(refreshed.json.session.flagSnapshot.takenAt, "2026-10-07T07:45:00.000Z");
  assert.equal(refreshed.json.session.flagSnapshot.flagCount, 1);
});

function writeRollout(codexHome, day, id, meta) {
  const [year, month, date] = day.split("-");
  const file = path.join(codexHome, "sessions", year, month, date, `rollout-${day}T10-00-00-${id}.jsonl`);
  const payload = { id, session_id: meta.root ?? id, timestamp: `${day}T10:00:00.000Z`, base_instructions: { text: "x".repeat(70_000) }, ...meta.payload };
  writeJson(file, `${JSON.stringify({ type: "session_meta", payload })}\n${JSON.stringify({ type: "event" })}\n`);
}

test("codex-sessions records this thread and every subagent it spawned, nested ones included", (t) => {
  const { root, home, worktree } = newSession(t, "sessions");
  const codexHome = path.join(root, "codex-home");
  const today = new Date().toISOString().slice(0, 10);
  const orchestrator = "01a11209-54a0-72c0-8255-68692884c10f";
  writeRollout(codexHome, today, orchestrator, { payload: { source: "vscode" } });
  writeRollout(codexHome, today, "child-aaaaaaaa", {
    root: orchestrator,
    payload: { parent_thread_id: orchestrator, agent_role: "vibe-change-worker", agent_nickname: "Change" },
  });
  writeRollout(codexHome, today, "grandchild-bbbbbbbb", {
    root: orchestrator,
    payload: { source: { subagent: { thread_spawn: { parent_thread_id: "child-aaaaaaaa", agent_role: "design-system-steward" } } } },
  });
  writeRollout(codexHome, today, "stranger-cccccccc", { payload: { parent_thread_id: "someone-else-1234" } });
  writeRollout(codexHome, "2020-01-01", "ancient-dddddddd", { payload: { parent_thread_id: orchestrator } });

  const env = { CODEX_HOME: codexHome, CODEX_THREAD_ID: orchestrator };
  const result = runNode(SCRIPT, ["codex-sessions", "--worktree", worktree], home, env);
  assert.equal(result.status, 0, result.stderr);
  const sessions = result.json.session.codexSessions;
  assert.deepEqual(sessions.orchestrators.map((entry) => entry.id), [orchestrator]);
  assert.deepEqual(
    sessions.subagents.map((entry) => [entry.id, entry.parentId, entry.role]),
    [
      ["child-aaaaaaaa", orchestrator, "vibe-change-worker"],
      ["grandchild-bbbbbbbb", "child-aaaaaaaa", "design-system-steward"],
    ]
  );

  // A resumed session in a second thread adds an orchestrator, keeping the first.
  const again = runNode(SCRIPT, ["codex-sessions", "--worktree", worktree, "--thread", "second-thread-1234"], home, env);
  assert.deepEqual(again.json.session.codexSessions.orchestrators.map((entry) => entry.id), [orchestrator, "second-thread-1234"]);

  const missing = runNode(SCRIPT, ["codex-sessions", "--worktree", worktree], home, { CODEX_HOME: codexHome, CODEX_THREAD_ID: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /CODEX_THREAD_ID/);
});

test("ticket-sections renders the record's sections and marks what is still pending", (t) => {
  const { root, home, worktree } = newSession(t, "sections");
  const pending = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.json.markdown, /## Environment\n/);
  assert.match(pending.json.markdown, /- Data: blank \(no data\)/);
  assert.match(pending.json.markdown, /- Last deployed: Pending\./);
  assert.match(pending.json.markdown, /## Production flag snapshot\n\nPending\./);
  assert.match(pending.json.markdown, /## Sessions\n\nPending\./);

  const file = path.join(root, "snapshot.json");
  writeJson(file, { takenAt: "2026-10-06T15:00:00Z", distinctId: "user_abc", flags: { "b-flag": "test", "a-flag": false } });
  runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", file], home);
  runNode(SCRIPT, ["codex-sessions", "--worktree", worktree, "--thread", "thread-12345678"], home, { CODEX_HOME: path.join(root, "none") });
  const unverified = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.match(unverified.json.markdown, /- App: Pending\.\n- API: Pending\.\n- Storybook: Pending\./);
  assert.doesNotMatch(unverified.json.markdown, /preview\.closedloop-stage\.ai/);

  const resultFile = path.join(root, "vibe-environment-result.json");
  writeJson(resultFile, environmentResult(worktree, home, {
    appUrl: "https://app-stage-git-vibe-sections.preview.closedloop-stage.ai",
  }));
  const recorded = runNode(
    SCRIPT,
    ["environment-result", "--worktree", worktree, "--file", resultFile, "--request-id", "req-12345678"],
    home
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  const filled = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.doesNotMatch(filled.json.markdown, /Pending\./);
  assert.match(filled.json.markdown, /\| `a-flag` \| false \|\n\| `b-flag` \| `test` \|/);
  assert.match(filled.json.markdown, /as PostHog user `user_abc`\. 2 flags\./);
  assert.match(filled.json.markdown, /- Codex session \(orchestrator\): `thread-12345678`/);
  assert.match(filled.json.markdown, /- App: https:\/\/app-stage-git-vibe-sections\.preview\.closedloop-stage\.ai\/sign-in\n/);
  assert.match(filled.json.markdown, new RegExp(`- Last deployed: \`${git(worktree, ["rev-parse", "HEAD"], home).slice(0, 10)}\``));
});

test("ticket-sections names the branch's current base after the session merges main", (t) => {
  const { home, checkout, worktree } = newSession(t, "merged");
  const started = git(worktree, ["rev-parse", "HEAD"], home);
  const before = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.match(before.json.markdown, new RegExp(`\\(base: origin/main at \`${started.slice(0, 10)}\`\\)`));

  // Main moves on, and the session merges it (ISS-12135).
  writeFileSync(path.join(checkout, "later.md"), "later\n");
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "later on main"], home);
  git(checkout, ["push", "--quiet", "origin", "main"], home);
  const moved = git(checkout, ["rev-parse", "HEAD"], home);
  git(worktree, ["fetch", "--quiet", "origin", "main"], home);
  git(worktree, ["merge", "--quiet", "--no-edit", "origin/main"], home);

  const after = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.json.markdown, new RegExp(`\\(base: origin/main at \`${moved.slice(0, 10)}\`\\)`));
  assert.notEqual(moved, started);
});

test("dispatch-inputs writes the request workflow's inputs with a fresh request id", (t) => {
  const { root, home, worktree } = newSession(t, "dispatch");
  const out = path.join(root, "out", "inputs.json");
  const noSnapshot = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal(noSnapshot.status, 1);
  assert.match(noSnapshot.json.error, /no flag snapshot/);

  const snapshotFile = path.join(root, "snapshot.json");
  writeJson(snapshotFile, { takenAt: "2026-10-06T15:00:00Z", distinctId: "user_abc", flags: { "it's-quoted": true } });
  runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", snapshotFile], home);

  const blank = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal(blank.status, 0, blank.stderr);
  assert.equal(blank.json.workflow, "vibe-environment-dispatch.yml");
  assert.equal(blank.json.ref, "main");
  assert.match(blank.json.requestId, /^[A-Za-z0-9-]{8,64}$/);
  assert.equal(blank.json.runTitle, `Vibe environment vibe/dispatch (${blank.json.requestId})`);
  const blankInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(blankInputs).sort(), ["branch", "flag_snapshot", "mode", "request_id"]);
  assert.equal(blankInputs.branch, "vibe/dispatch");
  assert.equal(blankInputs.mode, "blank");
  assert.equal(blankInputs.request_id, blank.json.requestId);
  assert.deepEqual(JSON.parse(blankInputs.flag_snapshot).flags, { "it's-quoted": true });

  const again = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.notEqual(again.json.requestId, blank.json.requestId);

  // ISS-12135 bug 43: keep_flag_snapshot only when asked for, as a string,
  // and "true" only after the previous request published a verified result.
  const keepInput = (keep) => {
    const result = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out, "--keep-flag-snapshot", keep], home);
    assert.equal(result.status, 0, result.stderr);
    return { requestId: result.json.requestId, sent: JSON.parse(readFileSync(out, "utf8")).keep_flag_snapshot };
  };
  assert.equal(keepInput("false").sent, "false");
  const unverified = keepInput("true");
  assert.equal(unverified.sent, "false", "no request has published a result yet");
  const resultFile = path.join(root, "result.json");
  writeJson(resultFile, environmentResult(worktree, home, { requestId: unverified.requestId, branch: "vibe/dispatch" }));
  const recorded = runNode(
    SCRIPT,
    ["environment-result", "--worktree", worktree, "--file", resultFile, "--request-id", unverified.requestId],
    home
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  const afterVerified = keepInput("true");
  assert.equal(afterVerified.sent, "true");
  assert.equal(keepInput("true").sent, "false", "the previous request has not published a result");
  const badKeep = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out, "--keep-flag-snapshot", "yes"], home);
  assert.equal(badKeep.status, 1);
  assert.match(badKeep.json.error, /--keep-flag-snapshot must be true or false/);

  const blankWithEmail = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(blankWithEmail.status, 1);
  assert.match(blankWithEmail.json.error, /only with a Desktop auth claim/);

  runNode(SCRIPT, ["touch", "--worktree", worktree, "--mode", "seeded", ...OPERATOR_ARGS], home);
  const noEmail = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal(noEmail.status, 1);
  assert.match(noEmail.json.error, /--person-email/);

  const seeded = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(seeded.status, 0, seeded.stderr);
  const seededInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(seededInputs.mode, "seeded");
  assert.equal(seededInputs.person_email, "andy@example.com");
  assert.equal("clerk_org_id" in seededInputs, false);

  const badOrgChoice = runNode(SCRIPT, ["touch", "--worktree", worktree, "--clerk-org-id", "Acme"], home);
  assert.equal(badOrgChoice.status, 1);
  assert.match(badOrgChoice.json.error, /org_/);
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--clerk-org-id", "org_2abc"], home);
  const chosenOrg = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(chosenOrg.status, 0, chosenOrg.stderr);
  const chosenInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(chosenInputs.clerk_org_id, "org_2abc");
  assert.ok(Object.values(chosenInputs).every((value) => typeof value === "string"));
});

test("desktop-auth saves the profile's auth claim and every later request sends it", (t) => {
  const { root, home, worktree } = newSession(t, "desktop");
  const snapshotFile = path.join(root, "snapshot.json");
  writeJson(snapshotFile, { takenAt: "2026-10-06T15:00:00Z", distinctId: "user_abc", flags: {} });
  runNode(SCRIPT, ["flag-snapshot", "--worktree", worktree, "--file", snapshotFile], home);
  const out = path.join(root, "inputs.json");
  runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal("desktop_auth" in JSON.parse(readFileSync(out, "utf8")), false);

  const claimFile = path.join(root, "claim.json");
  for (const [claim, message] of [
    [{ refreshTokenHash: "h", publicKeySpki: "k" }, /gatewayId/],
    [{ refreshTokenHash: "h", publicKeySpki: "k", gatewayId: "g", refreshToken: "secret" }, /unknown field "refreshToken"/],
  ]) {
    writeJson(claimFile, claim);
    const refused = runNode(SCRIPT, ["desktop-auth", "--worktree", worktree, "--file", claimFile], home);
    assert.equal(refused.status, 1);
    assert.match(refused.json.error, message);
  }

  writeJson(claimFile, { gatewayId: "gw-1", publicKeySpki: "MIIB", refreshTokenHash: "abc123" });
  const saved = runNode(SCRIPT, ["desktop-auth", "--worktree", worktree, "--file", claimFile], home);
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(Date.parse(saved.json.session.desktopAuthSavedAt));

  const blankNoEmail = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal(blankNoEmail.status, 1);
  assert.match(blankNoEmail.json.error, /Desktop auth claim needs --person-email/);

  const blank = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(blank.status, 0, blank.stderr);
  const blankInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(blankInputs).sort(), [
    "branch",
    "desktop_auth",
    "flag_snapshot",
    "mode",
    "person_email",
    "request_id",
  ]);
  assert.equal(blankInputs.mode, "blank");
  assert.equal(blankInputs.person_email, "andy@example.com");
  assert.deepEqual(JSON.parse(blankInputs.desktop_auth), {
    refreshTokenHash: "abc123",
    publicKeySpki: "MIIB",
    gatewayId: "gw-1",
  });

  runNode(SCRIPT, ["touch", "--worktree", worktree, "--clerk-org-id", "org_2abc"], home);
  const blankOrg = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(blankOrg.status, 1);
  assert.match(blankOrg.json.error, /Clerk org is only sent for a seeded session/);

  runNode(SCRIPT, ["touch", "--worktree", worktree, "--mode", "seeded"], home);
  const seeded = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(seeded.status, 0, seeded.stderr);
  const seededInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(seededInputs.person_email, "andy@example.com");
  assert.equal(seededInputs.clerk_org_id, "org_2abc");
  assert.ok("desktop_auth" in seededInputs);
});

test("discard reports what would be lost, then requests the schema drop and deletes the pushed branch everywhere so the slug can be reused", (t) => {
  const { checkout, home, root, worktree } = newSession(t, "throw-away");
  const gh = ghStub(root, 0);
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--live-ticket", "ISS-30"], home);
  git(worktree, ["push", "--quiet", "-u", "origin", "vibe/throw-away"], home);
  writeFileSync(path.join(worktree, "draft.txt"), "unsaved\n");

  const preview = runNode(SCRIPT, ["discard", "--worktree", worktree], home, gh.env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(gh.calls(), []);
  assert.equal(preview.json.discarded, false);
  assert.equal(preview.json.wouldLose.pushed, true);
  assert.equal(preview.json.wouldLose.liveTicket, "ISS-30");
  assert.deepEqual(preview.json.wouldLose.operator, { id: "user-andy", email: "andy@example.com", name: "Andy Example" });
  assert.deepEqual(preview.json.wouldLose.uncommittedFiles, ["draft.txt"]);
  assert.notEqual(git(checkout, ["ls-remote", "--heads", "origin", "vibe/throw-away"], home), "");

  const done = runNode(SCRIPT, ["discard", "--worktree", worktree, "--confirm"], home, gh.env);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.discarded, true);
  assert.equal(done.json.remoteBranchDeleted, true);
  assert.equal(done.json.schemaCleanupRequested, true);
  assert.deepEqual(gh.calls(), [
    "workflow run cleanup-preview-schemas.yml --repo closedloop-ai/symphony-alpha --ref main -f branch=vibe/throw-away",
  ]);
  assert.equal(done.json.wouldLose.liveTicket, "ISS-30");
  assert.equal(git(checkout, ["ls-remote", "--heads", "origin", "vibe/throw-away"], home), "");
  assert.equal(git(checkout, ["branch", "--list", "vibe/throw-away"], home), "");
  assert.deepEqual(runNode(SCRIPT, ["list"], home).json.sessions, []);

  const again = runNode(
    SCRIPT,
    ["new", "--slug", "throw-away", "--summary", "again", "--mode", "blank", ...OPERATOR_ARGS],
    home
  );
  assert.equal(again.status, 0, again.stderr);
});

test("discard keeps the session when the schema drop cannot be requested", (t) => {
  const { checkout, home, root, worktree } = newSession(t, "kept");
  git(worktree, ["push", "--quiet", "-u", "origin", "vibe/kept"], home);
  const gh = ghStub(root, 1);

  const failed = runNode(SCRIPT, ["discard", "--worktree", worktree, "--confirm"], home, gh.env);
  assert.equal(failed.status, 1);
  assert.equal(gh.calls().length, 1);
  assert.notEqual(git(checkout, ["ls-remote", "--heads", "origin", "vibe/kept"], home), "");
  assert.notEqual(git(checkout, ["branch", "--list", "vibe/kept"], home), "");
  assert.ok(existsSync(worktree));
});

test("discard deletes an unpushed session's local branch and never discards a handed-off one", (t) => {
  const { checkout, home, root, worktree } = newSession(t, "local-only");
  const gh = ghStub(root, 0);
  const done = runNode(SCRIPT, ["discard", "--worktree", worktree, "--confirm"], home, gh.env);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.json.remoteBranchDeleted, false);
  assert.equal(done.json.schemaCleanupRequested, false);
  assert.deepEqual(gh.calls(), []);
  assert.equal(git(checkout, ["branch", "--list", "vibe/local-only"], home), "");

  const created = runNode(
    SCRIPT,
    ["new", "--slug", "handed", "--summary", "handed", "--mode", "blank", ...OPERATOR_ARGS],
    home
  );
  const handed = created.json.session.worktree;
  runNode(SCRIPT, ["touch", "--worktree", handed, "--status", "handed-off"], home);
  for (const args of [[], ["--confirm"]]) {
    const refused = runNode(SCRIPT, ["discard", "--worktree", handed, ...args], home);
    assert.equal(refused.status, 1);
    assert.match(refused.json.error, /handed off/);
  }
  assert.notEqual(git(checkout, ["branch", "--list", "vibe/handed"], home), "");
});

const BRIDGE_TOKEN_A = "A".repeat(43);
const BRIDGE_TOKEN_B = "b-_9".repeat(11);
const bridgeUrl = (port, token) =>
  `http://127.0.0.1:${port}/design-system/browser.html?closedloopBridgeToken=${token}`;

function exitedPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
}

test("desktop-launched records the running launch and its Desktop tab URL, and desktop-tab hands it out only while it runs", (t) => {
  const { root, home, worktree } = newSession(t, "desktop-tab");
  const before = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual([before.json.running, before.json.url], [false, null]);

  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookUrl: "http://localhost:6100", storybookPid: 42 })], home);
  const log = path.join(root, "vibe-desktop.log");
  writeFileSync(
    log,
    [
      "[vibe-profile] launching Desktop against https://api-stage-git-vibe-desktop-tab.preview.closedloop-stage.ai",
      `Desktop browser URL: ${bridgeUrl(50425, BRIDGE_TOKEN_A)}`,
      "[ELIFECYCLE] Command failed with exit code 143.",
      `Desktop browser URL: ${bridgeUrl(51229, BRIDGE_TOKEN_B)}`,
      "[startup][11:00:28.789] Desktop window visible reason=app-mounted",
      "",
    ].join("\n")
  );
  const launched = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(process.pid), "--log", log], home);
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(launched.json.session.stack, {
    storybookUrl: "http://localhost:6100",
    storybookPid: 42,
    desktopPid: process.pid,
    desktopLog: log,
    desktopBrowserUrl: bridgeUrl(51229, BRIDGE_TOKEN_B),
  });
  assert.equal(statSync(recordFile(worktree, home)).mode & 0o777, 0o600);

  const open = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.deepEqual([open.json.running, open.json.url], [true, bridgeUrl(51229, BRIDGE_TOKEN_B)]);

  const sections = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.equal(sections.status, 0, sections.stderr);
  assert.equal(sections.json.markdown.includes(BRIDGE_TOKEN_B), false);

  runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(exitedPid()), "--log", log], home);
  const quit = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.deepEqual([quit.json.running, quit.json.url], [false, null]);

  runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(process.pid), "--log", log], home);
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", "{}"], home);
  const stopped = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.deepEqual([stopped.json.running, stopped.json.url], [false, null]);
});

test("desktop-launched refuses a log that is not a started launch or has a bad tab URL, and a bad pid, and keeps the stack", (t) => {
  const { root, home, worktree } = newSession(t, "desktop-refused");
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--stack", JSON.stringify({ storybookPid: 7 })], home);
  const log = path.join(root, "vibe-desktop.log");
  for (const [text, message] of [
    ["[vibe-profile] launching Desktop against https://api.example\n", /neither a "Desktop browser URL:" line nor "Desktop window visible"/],
    [`Desktop browser URL: ${bridgeUrl(5173, BRIDGE_TOKEN_A).replace("127.0.0.1", "example.com")}\n`, /not a loopback/],
    [`Desktop browser URL: ${bridgeUrl(5173, "short")}\n`, /not a loopback/],
    [`Desktop browser URL: ${bridgeUrl(5173, BRIDGE_TOKEN_A).replace("browser.html", "index.html")}\n`, /not a loopback/],
    [`Desktop browser URL: ${bridgeUrl(5173, BRIDGE_TOKEN_A).replace("http:", "https:")}\n`, /not a loopback/],
    ["Desktop browser URL: not-a-url\n", /is not a URL/],
  ]) {
    writeFileSync(log, text);
    const refused = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", "123", "--log", log], home);
    assert.equal(refused.status, 1);
    assert.match(refused.json.error, message);
  }
  writeFileSync(log, `Desktop browser URL: ${bridgeUrl(5173, BRIDGE_TOKEN_A)}\n`);
  for (const pid of ["0", "12.5", "abc"]) {
    const refused = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", pid, "--log", log], home);
    assert.equal(refused.status, 1);
    assert.match(refused.json.error, /--pid must be/);
  }
  const missing = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", "123", "--log", path.join(root, "nope.log")], home);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /Could not read the Desktop launch log/);
  const shown = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.deepEqual(shown.json.session.stack, { storybookPid: 7 });
});

test("desktop-launched records a launch that predates the tab as a running window with no URL", (t) => {
  const { root, home, worktree } = newSession(t, "desktop-window");
  const log = path.join(root, "vibe-desktop.log");
  writeFileSync(log, `Desktop browser URL: ${bridgeUrl(50425, BRIDGE_TOKEN_A)}\n`);
  runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(process.pid), "--log", log], home);

  writeFileSync(log, "[vibe-profile] launching Desktop\n[startup][10:00:00.000] Desktop window visible reason=app-mounted\n");
  const launched = runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(process.pid), "--log", log], home);
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(launched.json.session.stack, { desktopPid: process.pid, desktopLog: log, desktopBrowserUrl: null });

  const tab = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.deepEqual([tab.json.running, tab.json.url], [true, null]);

  runNode(SCRIPT, ["desktop-launched", "--worktree", worktree, "--pid", String(exitedPid()), "--log", log], home);
  const quit = runNode(SCRIPT, ["desktop-tab", "--worktree", worktree], home);
  assert.deepEqual([quit.json.running, quit.json.url], [false, null]);
});

test("sessions carry no scope, and a record written with the retired draft scope drops it", (t) => {
  const { home, worktree } = newSession(t, "no-scope");
  const shown = runNode(SCRIPT, ["show", "--worktree", worktree], home);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal("scope" in shown.json.session, false);

  const file = recordFile(worktree, home);
  writeJson(file, { ...JSON.parse(readFileSync(file, "utf8")), scope: "draft" });
  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal("scope" in listed.json.sessions[0], false);
  assert.equal("scope" in runNode(SCRIPT, ["show", "--worktree", worktree], home).json.session, false);
});
