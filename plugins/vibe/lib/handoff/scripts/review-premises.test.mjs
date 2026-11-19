import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { premiseProblems } from "./review-premises.mjs";

test("blocking findings require verified evidence for every material premise", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "review-premises-"));
  writeFileSync(path.join(worktree, "contract.ts"), "export const supported = true;\n");
  const finding = { id: "F1", blocking: true, premises: [{ claim: "the feature is supported",
    evidence: { kind: "code", file: "contract.ts", line: 1, fact: "supported is true" } }] };
  assert.deepEqual(premiseProblems(finding, worktree), []);
  symlinkSync(path.join(worktree, "contract.ts"), path.join(worktree, "internal.ts"));
  assert.deepEqual(premiseProblems({ ...finding, premises: [{ claim: "internal", evidence: { kind: "code", file: "internal.ts", line: 1, fact: "same owner" } }] }, worktree), []);
  const external = path.join(tmpdir(), `external-premise-${process.pid}.ts`);
  writeFileSync(external, "outside\n");
  symlinkSync(external, path.join(worktree, "external.ts"));
  assert.match(premiseProblems({ ...finding, premises: [{ claim: "outside", evidence: { kind: "code", file: "external.ts", line: 1, fact: "outside" } }] }, worktree).join(), /escapes/);
  assert.match(premiseProblems({ ...finding, premises: [] }, worktree).join(), /list every material premise/);
  assert.match(premiseProblems({ ...finding, premises: [{ claim: "unsupported", evidence: { kind: "UNVERIFIED", reason: "not checked" } }] }, worktree).join(), /cannot support a blocking/);
  assert.deepEqual(premiseProblems({ ...finding, blocking: false, premises: [{ claim: "uncertain", evidence: { kind: "UNVERIFIED", reason: "not checked" } }] }, worktree), []);
  assert.match(premiseProblems({ ...finding, premises: [{ claim: "supported", evidence: { kind: "code", file: "contract.ts", line: 8, fact: "too short" } }] }, worktree).join(), /cannot be read/);
  assert.match(premiseProblems({ ...finding, premises: [{ claim: "supported", evidence: { kind: "code", file: "../other.ts", line: 1, fact: "escape" } }] }, worktree).join(), /escapes/);
  assert.deepEqual(premiseProblems({ ...finding, premises: [{ claim: "current docs", evidence: { kind: "official-doc", url: "https://example.com/docs", fact: "supports hooks", checkedAt: "2026-10-30T12:00:00Z" } }] }, worktree), []);
  assert.match(premiseProblems({ ...finding, premises: [{ claim: "current docs", evidence: { kind: "official-doc", url: "http://example.com/docs", fact: "supports hooks" } }] }, worktree).join(), /official URL/);
  assert.deepEqual(premiseProblems({ ...finding, premises: [{ claim: "command says yes", evidence: { kind: "command", command: "git --version", result: "git version" } }] }, worktree), []);
});
