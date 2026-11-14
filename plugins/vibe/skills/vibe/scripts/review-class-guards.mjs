#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_NAME = "review-class-guard-baseline.json";
const PATH_FIXTURE_NAME = "review-class-path-fixture.json";
const RUNTIME_EXTENSION = /\.(?:[cm]?js|mjs|ts)$/;
const EXECUTOR = "(?:spawnSync|execFileSync|execSync|execCommand|execCommandAsync|command|run)";
const INITIAL_SUBPROCESS_BASELINE = Object.freeze([
  "plugins/vibe-core/shared/process-identity.mjs:result-stdout",
  "plugins/vibe-core/lib/fleet-orchestrator/scripts/helpers.mjs:result-stdout",
  "plugins/vibe/skills/handoff/scripts/e2e-capability-probe.mjs:info-stdout",
]);
const INITIAL_DEFAULT_ON_BASELINE = Object.freeze([]);
// Shrink-only (ISS-14136): to add a bare-word classifier, list it here and give its reason in review-class-guard-baseline.json.
const INITIAL_BARE_WORD_BASELINE = Object.freeze([
  "plugins/vibe/skills/handoff/scripts/comment-rules.mjs:EXCUSE",
  "plugins/vibe/skills/handoff/scripts/criteria-audit.mjs:RUNTIME_REF",
  "plugins/vibe/skills/handoff/scripts/criteria-list.mjs:NAMES_CRITERIA",
  "plugins/vibe/skills/handoff/scripts/criterion-surface.mjs:ACROSS_PAGES",
  "plugins/vibe/skills/handoff/scripts/criterion-surface.mjs:ACROSS_SURFACES",
  "plugins/vibe/skills/handoff/scripts/criterion-surface.mjs:RUNTIME_CRITERION",
  "plugins/vibe/skills/handoff/scripts/diff-rules.mjs:BREADCRUMB_SIGNAL",
  "plugins/vibe/skills/handoff/scripts/diff-rules.mjs:CAPABILITY_COMPONENT",
  "plugins/vibe/skills/handoff/scripts/diff-rules.mjs:CONTROL_TERM",
  "plugins/vibe/skills/handoff/scripts/diff-rules.mjs:HARNESS_NAME",
  "plugins/vibe/skills/handoff/scripts/diff-rules.mjs:SYNC_TABLE",
  "plugins/vibe/skills/handoff/scripts/inventory-bundle.mjs:FLAG_NAME",
  "plugins/vibe/skills/handoff/scripts/live-ticket-check.mjs:UNFINISHED",
  "plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs:CI_CLAIM",
  "plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs:OTHER_TEST_FAMILY",
  "plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs:PENDING_HOST",
  "plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs:UNIVERSAL",
  "plugins/vibe/skills/handoff/scripts/pr-body-claims.mjs:UNRESOLVED_PRONOUN",
  "plugins/vibe/skills/handoff/scripts/rollout-gate.mjs:FLAG",
  "plugins/vibe/skills/handoff/scripts/rollout-gate.mjs:FLAG_READ",
  "plugins/vibe/skills/handoff/scripts/rollout-gate.mjs:ROLLOUT",
  "plugins/vibe/skills/handoff/scripts/rulings-check.mjs:EXCLUSION_PHRASE",
  "plugins/vibe/skills/handoff/scripts/targeted-tests-ruling.mjs:TARGETED",
  "plugins/vibe/skills/handoff/scripts/targeted-tests-ruling.mjs:WITHDRAWN",
  "plugins/vibe/skills/handoff/scripts/targeted-tests-ruling.mjs:WITHDRAWN_HEADING",
  "plugins/vibe/skills/handoff/scripts/test-integrity.mjs:BUSY_STATE",
  "plugins/vibe/skills/handoff/scripts/test-integrity.mjs:LAYOUT_SURFACE",
  "plugins/vibe/skills/handoff/scripts/test-integrity.mjs:RESPONSIVE_NAME",
  "plugins/vibe/skills/vibe/scripts/load-admission.mjs:OUT_OF_MEMORY",
  "plugins/vibe/skills/vibe/scripts/migration-publish.mjs:PER_ROW_WORK",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:CHECK_WORD",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:CLAIM",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:DESKTOP_WORD",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:E2E_TERM",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:PASS_WORD",
  "plugins/vibe/skills/vibe/scripts/pr-preflight.mjs:WEB_WORD",
  "plugins/vibe/skills/vibe/scripts/pre-pr-lanes.mjs:DESKTOP",
  "plugins/vibe/skills/vibe/scripts/pre-pr-lanes.mjs:NOTHING",
  "plugins/vibe/skills/vibe/scripts/session-questions.mjs:ASKS_LEAVE",
  "plugins/vibe/skills/vibe/scripts/session-questions.mjs:HUMAN_ONLY",
  "plugins/vibe/skills/vibe/scripts/session-questions.mjs:IN_SCOPE_WORK",
  "plugins/vibe/skills/vibe/scripts/session-questions.mjs:WAITS_FOR_PERSON",
  "plugins/vibe/skills/vibe/scripts/vibe-core-hooks.mjs:UNKNOWN_METHOD",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:BACKEND_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:BIG_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:DESKTOP_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:METRIC_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:PROTOTYPE_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:TRIVIAL_WORDS",
  "plugins/vibe/skills/vibe/scripts/vibe-triage.mjs:UI_WORDS",
]);
// The gate script directories the bare-word classifier guard protects (ISS-14136).
const GATE_SCRIPT_DIRECTORIES = Object.freeze(["plugins/vibe/skills/handoff/scripts/", "plugins/vibe/skills/vibe/scripts/"]);
const REGEX_CONSTANT = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*);/gm;
const WORD_GLUE = /\\b|\\w[*+]|\(\?:/g;
// Whitespace classes (`\s`, `\s+`, `\s*`) and an escaped punctuation mark each read as a space.
const WORD_SPACE = /\\s[+*?]?/g;
const ESCAPED_MARK = /\\([./:'"-])/g;
const ONLY_WORDS = /^[A-Za-z0-9 |()?[\]-]+$/;

/** Return tracked runtime source files of vibe and vibe-core (where its hook modules live) without tests, fixtures, or generated bundles. */
export function runtimeFiles(root) {
  const files = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["dist", "fixtures", "node_modules"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        RUNTIME_EXTENSION.test(entry.name) &&
        !/\.test\.[^.]+$/.test(entry.name) &&
        entry.name !== "test-fixtures.mjs" &&
        entry.name !== path.basename(import.meta.filename ?? fileURLToPath(import.meta.url))
      ) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  for (const plugin of ["plugins/vibe", "plugins/vibe-core"]) visit(path.join(root, plugin));
  return files.sort();
}

const lineNumber = (text, offset) => text.slice(0, offset).split("\n").length;

/**
 * Find child-process results whose stdout is parsed before an error or exit
 * status is inspected. IDs are stable so the baseline can only shrink.
 */
export function subprocessStatusFindings(root) {
  const findings = [];
  const direct = new RegExp(`\\b${EXECUTOR}\\s*\\([^;\\n]*?\\)\\.stdout\\b`, "g");
  const assignment = new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*(?:await\\s+)?${EXECUTOR}\\s*\\(`, "g");
  for (const relative of runtimeFiles(root)) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const match of text.matchAll(direct)) {
      findings.push(`${relative}:direct-stdout:${match[0].replace(/\s+/g, " ").trim()}`);
    }
    for (const match of text.matchAll(assignment)) {
      const variable = match[1];
      const tail = text.slice(match.index, match.index + 4000);
      const stdout = new RegExp(`\\b${variable}\\.stdout\\b`).exec(tail);
      if (!stdout) continue;
      const before = tail.slice(0, stdout.index);
      const checked = new RegExp(`\\b${variable}\\.(?:status|error|signal)\\b`).test(before);
      const parseContext = tail.slice(Math.max(0, stdout.index - 100), stdout.index + stdout[0].length + 100);
      const parsed = /(?:JSON\.parse|parse[A-Z]\w*|\.split\s*\(|\.trim\s*\()/.test(parseContext);
      if (!checked && parsed) {
        findings.push(`${relative}:${variable}-stdout`);
      }
    }
  }
  return [...new Set(findings)].sort();
}

function environmentReads(text) {
  const constants = new Map();
  for (const match of text.matchAll(/\b(?:export\s+)?const\s+(\w+)\s*=\s*["']((?:VIBE|FLEET)_[A-Z0-9_]+)["']/g)) {
    constants.set(match[1], match[2]);
  }
  const reads = [];
  for (const match of text.matchAll(/\b(?:process\.)?env(?:\.((?:VIBE|FLEET)_[A-Z0-9_]+)|\[\s*["']((?:VIBE|FLEET)_[A-Z0-9_]+)["']\s*\])/g)) {
    reads.push({ name: match[1] ?? match[2], index: match.index, expression: match[0] });
  }
  for (const [constant, name] of constants) {
    const pattern = new RegExp(`\\b(?:process\\.)?env\\[\\s*${constant}\\s*\\]`, "g");
    for (const match of text.matchAll(pattern)) reads.push({ name, index: match.index, expression: match[0] });
  }
  for (const object of text.matchAll(/\b(?:export\s+)?const\s+(\w+)\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/g)) {
    const objectName = object[1];
    for (const property of object[2].matchAll(/\b(\w+)\s*:\s*["']((?:VIBE|FLEET)_[A-Z0-9_]+)["']/g)) {
      const expression = `${objectName}.${property[1]}`;
      const pattern = new RegExp(`\\b(?:process\\.)?env\\[\\s*${objectName}\\.${property[1]}\\s*\\]`, "g");
      const uses = [...text.matchAll(pattern)];
      if (uses.length === 0) {
        reads.push({ name: property[2], index: object.index + property.index, expression });
      } else {
        for (const use of uses) reads.push({ name: property[2], index: use.index, expression: use[0] });
      }
    }
  }
  return reads;
}

function mechanicallyDefaultOff(text, read) {
  const context = text.slice(Math.max(0, read.index - 120), read.index + read.expression.length + 180);
  const escaped = read.expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const enabledByEquality = new RegExp(`${escaped}\\s*===?\\s*["'](?:1|true|on|yes)["']`, "i");
  const disabledByEarlyReturn = new RegExp(`${escaped}\\s*!==?\\s*["'](?:1|true|on|yes)["'][^;\\n]*return\\b`, "i");
  return enabledByEquality.test(context) || disabledByEarlyReturn.test(context);
}

/** Enumerate every VIBE_* and FLEET_* runtime environment read and its default class. */
export function environmentInventory(root, baseline) {
  const byName = new Map();
  for (const relative of runtimeFiles(root)) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const read of environmentReads(text)) {
      const item = byName.get(read.name) ?? { name: read.name, locations: [], mechanicallyDefaultOff: true };
      item.locations.push(`${relative}:${lineNumber(text, read.index)}`);
      item.mechanicallyDefaultOff &&= mechanicallyDefaultOff(text, read);
      byName.set(read.name, item);
    }
  }
  const configurations = new Set(baseline.configurationEnvironment ?? []);
  const reviewedDefaultOn = new Set(baseline.reviewedDefaultOnSwitches ?? []);
  const knownDefaultOn = new Set(baseline.defaultOnSwitches ?? []);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).map((item) => ({
    ...item,
    classification: configurations.has(item.name)
      ? "configuration"
      : item.mechanicallyDefaultOff
        ? "default-off"
        : reviewedDefaultOn.has(item.name)
          ? "reviewed-default-on"
          : knownDefaultOn.has(item.name)
            ? "known-default-on"
            : "unreviewed-default-on",
  }));
}

function extractStringArray(text, name) {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(text);
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]);
}

