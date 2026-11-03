import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkThreads } from "./review-threads.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "review-threads.mjs");
const SHA = "a".repeat(40);
const WRITER = "writer-123";
const verified = { by: "vibe-guardrails-reviewer", verdict: "verified", evidence: "apps/api/route.ts:42 now rejects it" };

function fixed(threadId, extra = {}) {
  return { threadId, commentId: 7, result: "fixed", fixingCommit: SHA, verification: verified, ...extra };
}

/** A temp folder with a fake gh that logs each call's arguments. */
function workspace(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "review-threads-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = path.join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/calls.txt"\necho '{}'\n`);
  chmodSync(gh, 0o755);
  const run = (results, threads) => {
    writeFileSync(path.join(dir, "results.json"), JSON.stringify(results));
    writeFileSync(path.join(dir, "threads.json"), JSON.stringify(threads));
    const out = spawnSync(process.execPath, [SCRIPT, "resolve", "--results", path.join(dir, "results.json"),
      "--threads", path.join(dir, "threads.json"), "--gh", gh], { encoding: "utf8" });
    return { status: out.status, json: JSON.parse(out.stdout) };
  };
  const calls = () => (existsSync(path.join(dir, "calls.txt")) ? readFileSync(path.join(dir, "calls.txt"), "utf8") : "");
  return { run, calls };
}

test("only an independently verified fix is resolved; partial and reasoned answers stay open", (t) => {
  const { run, calls } = workspace(t);
  const threads = [
    fixed("T1"),
    { threadId: "T2", commentId: 8, result: "partial", remaining: "the Desktop path still skips the check" },
    { threadId: "T3", commentId: 9, result: "reason", reason: "the ticket keeps the old order" },
  ];
  const { status, json } = run({ writer: WRITER, threads }, threads.map(({ threadId }) => ({ threadId })));
  assert.equal(status, 0);
  assert.deepEqual(json, { ok: true, resolved: ["T1"], replyOnly: ["T2", "T3"], problems: [] });
  assert.match(calls(), /id=T1/);
  assert.doesNotMatch(calls(), /id=T2|id=T3/);
});

test("a failed verification resolves nothing, not even the verified threads", (t) => {
  const { run, calls } = workspace(t);
  const threads = [fixed("T1"), fixed("T2", { verification: { ...verified, by: "vibe-change-worker" } })];
  const { status, json } = run({ writer: WRITER, threads }, [{ threadId: "T1" }, { threadId: "T2" }]);
  assert.equal(status, 1);
  assert.deepEqual(json.resolved, []);
  assert.equal(calls(), "");
});

test("the writer's own word, an unverified verdict, a short SHA or a missing result never resolves", () => {
  for (const [thread, pattern] of [
    [fixed("T1", { verification: { ...verified, by: WRITER } }), /other than the writer/],
    [fixed("T1", { verification: { ...verified, verdict: "not-verified" } }), /has not verified/],
    [fixed("T1", { verification: { ...verified, evidence: " " } }), /has not verified/],
    [fixed("T1", { fixingCommit: "abc123" }), /full fixing commit/],
    [fixed("T1", { flagGated: true }), /flag-off-equals-main/],
    [{ threadId: "T1", commentId: 7, result: "partial" }, /what remains/],
  ]) {
    const result = checkThreads({ writer: WRITER, threads: [thread] }, [{ threadId: "T1" }]);
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), pattern);
  }
  assert.deepEqual(checkThreads({ writer: WRITER, threads: [fixed("T1")] }, [{ threadId: "T1" }, { threadId: "T2" }]).problems,
    ["T2: unresolved thread has no result"]);
  assert.equal(checkThreads({ writer: WRITER, threads: [fixed("T1", { flagGated: true,
    flagOffEqualsMain: "missing-test:R12 flag off matches main" })] }, []).ok, true);
});

test("a later-round thread is answered with the follow-up ticket's link, or why it is invalid, and resolved; never fixed here", () => {
  const later = (extra) => ({ threadId: "T9", commentId: 9, round: "later", ...extra });
  const unresolved = [{ threadId: "T9" }];
  const ruling = { writer: "w", singleReviewRuling: "operator, 2026-10-22, program rulings" };
  const followup = checkThreads({ ...ruling, threads: [later({ result: "followup", followupUrl: "https://app.example.test/issues/ISS-2" })] }, unresolved);
  assert.deepEqual([followup.ok, followup.resolve, followup.replyOnly], [true, ["T9"], []]);
  assert.deepEqual(checkThreads({ ...ruling, threads: [later({ result: "invalid", reason: "already covered by AC-3" })] }, unresolved).resolve, ["T9"]);
  assert.match(checkThreads({ ...ruling, threads: [later({ result: "followup" })] }, unresolved).problems.join(), /follow-up ticket's link/);
  assert.match(checkThreads({ ...ruling, threads: [later({ result: "fixed", fixingCommit: "a".repeat(40) })] }, unresolved).problems.join(), /never fixed in this pull request/);
  const retired = checkThreads({ writer: "w", threads: [later({ result: "followup", followupUrl: "https://app.example.test/issues/ISS-2" })] }, unresolved);
  assert.equal(retired.ok, false, "after core work the single round is retired, so a later round is fixed here");
  assert.match(retired.problems.join(), /single-review ruling is in force/);
});

test("a bot finding that does not reproduce is answered with evidence and resolved; a human's reasoned answer stays open (2026-10-24)", (t) => {
  const { run, calls } = workspace(t);
  const bot = { threadId: "B1", commentId: 9, result: "reason", source: "bot", reason: "does not reproduce",
    evidence: "the story renders the empty state at HEAD; the bot's own #9190 thread asked for the opposite" };
  const human = { threadId: "H1", commentId: 10, result: "reason", reason: "the ticket's AC-2 asks for it" };
  const result = run({ writer: WRITER, threads: [bot, human] }, [{ threadId: "B1" }, { threadId: "H1" }]);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.resolved, ["B1"]);
  assert.deepEqual(result.json.replyOnly, ["H1"]);
  assert.match(calls(), /B1/);
  assert.doesNotMatch(calls(), /H1/);
  const unexplained = checkThreads({ writer: WRITER, threads: [{ ...bot, evidence: "" }] }, [{ threadId: "B1" }]);
  assert.match(unexplained.problems.join(), /evidence/);
  assert.match(checkThreads({ writer: WRITER, threads: [{ ...bot, source: "reviewer" }] }, [{ threadId: "B1" }]).problems.join(), /source must be bot or human/);
});
