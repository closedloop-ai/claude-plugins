import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { classify as classifyIn } from "../../vibe/scripts/vibe-triage.mjs";
import { sessionAreas } from "../../vibe/scripts/area-paths.mjs";
import { ADVERSARIAL_REVIEWER, applyTriage, decideReview, FINDINGS_SCHEMA, loadTriageManifest, TriageStatus, loadFindings, partialFindings, REVIEW_SCOPE_DEFAULTS, resolveThresholds, ReviewMode, validateFindings } from "./review-scope.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the ClosedLoop provider (spawned scripts inherit it).
bindProviderInProcess(after);

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

test("a partial: skip is not checked, escalates, and keeps its findings for the full review", (t) => {
  const partialFile = path.join(DIR, "fixtures", "guardrails-findings.partial.json");
  const checked = loadFindings(partialFile);
  assert.equal(checked.status, "not-checked");
  assert.match(checked.reason, /checks skipped: tokens, copy-provenance/);
  assert.equal(checked.findings.length, 2, "no finding is dropped");
  assert.deepEqual(partialFindings(checked).map((finding) => finding.check), ["tokens"]);
  const decision = decideReview({ enabled: true, thresholds: REVIEW_SCOPE_DEFAULTS, diff: small, findings: checked });
  assert.equal(decision.mode, ReviewMode.FullFleet);
  const { dir, side, base, head } = repo(t);
  const findings = path.join(side, "findings.json");
  writeFileSync(findings, JSON.stringify({ ...JSON.parse(readFileSync(partialFile, "utf8")), head, base }));
  const inventory = path.join(side, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ backendChanged: false }));
  const out = run(["--worktree", dir, "--base", base, "--findings", findings, "--inventory", inventory, "--enable"]).json;
  assert.equal(out.mode, ReviewMode.FullFleet);
  assert.equal(out.findings.items.length, 2);
  assert.deepEqual(out.findings.partial.map((finding) => finding.check), ["tokens"]);
});

const UI_PATHS = ["apps/app/components/header.tsx", "apps/app/components/footer.tsx"];
const BACKEND = ["apps/api/app/documents/route.ts"];
const consolidatedDecision = { mode: ReviewMode.Consolidated, reasons: [] };
const fleetDecision = { mode: ReviewMode.FullFleet, reasons: ["backend-change"] };
// Triage reads the bound repository's areas, as the vibe skill's classify run does.
const classify = (input) => classifyIn({ areas: sessionAreas(), ...input });
const manifestFor = (paths, apply) => ({ status: TriageStatus.Valid, reason: null, manifest: classify({ paths, apply }) });

test("triage switch off: the manifest's review output is recorded as wouldApply and nothing changes", () => {
  const off = applyTriage({ decision: consolidatedDecision, triage: manifestFor(UI_PATHS, false) });
  assert.equal(off.applied, false);
  assert.deepEqual([off.addedReviews, off.extraGates], [[], []]);
  assert.deepEqual(off.wouldApply.addedReviews, [ADVERSARIAL_REVIEWER]);
  const backend = applyTriage({ decision: fleetDecision, triage: manifestFor(BACKEND, false) });
  assert.deepEqual([backend.extraGates, backend.wouldApply.extraGates], [[], ["workflow-code-review"]]);
});

test("triage switch on: the scope adds the adversarial reviewer to a consolidated read and the extra gates are applied", () => {
  const ui = applyTriage({ decision: consolidatedDecision, triage: manifestFor(UI_PATHS, true) });
  assert.equal(ui.applied, true);
  assert.deepEqual(ui.addedReviews, [ADVERSARIAL_REVIEWER]);
  const metric = applyTriage({ decision: consolidatedDecision, triage: manifestFor(["packages/app/cost/cost-card.tsx"], true) });
  assert.deepEqual(metric.extraGates, ["logical-qa"]);
  const backend = applyTriage({ decision: fleetDecision, triage: manifestFor(BACKEND, true) });
  assert.deepEqual([backend.addedReviews, backend.extraGates], [[], ["workflow-code-review"]]);
  const light = applyTriage({ decision: consolidatedDecision, triage: manifestFor(["apps/app/components/header.tsx"], true) });
  assert.deepEqual([light.addedReviews, light.extraGates], [[], []]);
});

