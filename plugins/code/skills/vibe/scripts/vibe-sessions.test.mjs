import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-sessions.mjs");
const SPACED_CHECKOUT = ["Documents", "Closedloop.ai - Active Work", "symphony-alpha"];

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
    ["new", "--slug", "board-chips", "--summary", "Board chips", "--scope", "draft", "--mode", "seeded"],
    home
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.session.worktree, path.join(checkout, ".claude", "worktrees", "andy-board-chips"));
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
    ["new", "--slug", "fix-me", "--summary", "Fix me", "--scope", "draft", "--mode", "seeded"],
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
    ["new", "--slug", "guarded", "--summary", "Guarded", "--scope", "draft", "--mode", "seeded"],
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
    ["new", "--slug", slug, "--summary", slug, "--scope", "draft", "--mode", "blank", ...extra],
    fixture.home
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("new requires a seeded or blank mode and records the branch's Vercel URLs", (t) => {
  const { home, checkout } = setup(t);
  rememberRepo(home, checkout);
  const missing = runNode(SCRIPT, ["new", "--slug", "no-mode", "--summary", "x", "--scope", "draft"], home);
  assert.equal(missing.status, 1);
  assert.match(missing.json.error, /--mode is required/);
  const wrong = runNode(
    SCRIPT,
    ["new", "--slug", "wrong-mode", "--summary", "x", "--scope", "draft", "--mode", "local"],
    home
  );
  assert.equal(wrong.status, 1);
  assert.match(wrong.json.error, /seeded, blank/);

  const created = runNode(
    SCRIPT,
    ["new", "--slug", "tag-edit", "--summary", "Tag edit", "--scope", "full", "--mode", "seeded"],
    home
  );
  assert.equal(created.status, 0, created.stderr);
  assert.equal(created.json.session.mode, "seeded");
  assert.deepEqual(created.json.session.vercel, {
    appUrl: "https://app-stage-git-andy-tag-edit.preview.closedloop-stage.ai",
    apiUrl: "https://api-stage-git-andy-tag-edit.preview.closedloop-stage.ai",
    storybookUrl: "https://prototypes-git-andy-tag-edit.preview.closedloop-stage.ai/storybook",
    lastDeployedCommit: null,
    lastDeployedAt: null,
  });
  const listed = runNode(SCRIPT, ["list"], home);
  assert.equal(listed.json.sessions[0].mode, "seeded");
  assert.equal(listed.json.sessions[0].liveTicket, null);
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
  assert.equal(listed.json.sessions[0].vercel.appUrl, "https://app-stage-git-andy-live-ticket.preview.closedloop-stage.ai");
  const touched = runNode(SCRIPT, ["touch", "--worktree", worktree, "--summary", "again"], home);
  assert.equal(touched.json.session.liveTicket, "ISS-12");
  assert.equal("handoffTicket" in JSON.parse(readFileSync(file, "utf8")), false);
});

test("touch takes reported Vercel URLs and the deployed commit, and rejects anything else", (t) => {
  const { home, worktree } = newSession(t, "deploys");
  const updated = runNode(
    SCRIPT,
    [
      "touch",
      "--worktree",
      worktree,
      "--vercel",
      JSON.stringify({ storybookUrl: "https://prototypes-abc.preview.closedloop-stage.ai/storybook/" }),
      "--deployed",
      "0123456789abcdef",
    ],
    home
  );
  assert.equal(updated.status, 0, updated.stderr);
  const vercel = updated.json.session.vercel;
  assert.equal(vercel.storybookUrl, "https://prototypes-abc.preview.closedloop-stage.ai/storybook");
  assert.equal(vercel.appUrl, "https://app-stage-git-andy-deploys.preview.closedloop-stage.ai");
  assert.equal(vercel.lastDeployedCommit, "0123456789abcdef");
  assert.ok(Date.parse(vercel.lastDeployedAt));

  const cases = [
    [["--vercel", JSON.stringify({ webUrl: "https://x.example" })], /accepts only/],
    [["--vercel", JSON.stringify({ appUrl: "http://localhost:3000" })], /https URL/],
    [["--deployed", "main"], /commit SHA/],
  ];
  for (const [args, message] of cases) {
    const result = runNode(SCRIPT, ["touch", "--worktree", worktree, ...args], home);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.json.error, message);
  }
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
  runNode(SCRIPT, ["touch", "--worktree", worktree, "--deployed", "abcdef1234567"], home);
  runNode(SCRIPT, ["codex-sessions", "--worktree", worktree, "--thread", "thread-12345678"], home, { CODEX_HOME: path.join(root, "none") });
  const filled = runNode(SCRIPT, ["ticket-sections", "--worktree", worktree], home);
  assert.doesNotMatch(filled.json.markdown, /Pending\./);
  assert.match(filled.json.markdown, /\| `a-flag` \| false \|\n\| `b-flag` \| `test` \|/);
  assert.match(filled.json.markdown, /as PostHog user `user_abc`\. 2 flags\./);
  assert.match(filled.json.markdown, /- Codex session \(orchestrator\): `thread-12345678`/);
  assert.match(filled.json.markdown, /- Last deployed: `abcdef1234`/);
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
  assert.equal(blank.json.runTitle, `Vibe environment andy/dispatch (${blank.json.requestId})`);
  const blankInputs = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(blankInputs).sort(), ["branch", "flag_snapshot", "mode", "request_id"]);
  assert.equal(blankInputs.branch, "andy/dispatch");
  assert.equal(blankInputs.mode, "blank");
  assert.equal(blankInputs.request_id, blank.json.requestId);
  assert.deepEqual(JSON.parse(blankInputs.flag_snapshot).flags, { "it's-quoted": true });

  const again = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.notEqual(again.json.requestId, blank.json.requestId);

  const blankWithEmail = runNode(
    SCRIPT,
    ["dispatch-inputs", "--worktree", worktree, "--out", out, "--person-email", "andy@example.com"],
    home
  );
  assert.equal(blankWithEmail.status, 1);
  assert.match(blankWithEmail.json.error, /only sent for a seeded session/);

  runNode(SCRIPT, ["touch", "--worktree", worktree, "--mode", "seeded"], home);
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

  const blank = runNode(SCRIPT, ["dispatch-inputs", "--worktree", worktree, "--out", out], home);
  assert.equal(blank.status, 0, blank.stderr);
  assert.ok(blank.json.inputNames.includes("desktop_auth"));
  assert.deepEqual(JSON.parse(JSON.parse(readFileSync(out, "utf8")).desktop_auth), {
    refreshTokenHash: "abc123",
    publicKeySpki: "MIIB",
    gatewayId: "gw-1",
  });
});