const startsWithAny = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

async function productionRedeployRelevant(root, file) {
  const environment = path.join(root, "plugins/vibe/skills/vibe/scripts/env-ctl.mjs");
  if (!existsSync(environment)) return null;
  const cacheBuster = `?guard=${Date.now()}-${Math.random()}`;
  const { createEnvCtl } = await import(`${pathToFileURL(environment).href}${cacheBuster}`);
  const deployed = "a".repeat(40);
  const context = JSON.stringify({ context: { runtime: "codex", worktree: "/wt", workerId: "guard", requestId: "guard", mode: "record", recordAction: "redeploy", lease: "guard" } });
  let requested = false;
  const ok = (stdout = "") => ({ status: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
  const run = (command, args) => {
    const line = [command, ...args].join(" ");
    if (line.includes("vibe-sessions.mjs show")) return ok({ session: { baseCommit: "b".repeat(40), lastRequestId: "guard", localFixes: [], vercel: { mode: "create", lastDeployedCommit: deployed } } });
    if (line.includes("local-plans.mjs")) return ok({ ok: true });
    if (line.includes("migration-publish.mjs")) return ok({ ok: true });
    if (line.includes("rev-parse --absolute-git-dir")) return ok("/wt/.git");
    if (line.includes("status --porcelain")) return ok("");
    if (line.includes("vibe-sessions.mjs main-sync-push")) return ok({ ok: true, mainSync: { pushed: true } });
    if (line.includes(`diff --name-only ${deployed} HEAD`)) return ok(`${file}\n`);
    if (line.includes("workflow view")) {
      requested = true;
      return { status: 1, stdout: "", stderr: "guard stops after observing the request" };
    }
    return { status: 1, stdout: "", stderr: `unexpected guard command: ${line}` };
  };
  await createEnvCtl({ run, env: { VIBE_REDEPLOY_UI_ONLY: "1" } }).redeploy({ worktree: "/wt", stdin: context });
  return requested;
}

/** Run available production path classifiers against the real-path fixture. */
export async function realPathClassifierFindings(root, fixture) {
  const findings = [];
  const handoffPath = path.join(root, "plugins/vibe/skills/handoff/scripts/handoff-inventory.mjs");
  if (existsSync(handoffPath)) {
    const text = readFileSync(handoffPath, "utf8");
    const prefixes = extractStringArray(text, "BACKEND_PREFIXES");
    const segments = extractStringArray(text, "BACKEND_SEGMENTS");
    if (prefixes.length > 0 || segments.length > 0) {
      for (const item of fixture.paths.filter((entry) => entry.backend)) {
        const actual = startsWithAny(item.path, prefixes) || segments.some((segment) => `/${item.path}`.includes(segment));
        if (!actual) findings.push(`backend:${item.id}:${item.path}`);
      }
    }
  }

  const factsPath = path.join(root, "plugins/vibe/skills/handoff/scripts/pr-facts.mjs");
  if (existsSync(factsPath)) {
    const prefixes = extractStringArray(readFileSync(factsPath, "utf8"), "UI");
    if (prefixes.length > 0) {
      for (const item of fixture.paths.filter((entry) => entry.ui)) {
        if (!startsWithAny(item.path, prefixes)) findings.push(`ui:${item.id}:${item.path}`);
      }
    }
  }

  const areaPath = path.join(root, "plugins/vibe/skills/vibe/scripts/area-paths.mjs");
  if (existsSync(areaPath)) {
    const cacheBuster = `?guard=${Date.now()}-${Math.random()}`;
    const area = await import(`${pathToFileURL(areaPath).href}${cacheBuster}`);
    for (const item of fixture.paths.filter((entry) => entry.backend)) {
      area.BACKEND_PATH.lastIndex = 0;
      if (!area.BACKEND_PATH.test(item.path)) findings.push(`area-backend:${item.id}:${item.path}`);
    }
    for (const item of fixture.paths.filter((entry) => entry.ui)) {
      if (!startsWithAny(item.path, area.UI_PREFIXES)) findings.push(`area-ui:${item.id}:${item.path}`);
    }

    if (existsSync(path.join(root, "plugins/vibe/skills/vibe/scripts/env-ctl.mjs"))) {
      for (const item of fixture.paths.filter((entry) => entry.deployRelevant)) {
        const relevant = await productionRedeployRelevant(root, item.path);
        if (!relevant) findings.push(`deploy-relevant:${item.id}:${item.path}`);
      }
    }
  }
  return findings.sort();
}

/**
 * Find module-level regular expression constants in the gate script directories that are nothing but
 * plain words matched in any letter case: alternations, word boundaries, optional letters and spaces,
 * with no anchor, separator or other structure. An exact-case pattern names identifiers of a fixed
 * grammar and is left alone. A gate that decides from such a constant classifies by a bare word: a criterion
 * that says "Desktop" was sent to visual QA although it had no screen (ISS-14136). IDs are `<file>:<NAME>`.
 */
export function bareWordClassifierFindings(root) {
  const findings = [];
  for (const relative of runtimeFiles(root).filter((file) => GATE_SCRIPT_DIRECTORIES.some((directory) => file.startsWith(directory)))) {
    const text = readFileSync(path.join(root, relative), "utf8");
    for (const match of text.matchAll(REGEX_CONSTANT)) {
      const words = match[2].replace(WORD_GLUE, "").replace(WORD_SPACE, " ").replace(ESCAPED_MARK, " ");
      if (match[3].includes("i") && ONLY_WORDS.test(words) && /[A-Za-z]{3}/.test(words)) findings.push(`${relative}:${match[1]}`);
    }
  }
  return [...new Set(findings)].sort();
}

/**
 * The bare-word classifiers against the baseline, the way the sibling baselines work: a new one fails as
 * new, a gone one as stale, and a JSON key outside the list frozen in code as baseline-grew. Each entry
 * keeps its reason in the JSON, and a blank reason fails.
 */
export function bareWordClassifierProblems(actual, baseline = {}, initial = INITIAL_BARE_WORD_BASELINE) {
  const problems = shrinkOnlyProblems("bare-word-classifier", actual, Object.keys(baseline), initial);
  for (const [item, reason] of Object.entries(baseline)) {
    if (typeof reason !== "string" || !reason.trim()) problems.push(`bare-word-classifier:no-reason:${item}`);
  }
  return problems;
}

export const ALWAYS_LOADED_RULES = Object.freeze([
  { id: "writer-acceptance-gate", file: "plugins/vibe/skills/fleet-orchestrator/SKILL.md", pattern: /A writer starts only once its plan holds a numbered acceptance-criteria list/ },
  { id: "running-app-check", file: "plugins/vibe/skills/handoff/SKILL.md", pattern: /^### Running app verification$/m },
  { id: "never-force-push", file: "plugins/vibe/skills/vibe/SKILL.md", pattern: /Never force-push; this covers every remote/ },
  { id: "push-ready-protocol", file: "plugins/vibe/skills/fleet-orchestrator/SKILL.md", pattern: /Push only a declared push-ready head/ },
  { id: "kill-guard", file: "plugins/vibe/skills/fleet-orchestrator/SKILL.md", pattern: /kill-guard\.mjs` refuses the rest/ },
  { id: "heavy-slot", file: "plugins/vibe/skills/fleet-orchestrator/SKILL.md", pattern: /Run heavy checks .* slot heavy/s },
  { id: "e2e-slot", file: "plugins/vibe/skills/fleet-orchestrator/SKILL.md", pattern: /shared e2e stack .* machine-wide e2e lock/s },
]);

/** Verify critical rules in raw skill files, never pytest's assembled content. */
export function alwaysLoadedRuleFindings(root) {
  const findings = [];
  for (const rule of ALWAYS_LOADED_RULES) {
    const absolute = path.join(root, rule.file);
    if (!existsSync(absolute) || !rule.pattern.test(readFileSync(absolute, "utf8"))) {
      findings.push(`${rule.id}:${rule.file}`);
    }
  }
  return findings;
}

function shrinkOnlyProblems(name, actual, baseline, initial) {
  const expected = new Set(baseline ?? []);
  const problems = [];
  for (const item of actual) if (!expected.has(item)) problems.push(`${name}:new:${item}`);
  for (const item of expected) if (!actual.includes(item)) problems.push(`${name}:stale:${item}`);
  const allowed = new Set(initial);
  for (const item of expected) if (!allowed.has(item)) problems.push(`${name}:baseline-grew:${item}`);
  return problems;
}

/** Run every review-class guard and return stable diagnostics. */
export async function reviewClassGuard(root, options = {}) {
  const baselinePath = options.baselinePath ?? path.join(root, "plugins/vibe/skills/vibe/scripts", BASELINE_NAME);
  const fixturePath = options.fixturePath ?? path.join(root, "plugins/vibe/skills/vibe/scripts", PATH_FIXTURE_NAME);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const subprocess = subprocessStatusFindings(root);
  const environment = environmentInventory(root, baseline);
  const classifiers = await realPathClassifierFindings(root, fixture);
  const rules = alwaysLoadedRuleFindings(root);
  const bareWords = bareWordClassifierFindings(root);
  const problems = [
    ...shrinkOnlyProblems("subprocess-status", subprocess, baseline.subprocessStatus, INITIAL_SUBPROCESS_BASELINE),
    ...shrinkOnlyProblems("default-on-switch", environment.filter((entry) => entry.classification === "known-default-on").map((entry) => entry.name), baseline.defaultOnSwitches, INITIAL_DEFAULT_ON_BASELINE),
    ...environment.filter((entry) => entry.classification === "unreviewed-default-on").map((entry) => `default-on-switch:unreviewed:${entry.name}:${entry.locations.join(",")}`),
    ...classifiers.map((entry) => `real-path:${entry}`),
    ...rules.map((entry) => `always-loaded:${entry}`),
    ...bareWordClassifierProblems(bareWords, baseline.bareWordClassifiers),
  ];
  return { ok: problems.length === 0, problems, inventory: { environment, subprocess, classifiers, rules, bareWords } };
}

async function main() {
  const at = process.argv.indexOf("--root");
  const root = path.resolve(at >= 0 ? process.argv[at + 1] : path.resolve(HERE, "../../../../../"));
  const result = await reviewClassGuard(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
