import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

bindProviderInProcess(after);

const { LoadBasis, loadedSkillEvidence } = await vibeCore("lib/vibe/scripts/loaded-skill.mjs");
const BOARD = fileURLToPath(new URL("./board.mjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPO = "fixture/board";
const QUOTE = "Ship this by itself.";
const SOURCE = "2026-11-20 (operator message: ISS-1 exact scope)";
const LESSONS_PR = {
  number: 31, title: "Fleet lessons", headRefName: "fleet-lessons",
  url: "https://github.com/fixture/board/pull/31",
};

function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), "fleet-scope-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "programs", "test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, "current"), "test\n");
  writeFileSync(path.join(dir, "handover.md"), "## Next\n- Next vibe PR: ISS-7, the prevention batch.\n");
  writeFileSync(path.join(dir, "plugin-version.json"), JSON.stringify({
    status: "current", runtime: "codex", checkedAt: "now", harnesses: [],
    loadedSkill: loadedSkillEvidence("scope-test", "codex", PLUGIN_ROOT, "fleet-orchestrator", LoadBasis.HookObserved),
  }));
  const gitCalls = path.join(home, "git-calls");
  writeFileSync(path.join(home, "git"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$0-calls\"\ncase \"$3\" in rev-parse) printf '%040d\\n' 1;; status) ;; *) exit 78;; esac\n", { mode: 0o755 });
  writeFileSync(gitCalls, "");
  const gh = path.join(home, "gh");
  const response = path.join(home, "response.json");
  writeFileSync(gh, "#!/bin/sh\n[ \"$*\" = 'pr list -R fixture/board --state open --author @me --json number,title,headRefName,url' ] || exit 64\ncat \"$0-response\"\n", { mode: 0o755 });
  const ghResponse = (body) => {
    writeFileSync(gh + "-response", JSON.stringify(body));
    return { LESSONS_GH: gh };
  };
  const run = (args, env = ghResponse([LESSONS_PR])) => spawnSync(process.execPath, [BOARD, dir, ...args], {
    encoding: "utf8", env: { ...process.env, PATH: home + path.delimiter + process.env.PATH, ...env },
  });
  const okay = (args) => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(response, JSON.stringify({ codeOnly: false, needsRunningApp: true, localEvidence: ["fixture"] }));
  for (const [name, ticket, pr] of [["locked", "ISS-1", "7"], ["free", "ISS-2", "8"]]) {
    okay(["placement", ticket, "--evidence", response]);
    okay(["writer", name, "--tickets", ticket, "--repo", REPO, "--pr", pr, "--worktree", home]);
  }
  writeFileSync(path.join(dir, "rulings.md"), [
    '- Ruling 2026-11-20 (operator message: ISS-1 exact scope): "Ship this by itself."',
    '- Ruling 2026-11-20 (operator message: ISS-1 later): "Also add the other change."',
    '- Ruling 2026-11-20 (operator message: ISS-2 scope): "Ship this by itself."',
    '- Ruling 2026-11-20 (orchestrator: ISS-1 scope): "Orchestrator requires a lock."',
  ].join("\n") + "\n");
  const bytes = () => ["board.json", "board.md"].map((name) => readFileSync(path.join(dir, name), "utf8"));
  const lock = (quote = QUOTE, source = SOURCE) => ["writer", "locked", "--scope-locked", quote, "--ruling-source", source];
  const scope = (name, to = "locked") => ["deliver", name, "--kind", "scope", "--to", to, "--text", "Follow-up requirement"];
  return { bytes, dir, ghResponse, gitCalls, home, lock, okay, run, scope };
}

test("unlocked board writer accepts a scope delivery and records its worktree baseline", (t) => {
  const f = fixture(t);
  f.okay(f.scope("ordinary"));
  const { deliveries } = JSON.parse(f.bytes()[0]);
  assert.deepEqual(deliveries.ordinary.to, ["locked"]);
  assert.equal(deliveries.ordinary.base.locked, "0".repeat(39) + "1");
});

