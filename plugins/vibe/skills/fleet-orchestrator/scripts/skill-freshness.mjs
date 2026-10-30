#!/usr/bin/env node
// Refuses a fleet prompt when the current conversation still carries an older
// loaded skill release, or when the prompt names a script absent from the
// installed plugin. This is the single preflight used by Codex fleet turns and
// Claude reviewer/verifier helper briefs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadedSkillEvidenceProblem, loadedSkillRequired } from "../../vibe/scripts/loaded-skill.mjs";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { installedPluginVersion, pluginScriptProblems } from "../../vibe/scripts/plugin-script-references.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INSTALLED_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..");
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(left, right) {
  const a = VERSION.exec(left ?? ""); const b = VERSION.exec(right ?? "");
  if (!a || !b) return null;
  for (let index = 1; index < 4; index += 1) if (Number(a[index]) !== Number(b[index])) return Number(a[index]) < Number(b[index]) ? -1 : 1;
  return 0;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return null; }
}

/** Why the loaded skill release cannot send another brief, or null. */
export function skillFreshnessProblem(record, { pluginRoot = INSTALLED_PLUGIN_ROOT, actorId } = {}) {
  if (!record) return "the program has no plugin version record; run the version check and reload the current skill before sending a brief";
  const actor = actorId ?? record.loadedSkill?.actorId;
  // Without a load-evidence source (Codex hooks not trusted yet), the check keeps
  // its earlier behavior and never asks for evidence nothing can produce.
  if (!actor) return loadedSkillRequired(record) ? "the target actor has no hook-observed loaded skill version" : null;
  return loadedSkillEvidenceProblem(record.loadedSkill, { actorId: actor, pluginRoot });
}

/** Complete prompt preflight for one program state and installed plugin root. */
export function promptProblems(record, text, options = {}) {
  const freshness = skillFreshnessProblem(record, options);
  return [...(freshness ? [freshness] : []), ...pluginScriptProblems(text, options.pluginRoot ?? INSTALLED_PLUGIN_ROOT, options.worktree)];
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    runtime: { type: "string" }, actor: { type: "string" }, "plugin-root": { type: "string" }, worktree: { type: "string" }, "actor-state": { type: "string" }, bootstrap: { type: "boolean" }, "expected-version": { type: "string" },
  } });
  const [workDir, promptFile, ...extra] = positionals;
  if (!workDir || !promptFile || extra.length) throw new Error("Usage: skill-freshness.mjs <orchDir> <prompt-file> [--runtime codex|claude]");
  const program = values["actor-state"] ? null : resolveWorkDir(workDir).dir;
  const actorState = values["actor-state"] ? readJson(path.resolve(values["actor-state"])) : null;
  const record = values["actor-state"] ? (actorState?.loadedSkill ? { loadedSkill: actorState.loadedSkill } : null)
    : readJson(path.join(program, "plugin-version.json"));
  const prompt = readFileSync(path.resolve(promptFile), "utf8");
  const bootstrap = values.bootstrap && !actorState && /^\s*\$vibe\b/.test(prompt);
  // A thread saved before vibe 1.1.23 has no load evidence and nothing can add it: version-skewed
  // state keeps working, unchecked, rather than stranding every running writer on an update.
  const legacyThread = Boolean(actorState) && !actorState.loadedSkill;
  if (legacyThread) process.stderr.write(`skill-freshness: ${path.resolve(values["actor-state"])} predates loaded-skill evidence (vibe before 1.1.23); its loaded skill is not checked\n`);
  const targetVersion = installedPluginVersion(values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT);
  const expectedOrder = values["expected-version"] ? compareVersions(targetVersion, values["expected-version"]) : 0;
  const problems = [
    ...(values["expected-version"] && (expectedOrder === null || expectedOrder < 0)
      ? [`target host has vibe ${targetVersion ?? "unknown"}, expected at least ${values["expected-version"]}`] : []),
    ...(bootstrap || legacyThread ? [] : [skillFreshnessProblem(record, { pluginRoot: values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT, actorId: values.actor })].filter(Boolean)),
    ...pluginScriptProblems(prompt, values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT, values.worktree),
  ];
  if (problems.length) throw new Error(problems.join("; "));
  return { ok: true, loaded: record?.loadedSkill?.version ?? null, installed: targetVersion, loadedSkillChecked: !bootstrap && !legacyThread, prompt: path.resolve(promptFile) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`skill-freshness: ${error.message}\n`); process.exitCode = 2; }
}
