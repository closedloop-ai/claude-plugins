import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("only an independently verified fix is resolved; partial and reasoned answers stay open", () => {
  const result = checkThreads({ writer: WRITER, threads: [
    fixed("T1"),
    { threadId: "T2", commentId: 8, result: "partial", remaining: "the Desktop path still skips the check" },
    { threadId: "T3", commentId: 9, result: "reason", reason: "the ticket keeps the old order" },
  ] });
  assert.deepEqual(result, { ok: true, resolve: ["T1"], replyOnly: ["T2", "T3"], problems: [] });
});

test("the writer's own word, an unverified verdict or a missing SHA never resolves a thread", () => {
  for (const [thread, pattern] of [
    [fixed("T1", { verification: { ...verified, by: "vibe-change-worker" } }), /other than the writer/],
    [fixed("T1", { verification: { ...verified, by: WRITER } }), /other than the writer/],
    [fixed("T1", { verification: { ...verified, verdict: "not-verified" } }), /did not verify/],
    [fixed("T1", { verification: { ...verified, evidence: " " } }), /cites its evidence/],
    [fixed("T1", { fixingCommit: "abc123" }), /full fixing commit/],
    [{ threadId: "T1", commentId: 7, result: "partial" }, /what remains/],
    [{ threadId: "T1", commentId: 7, result: "done" }, /fixed, partial or reason/],
  ]) {
    const result = checkThreads({ writer: WRITER, threads: [thread] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.resolve, []);
    assert.match(result.problems.join("\n"), pattern);
  }
});

test("a flag-gated fix names the flag-off-equals-main test or its missing-tests entry", () => {
  assert.equal(checkThreads({ writer: WRITER, threads: [fixed("T1", { flagGated: true })] }).ok, false);
  for (const evidence of ["test:apps/api/__tests__/flag-off.test.ts", "missing-test:R12 flag off matches main"]) {
    assert.deepEqual(checkThreads({ writer: WRITER, threads: [fixed("T1", { flagGated: true, flagOffEqualsMain: evidence })] }).resolve, ["T1"]);
  }
});

test("every unresolved thread on the pull request needs a result", () => {
  const result = checkThreads({ writer: WRITER, threads: [fixed("T1")] }, [{ threadId: "T1" }, { threadId: "T2" }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["T2: unresolved thread has no result"]);
});

test("the CLI exits 1 on a problem and 0 when every thread is settled", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-threads-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const results = path.join(dir, "results.json");
  const threads = path.join(dir, "threads.json");
  writeFileSync(threads, JSON.stringify([{ threadId: "T1" }]));
  writeFileSync(results, JSON.stringify({ writer: WRITER, threads: [fixed("T1")] }));
  const ok = spawnSync(process.execPath, [SCRIPT, "check", "--results", results, "--threads", threads], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout).resolve, ["T1"]);
  writeFileSync(results, JSON.stringify({ writer: WRITER, threads: [fixed("T1", { verification: { by: WRITER, verdict: "verified", evidence: "x" } })] }));
  const refused = spawnSync(process.execPath, [SCRIPT, "check", "--results", results], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stdout).ok, false);
});