test("AC-85 writer locks require the exact operator words and the named writer's source, are idempotent, and persist on update", (t) => {
  const f = fixture(t);
  const before = f.bytes();
  for (const [quote, source] of [
    ["Ship this by itself", SOURCE],
    ["Orchestrator requires a lock.", "2026-11-20 (orchestrator: ISS-1 scope)"],
    [QUOTE, "2026-11-20 (operator message: ISS-2 scope)"],
  ]) {
    const result = f.run(f.lock(quote, source));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires exact quoted operator words and --ruling-source/);
    assert.deepEqual(f.bytes(), before);
  }
  f.okay([...f.lock(), "--now", "2026-11-20T12:00:00.000Z"]);
  const locked = f.bytes();
  const scopeLock = JSON.parse(locked[0]).writers.locked.scopeLock;
  assert.deepEqual(scopeLock, { quote: QUOTE, source: SOURCE, ticket: "ISS-1", repo: REPO, pr: "7", at: "2026-11-20T12:00:00.000Z" });
  f.okay([...f.lock(), "--now", "2026-11-20T13:00:00.000Z"]);
  assert.deepEqual(f.bytes(), locked);
  const conflict = f.run(f.lock("Also add the other change.", "2026-11-20 (operator message: ISS-1 later)"));
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /already has a different scope lock/);
  assert.deepEqual(f.bytes(), locked);
  f.okay(["writer", "locked", "--status", "testing", "--head", "a".repeat(40)]);
  assert.deepEqual(JSON.parse(f.bytes()[0]).writers.locked.scopeLock, scopeLock);
});

test("AC-85 scope lock refuses the full resulting recipient set before content and worktree reads", (t) => {
  const f = fixture(t);
  f.okay(["deliver", "reused", "--kind", "note", "--to", "locked", "--text", "Original note"]);
  f.okay(f.lock());
  const before = f.bytes();
  const gitBefore = readFileSync(f.gitCalls, "utf8");
  writeFileSync(path.join(f.dir, "plugin-version.json"), "malformed JSON");
  const unreadableReference = path.join(f.dir, "reference.md");
  mkdirSync(unreadableReference);
  for (const args of [f.scope("direct"), f.scope("mixed", "free,locked"), f.scope("reused", "free")]) {
    const result = f.run([...args, "--reference", unreadableReference]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /scope delivery refused for locked/);
    assert.match(result.stderr, /https:\/\/github\.com\/fixture\/board\/pull\/31/);
    assert.deepEqual(f.bytes(), before);
    assert.equal(readFileSync(f.gitCalls, "utf8"), gitBefore);
  }
});

test("scope stays refused and names the handover prevention ticket when the lessons PR is missing, ambiguous or unavailable", (t) => {
  const f = fixture(t);
  f.okay(f.lock());
  const before = f.bytes();
  const other = { ...LESSONS_PR, number: 32, url: "https://github.com/fixture/board/pull/32" };
  for (const [env, diagnostic] of [
    [f.ghResponse([]), /no open lessons PR/],
    [null, /multiple open lessons PRs/],
    [{ LESSONS_GH: path.join(f.home, "missing-gh") }, /lessons PR lookup unavailable/],
  ]) {
    // Each fake response is written just before the matching CLI run.
    const result = f.run(f.scope("blocked"), env ?? f.ghResponse([LESSONS_PR, other]));
    assert.equal(result.status, 2);
    assert.match(result.stderr, diagnostic);
    assert.match(result.stderr, /prevention ticket ISS-7 named by handover\.md/);
    assert.deepEqual(f.bytes(), before);
  }
  const wrongRepository = { ...LESSONS_PR, url: "https://github.com/other/repository/pull/31" };
  const wrong = f.run(f.scope("wrong-repository"), f.ghResponse([wrongRepository]));
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /invalid destination.*prevention ticket ISS-7 named by handover\.md/);
  assert.deepEqual(f.bytes(), before);

  writeFileSync(path.join(f.dir, "handover.md"), [
    "- Next vibe PR: ISS-7, the prevention batch.",
    "- remaining items move to ISS-8",
  ].join("\n"));
  const ambiguous = f.run(f.scope("ambiguous-handover"), f.ghResponse([]));
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /canonical lessons ticket fallback is not configured/);
  assert.deepEqual(f.bytes(), before);
});

test("notes, checkpoints and sourced rulings can reach a locked writer", (t) => {
  const f = fixture(t);
  f.okay(f.lock());
  for (const kind of ["note", "checkpoint", "ruling"]) {
    f.okay(["deliver", kind, "--kind", kind, "--to", "locked", "--text", "Keep going", "--reference", "rulings.md"]);
  }
  const { deliveries } = JSON.parse(f.bytes()[0]);
  assert.deepEqual(Object.values(deliveries).map(({ kind, to }) => [kind, to]), [
    ["note", ["locked"]], ["checkpoint", ["locked"]], ["ruling", ["locked"]],
  ]);
});
