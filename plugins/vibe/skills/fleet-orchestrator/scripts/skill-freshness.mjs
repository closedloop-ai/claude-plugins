#!/usr/bin/env node
// Refuses a fleet prompt when the current conversation still carries an older
// loaded skill release, or when the prompt names a script absent from the
// installed plugin. This is the single preflight used by Codex fleet turns and
// Claude reviewer/verifier helper briefs.

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadedSkillEvidenceProblem } from "../../vibe/scripts/loaded-skill.mjs";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INSTALLED_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..");
const SCRIPT_REFERENCE = /(?:^|[\s'"`(/])((?:skills\/)?([a-z0-9][a-z0-9-]*)\/scripts\/[a-z0-9_./-]+\.(?:mjs|js|cjs|ts|py|sh))(?=$|[\s'"`),:.;\]])/gim;
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

/** Installed vibe manifest version at one exact plugin root. */
export function installedPluginVersion(pluginRoot = INSTALLED_PLUGIN_ROOT) {
  for (const relative of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const version = readJson(path.join(pluginRoot, relative))?.version;
    if (typeof version === "string") return version;
  }
  return null;
}

/** Why the loaded skill release cannot send another brief, or null. */
export function skillFreshnessProblem(record, { pluginRoot = INSTALLED_PLUGIN_ROOT, actorId } = {}) {
  if (!record) return "the program has no plugin version record; run the version check and reload the current skill before sending a brief";
  const actor = actorId ?? record.loadedSkill?.actorId;
  if (!actor) return "the target actor has no machine-observed loaded skill version";
  return loadedSkillEvidenceProblem(record.loadedSkill, { actorId: actor, pluginRoot });
}

/** Plugin script references found in prompt prose, normalized below skills/. */
export function pluginScriptReferences(text, pluginRoot = INSTALLED_PLUGIN_ROOT, worktree = null) {
  const refs = [];
  for (const match of String(text ?? "").matchAll(SCRIPT_REFERENCE)) {
    const raw = match[1];
    const skill = match[2];
    const explicit = raw.startsWith("skills/");
    if (!explicit && worktree && existsSync(path.resolve(worktree, raw))) continue;
    if (!explicit && !existsSync(path.join(pluginRoot, "skills", skill))) continue;
    const relative = explicit ? raw : `skills/${raw}`;
    if (!refs.includes(relative)) refs.push(relative);
  }
  return refs;
}

/** Missing, unsafe or non-file plugin script references in `text`. */
export function pluginScriptProblems(text, pluginRoot = INSTALLED_PLUGIN_ROOT, worktree = null) {
  const root = realpathSync(pluginRoot);
  const problems = [];
  for (const relative of pluginScriptReferences(text, root, worktree)) {
    if (relative.split("/").includes("..")) {
      problems.push(`${relative}: plugin script path escapes its installed root`);
      continue;
    }
    const candidate = path.resolve(root, relative);
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`) || !existsSync(candidate)) {
      problems.push(`${relative}: plugin script does not exist in installed vibe ${installedPluginVersion(root) ?? "unknown"}`);
      continue;
    }
    try {
      const canonical = realpathSync(candidate);
      if (!canonical.startsWith(`${root}${path.sep}`) || !lstatSync(canonical).isFile()) problems.push(`${relative}: plugin script is not a contained regular file`);
    } catch {
      problems.push(`${relative}: plugin script cannot be verified`);
    }
  }
  return problems;
}

/** Complete prompt preflight for one program state and installed plugin root. */
export function promptProblems(record, text, options = {}) {
  const freshness = skillFreshnessProblem(record, options);
  return [...(freshness ? [freshness] : []), ...pluginScriptProblems(text, options.pluginRoot, options.worktree)];
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
  const targetVersion = installedPluginVersion(values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT);
  const expectedOrder = values["expected-version"] ? compareVersions(targetVersion, values["expected-version"]) : 0;
  const problems = [
    ...(values["expected-version"] && (expectedOrder === null || expectedOrder < 0)
      ? [`target host has vibe ${targetVersion ?? "unknown"}, expected at least ${values["expected-version"]}`] : []),
    ...(bootstrap ? [] : [skillFreshnessProblem(record, { pluginRoot: values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT, actorId: values.actor })].filter(Boolean)),
    ...pluginScriptProblems(prompt, values["plugin-root"] ?? INSTALLED_PLUGIN_ROOT, values.worktree),
  ];
  if (problems.length) throw new Error(problems.join("; "));
  return { ok: true, loaded: record?.loadedSkill?.version ?? null, installed: targetVersion, prompt: path.resolve(promptFile) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`skill-freshness: ${error.message}\n`); process.exitCode = 2; }
}
