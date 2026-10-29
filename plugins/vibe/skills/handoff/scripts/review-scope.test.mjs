import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decideReview, FINDINGS_SCHEMA, loadFindings, REVIEW_SCOPE_DEFAULTS, resolveThresholds, ReviewMode, validateFindings } from "./review-scope.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, "review-scope.mjs");
const FIXTURE = path.join(DIR, "fixtures", "guardrails-findings.sample.json");
const sample = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const small = { files: 3, changedLines: 40, sharedFiles: [], backendChanged: false };

test("the pinned fixture matches the guardrails findings contract", () => {
  const value = sample();
  assert.equal(value.schema, FINDINGS_SCHEMA);
  const checked = validateFindings(value, { head: value.head });
  assert.equal(checked.status, "valid");
  assert.equal(checked.findings.length, 2);
});

test("a skipped check, a stale head or a malformed field is not checked, never clean", () => {
  const skipped = { ...sample(), checks_skipped: [{ name: "reuse", reason: "no graph" }] };
  assert.match(validateFindings(skipped).reason, /checks skipped: reuse/);
  assert.equal(validateFindings(skipped).status, "not-checked");
  assert.equal(validateFindings(sample(), { head: "f".repeat(40) }).status, "not-checked");
  for (const change of [
    { schema: "vibe.guardrails-findings/2" }, { findings: "none" }, { checks_run: [1] },
    { findings: [{ ...sample().findings[0], severity: "critical" }] },
    { findings: [{ ...sample().findings[0], line: 1.5 }] },
    { findings: [{ ...sample().findings[0], evidence: undefined }] },
  ]) {
    assert.equal(validateFindings({ ...sample(), ...change }).status, "not-checked", JSON.stringify(change).slice(0, 60));
  }
  assert.equal(validateFindings(null).status, "not-checked");
});

test("a missing or unparseable file is not checked", (t) => {
  assert.equal(loadFindings(undefined).status, "not-checked");
  assert.equal(loadFindings("/nonexistent/findings.json").reason, "findings file missing");
  const dir = mkdtempSync(path.join(tmpdir(), "review-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "bad.json"), "{nope");
  assert.match(loadFindings(path.join(dir, "bad.json")).reason, /^unreadable/);
});

test("a small clean backend-free diff over valid findings is consolidated only when enabled", () => {
  const findings = validateFindings(sample());
  const on = decideReview({ enabled: true, thresholds: REVIEW_SCOPE_DEFAULTS, diff: small, findings });
  assert.deepEqual(on, { mode: ReviewMode.Consolidated, reasons: [] });
  const off = decideReview({ enabled: false, thresholds: REVIEW_SCOPE_DEFAULTS, diff: small, findings });
  assert.equal(off.mode, ReviewMode.FullFleet);
  assert.deepEqual(off.reasons, ["consolidated-review-disabled"]);
});

test("each escalation trigger sends the review to the full fleet with its reason", () => {
  const findings = validateFindings(sample());
  const run = (diff, thresholds = REVIEW_SCOPE_DEFAULTS, f = findings) => decideReview({ enabled: true, thresholds, diff, findings: f });
  assert.deepEqual(run({ ...small, backendChanged: true }).reasons, ["backend-change"]);
  assert.match(run({ ...small, backendChanged: null }).reasons[0], /backend-change-unknown/);
  assert.deepEqual(run({ ...small, sharedFiles: ["packages/app/x.tsx"] }).reasons, ["shared-component-change"]);
  assert.deepEqual(run({ ...small, files: 16 }).reasons, ["diff-files 16 > 15"]);
  assert.deepEqual(run({ ...small, changedLines: 401 }).reasons, ["diff-lines 401 > 400"]);
  assert.equal(run({ ...small, files: 15, changedLines: 400 }).mode, ReviewMode.Consolidated);
  const notChecked = validateFindings({ ...sample(), checks_skipped: [{ name: "a", reason: "b" }] });
  assert.match(run(small, REVIEW_SCOPE_DEFAULTS, notChecked).reasons[0], /^findings-not-checked/);
});

test("thresholds come from one place and are overridable by config and environment", () => {
  assert.equal(resolveThresholds({ env: {} }).maxFiles, REVIEW_SCOPE_DEFAULTS.maxFiles);
  assert.equal(resolveThresholds({ config: { maxFiles: 5 }, env: {} }).maxFiles, 5);
  assert.equal(resolveThresholds({ config: { maxFiles: 5 }, env: { VIBE_REVIEW_SCOPE_MAX_FILES: "9" } }).maxFiles, 9);
  assert.equal(resolveThresholds({ env: { VIBE_REVIEW_SCOPE_MAX_LINES: "-3" } }).maxChangedLines, REVIEW_SCOPE_DEFAULTS.maxChangedLines);
  assert.equal(resolveThresholds({ env: { VIBE_REVIEW_SCOPE_MAX_LINES: "abc" } }).maxChangedLines, REVIEW_SCOPE_DEFAULTS.maxChangedLines);
});

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "review-scope-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  mkdirSync(path.join(dir, "packages", "app"), { recursive: true });
  writeFileSync(path.join(dir, "packages", "app", "x.tsx"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  const side = mkdtempSync(path.join(tmpdir(), "review-scope-side-"));
  t.after(() => rmSync(side, { recursive: true, force: true }));
  return { dir, side, base, head: git("rev-parse", "HEAD") };
}

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, VIBE_CONSOLIDATED_REVIEW: "", ...env } });
  return { code: out.status, json: out.stdout ? JSON.parse(out.stdout) : null, err: out.stderr };
}

test("the CLI reports a shared-package change as full-fleet and a missing findings file as not checked", (t) => {
  const { dir, side, base } = repo(t);
  const inventory = path.join(side, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ backendChanged: false }));
  const result = run(["--worktree", dir, "--base", base, "--inventory", inventory, "--enable"]);
  assert.equal(result.code, 0);
  assert.equal(result.json.mode, ReviewMode.FullFleet);
  assert.equal(result.json.diff.files, 1);
  assert.deepEqual(result.json.diff.sharedFiles, ["packages/app/x.tsx"]);
  assert.ok(result.json.reasons.includes("shared-component-change"));
  assert.ok(result.json.reasons.some((reason) => reason.startsWith("findings-not-checked")));
});

test("the CLI consolidates a small non-shared diff over findings for HEAD, and an inventory-free run escalates", (t) => {
  const { dir, side, base, head } = repo(t);
  writeFileSync(path.join(dir, "packages", "app", "x.tsx"), "export const x = 1;\n");
  const config = path.join(side, "config.json");
  writeFileSync(config, JSON.stringify({ sharedPrefixes: ["packages/design-system/"] }));
  const findings = path.join(side, "findings.json");
  writeFileSync(findings, JSON.stringify({ ...sample(), head, base }));
  const inventory = path.join(side, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ backendChanged: false }));
  const args = ["--worktree", dir, "--base", base, "--findings", findings, "--config", config];
  const consolidated = run([...args, "--inventory", inventory], { VIBE_CONSOLIDATED_REVIEW: "1" });
  assert.equal(consolidated.json.mode, ReviewMode.Consolidated, JSON.stringify(consolidated.json.reasons));
  const noInventory = run(args, { VIBE_CONSOLIDATED_REVIEW: "1" });
  assert.equal(noInventory.json.mode, ReviewMode.FullFleet);
  assert.match(noInventory.json.reasons[0], /backend-change-unknown/);
  const disabled = run([...args, "--inventory", inventory]);
  assert.deepEqual(disabled.json.reasons, ["consolidated-review-disabled"]);
  assert.equal(run([]).code, 2);
});
