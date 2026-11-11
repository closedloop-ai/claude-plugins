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

async function productionRedeployRelevant(root, file, providerRoot) {
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
  // The corpus is the repository the fixture's provider serves: its environment recipe.
  const provider = JSON.parse(readFileSync(path.join(root, providerRoot, "provider.json"), "utf8"));
  await createEnvCtl({ run, env: { VIBE_REDEPLOY_UI_ONLY: "1" }, repo: "guard/repository",
    environmentFor: () => provider.data.recipes.environment, planPrefixFor: () => null }).redeploy({ worktree: "/wt", stdin: context });
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
    // The corpus is the repository the fixture's provider serves, so its areas are that provider's recipe.
    const providerRoot = path.join(root, fixture.providerRoot);
    const { name } = JSON.parse(readFileSync(path.join(providerRoot, "provider.json"), "utf8"));
    const areas = area.repositoryAreas({ state: "bound", name, root: providerRoot, capabilities: ["recipes"] });
    for (const item of fixture.paths.filter((entry) => entry.backend)) {
      if (!areas.backend.test(item.path)) findings.push(`area-backend:${item.id}:${item.path}`);
    }
    for (const item of fixture.paths.filter((entry) => entry.ui)) {
      if (!startsWithAny(item.path, areas.ui)) findings.push(`area-ui:${item.id}:${item.path}`);
    }

    if (existsSync(path.join(root, "plugins/vibe/skills/vibe/scripts/env-ctl.mjs"))) {
      for (const item of fixture.paths.filter((entry) => entry.deployRelevant)) {
        const relevant = await productionRedeployRelevant(root, item.path, fixture.providerRoot);
        if (!relevant) findings.push(`deploy-relevant:${item.id}:${item.path}`);
      }
    }
  }
  return findings.sort();
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
  const fixturePath = options.fixturePath ?? path.join(root, "plugins/vibe/skills/vibe/scripts/fixtures", PATH_FIXTURE_NAME);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const subprocess = subprocessStatusFindings(root);
  const environment = environmentInventory(root, baseline);
  const classifiers = await realPathClassifierFindings(root, fixture);
  const rules = alwaysLoadedRuleFindings(root);
  const problems = [
    ...shrinkOnlyProblems("subprocess-status", subprocess, baseline.subprocessStatus, INITIAL_SUBPROCESS_BASELINE),
    ...shrinkOnlyProblems("default-on-switch", environment.filter((entry) => entry.classification === "known-default-on").map((entry) => entry.name), baseline.defaultOnSwitches, INITIAL_DEFAULT_ON_BASELINE),
    ...environment.filter((entry) => entry.classification === "unreviewed-default-on").map((entry) => `default-on-switch:unreviewed:${entry.name}:${entry.locations.join(",")}`),
    ...classifiers.map((entry) => `real-path:${entry}`),
    ...rules.map((entry) => `always-loaded:${entry}`),
  ];
  return { ok: problems.length === 0, problems, inventory: { environment, subprocess, classifiers, rules } };
}

async function main() {
  const at = process.argv.indexOf("--root");
  const root = path.resolve(at >= 0 ? process.argv[at + 1] : path.resolve(HERE, "../../../../../"));
  const result = await reviewClassGuard(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
