#!/usr/bin/env node
// The vibe plugin's only PreToolUse hook. Each tool call is routed by tool_name
// to its guards, which run in this one process; their results merge as
// hook-dispatch.mjs describes. A new PreToolUse guard is a module added to a
// route here, never another hooks.json command.
//
// Usage (hook): reads the PreToolUse JSON on stdin; prints one decision or context object, or nothing.

import { agentGuard } from "./agent-guard.mjs";
import { foregroundGuard } from "./foreground-guard.mjs";
import { deny, isMain, mergeResults, runGuards, runHookScript } from "./hook-dispatch.mjs";
import { killGuard } from "./kill-guard.mjs";
import { mergeGuard } from "./merge-guard.mjs";
import { pauseGuard } from "./pause-guard.mjs";
import { pluginVersionGuard, pluginVersionSkillStart } from "./plugin-version-guard.mjs";
import { prCreateGuard } from "./pr-create-guard.mjs";
import { QUESTION_TOOLS, questionGuard } from "./question-guard.mjs";
import { shellSafetyGuard } from "./shell-safety-guard.mjs";
import { conversationSkill } from "./hook-session-scope.mjs";
import { commandSegments } from "./command-segments.mjs";
import path from "node:path";

/** The guards each tool runs, in order; hooks.json's PreToolUse matcher names exactly these tools. */
export const PRE_TOOL_USE_ROUTES = Object.freeze({
  Bash: Object.freeze([
    { name: "kill-guard", run: killGuard },
    { name: "foreground-guard", run: foregroundGuard },
    { name: "merge-guard", run: mergeGuard },
    { name: "pr-create-guard", run: prCreateGuard },
    { name: "shell-safety-guard", run: shellSafetyGuard },
    { name: "scratch-creation-guard", run: scratchCreationGuard },
    { name: "plugin-version-guard", run: pluginVersionGuard },
  ]),
  Agent: Object.freeze([
    { name: "agent-guard", run: agentGuard },
    { name: "plugin-version-guard", run: pluginVersionGuard },
  ]),
  SendMessage: Object.freeze([{ name: "pause-guard", run: pauseGuard }, { name: "plugin-version-guard", run: pluginVersionGuard }]),
  Skill: Object.freeze([{ name: "plugin-version-start", run: pluginVersionSkillStart }]),
  ...Object.fromEntries(QUESTION_TOOLS.map((tool) => [tool, Object.freeze([{ name: "question-guard", run: questionGuard }])])),
});

/** The PreToolUse output for `event`, or null; `report(line)` receives each failing guard's error. */
export function preToolUse(event, report) {
  const tool = event?.tool_name;
  const guards = typeof tool === "string" && Object.hasOwn(PRE_TOOL_USE_ROUTES, tool) ? PRE_TOOL_USE_ROUTES[tool] : [];
  return mergeResults("PreToolUse", runGuards(guards, event, report));
}

/** Recognize a raw per-ticket PostgreSQL/perf/seed launch, never a Docker read. */
export function scratchCreationProblem(command, scope) {
  if (!['vibe', 'fleet-orchestrator'].includes(scope) || typeof command !== 'string') return null;
  const scratch = /\b(?:iss[-_]?\d+|scratch|postgres|postgresql|perf|seed|minio|ca-store)\b/i;
  for (const { words } of commandSegments(command, { expandShellPayloads: true })) {
    if (allowedSharedOrEphemeralRun(words)) continue;
    if (scratchDockerCreation(words).some((identity) => scratch.test(identity))) {
      return 'registered scratch stack required: use helpers.mjs scratch-run with owner, ticket, worktree and TTL before Docker creation';
    }
  }
  return null;
}

const RUN_VALUE_OPTIONS = new Set(['--name', '--env', '-e', '--volume', '-v', '--mount', '--network', '--label', '-l',
  '--publish', '-p', '--workdir', '-w', '--user', '-u', '--entrypoint', '--hostname', '-h', '--platform', '--env-file']);
const COMPOSE_VALUE_OPTIONS = new Set(['--project-name', '-p', '--file', '-f', '--profile', '--env-file', '--project-directory']);

function optionValue(words, index, options) {
  const word = words[index];
  if (!word?.startsWith('-')) return 0;
  if (word.includes('=')) return 1;
  return options.has(word) ? 2 : 1;
}

function runIdentities(words, actionAt) {
  const identities = [];
  for (let index = actionAt + 1; index < words.length;) {
    const word = words[index];
    if (word === '--name' && words[index + 1]) identities.push(words[index + 1]);
    else if (word?.startsWith('--name=')) identities.push(word.slice('--name='.length));
    const consumed = optionValue(words, index, RUN_VALUE_OPTIONS);
    if (consumed) { index += consumed; continue; }
    identities.push(word);
    break;
  }
  return identities;
}

function dockerRunAction(words) {
  if (path.basename(words[0] ?? '') !== 'docker') return -1;
  if (words[1] === 'run') return 1;
  if (words[1] === 'container' && words[2] === 'run') return 2;
  return -1;
}

function allowedSharedOrEphemeralRun(words) {
  const actionAt = dockerRunAction(words);
  if (actionAt < 0) return false;
  const detached = words.slice(actionAt + 1).some((word) => word === '-d' || word === '--detach' || word === '--detach=true');
  if (!detached && words.slice(actionAt + 1).some((word) => word === '--rm' || word === '--rm=true')) return true;
  const identities = runIdentities(words, actionAt);
  return words.includes('-d') && identities.includes('postgres16') && identities.includes('postgres:16');
}

function composeIdentities(words, composeAt) {
  const identities = [];
  let actionAt = -1;
  for (let index = composeAt + 1; index < words.length;) {
    const word = words[index];
    if ((word === '--project-name' || word === '-p') && words[index + 1]) identities.push(words[index + 1]);
    else if (word?.startsWith('--project-name=')) identities.push(word.slice('--project-name='.length));
    if (['up', 'run', 'create'].includes(word)) { actionAt = index; break; }
    const consumed = optionValue(words, index, COMPOSE_VALUE_OPTIONS);
    index += consumed || 1;
  }
  if (actionAt < 0) return [];
  for (let index = actionAt + 1; index < words.length;) {
    const consumed = optionValue(words, index, COMPOSE_VALUE_OPTIONS);
    if (consumed) { index += consumed; continue; }
    identities.push(words[index]);
    index += 1;
    if (words[actionAt] === 'run') break;
  }
  return identities;
}

/** Creation identities only: image, explicit name, Compose project and service, never incidental paths or arguments. */
export function scratchDockerCreation(words) {
  const executable = path.basename(words[0] ?? '');
  if (executable === 'docker-compose') return composeIdentities(words, 0);
  if (executable !== 'docker') return [];
  if (['run', 'create'].includes(words[1])) return runIdentities(words, 1);
  if (words[1] === 'container' && ['run', 'create'].includes(words[2])) return runIdentities(words, 2);
  if (words[1] === 'compose') return composeIdentities(words, 1);
  return [];
}

/** PreToolUse refusal for recognizable raw scratch starts in this conversation. */
export function scratchCreationGuard(event) {
  const problem = scratchCreationProblem(event?.tool_input?.command, conversationSkill(event));
  return problem ? deny(problem) : null;
}

if (isMain(import.meta.url)) runHookScript("pre-tool-use", preToolUse);