test("a gate the handoff does not know is ignored, not run", () => {
  const triage = manifestFor(BACKEND, true);
  triage.manifest.steps.extraGates.gates.push("invented-gate");
  const result = applyTriage({ decision: fleetDecision, triage });
  assert.deepEqual(result.extraGates, ["workflow-code-review"]);
  assert.deepEqual(result.ignoredGates, ["invented-gate"]);
});

test("the manifest never removes a review the diff required: the decision is untouched and no scope narrows it", () => {
  for (const paths of [UI_PATHS, BACKEND, ["apps/app/components/header.tsx"], ["docs/guide.md"], ["apps/prototypes/a/page.tsx"], ["Dockerfile.unknown-area"]]) {
    for (const apply of [true, false]) {
      for (const decision of [consolidatedDecision, fleetDecision]) {
        const before = structuredClone(decision);
        const result = applyTriage({ decision, triage: manifestFor(paths, apply) });
        assert.deepEqual(decision, before, "the decision object is not modified");
        assert.ok(!("mode" in result) && !("reasons" in result), "the triage result carries no mode to replace the decision's");
      }
    }
  }
  const full = applyTriage({ decision: fleetDecision, triage: manifestFor(["apps/app/components/header.tsx"], true) });
  assert.deepEqual([full.addedReviews, full.extraGates], [[], []]);
});

test("a missing, unreadable or invalid manifest is today's behavior, never an error", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-scope-triage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broken = path.join(dir, "broken.json");
  writeFileSync(broken, "{nope");
  const invalid = path.join(dir, "invalid.json");
  const bad = classify({ paths: BACKEND, apply: true });
  bad.steps.review.effective = "as-today";
  writeFileSync(invalid, JSON.stringify(bad));
  const cases = [[undefined, TriageStatus.Absent], [path.join(dir, "none.json"), TriageStatus.Absent], [broken, TriageStatus.Invalid], [invalid, TriageStatus.Invalid]];
  for (const [file, status] of cases) {
    const result = applyTriage({ decision: fleetDecision, triage: loadTriageManifest(file) });
    assert.equal(result.status, status, String(file));
    assert.equal(result.applied, false);
    assert.deepEqual([result.addedReviews, result.extraGates], [[], []]);
  }
});

test("the CLI reads --manifest: decision unchanged, triage applied only from a switch-on manifest", (t) => {
  const { dir, side, base } = repo(t);
  const write = (name, manifest) => {
    const file = path.join(side, name);
    writeFileSync(file, JSON.stringify(manifest));
    return file;
  };
  const args = ["--worktree", dir, "--base", base];
  const plain = run(args);
  const off = run([...args, "--manifest", write("off.json", classify({ paths: BACKEND, apply: false }))]);
  const on = run([...args, "--manifest", write("on.json", classify({ paths: BACKEND, apply: true }))]);
  const missing = run([...args, "--manifest", path.join(side, "missing.json")]);
  for (const result of [off, on, missing]) {
    assert.equal(result.code, 0);
    assert.equal(result.json.mode, plain.json.mode);
    assert.deepEqual(result.json.reasons, plain.json.reasons);
  }
  assert.deepEqual([off.json.triage.applied, off.json.triage.extraGates, off.json.triage.wouldApply.extraGates], [false, [], ["workflow-code-review"]]);
  assert.deepEqual([on.json.triage.applied, on.json.triage.extraGates], [true, ["workflow-code-review"]]);
  assert.equal(missing.json.triage.status, TriageStatus.Absent);
  assert.equal(plain.json.triage.status, TriageStatus.Absent);
});
