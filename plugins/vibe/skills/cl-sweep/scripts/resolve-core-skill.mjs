#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { codexAppServerRequest } from "../../vibe/scripts/codex-app-server.mjs";

const { harnessActor } = await vibeCore("lib/vibe/scripts/harness-identity.mjs");

const PROCESS_API = 'CLOSEDLOOP_APP_SERVER_CLIENT v1';
const CORE_ID = 'closedloop-core@closedloop-ai';
const SKILL_NAME = 'closedloop-core:gh-monitor-pr';
const BUNDLED_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export const DISCOVERY_STAGE_TIMEOUT_MS = 20_000;
export const DISCOVERY_TOTAL_TIMEOUT_MS = DISCOVERY_STAGE_TIMEOUT_MS * 4 + 2000;

function jsonCommand(executable, args, input) {
  return JSON.parse(execFileSync(executable, args, {
    input, encoding: 'utf8', timeout: DISCOVERY_STAGE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

/** Ask the supported skills/list API for the enabled installed skill's actual path. */
export function codexSkills(executable, cwd) {
  return codexAppServerRequest(executable, cwd, 'skills/list', { cwds: [cwd], forceReload: true },
    { timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS, label: 'Codex skill discovery', clientName: 'closedloop_core_discovery' });
}

/** Resolve only the core-owned monitor; unrelated or disabled names never satisfy the binding. */
export async function resolveCoreSkill(options = {}) {
  const runtime = options.runtime || discoveryRuntime();
  let skillDirectory;
  if (runtime === 'claude') {
    const registry = jsonCommand(options.claude || 'claude', ['plugin', 'list', '--json']);
    const candidates = registry.filter(plugin => plugin.id === CORE_ID && plugin.enabled === true && isAbsolute(plugin.installPath || ''));
    const rank = plugin => ({ local: 3, project: 2, user: 1 })[plugin.scope] || 0;
    const highest = Math.max(...candidates.map(rank));
    const paths = [...new Set(candidates.filter(plugin => rank(plugin) === highest).map(plugin => plugin.installPath))];
    if (paths.length !== 1) throw new Error('Install and enable one closedloop-core version for this Claude project');
    skillDirectory = resolve(paths[0], 'skills/gh-monitor-pr');
  } else if (runtime === 'codex') {
    let executable = options.codex || 'codex';
    let registry;
    try { registry = jsonCommand(executable, ['plugin', 'list', '--json']); } catch (error) {
      if (options.codex || !existsSync(BUNDLED_CODEX)) throw error;
      executable = BUNDLED_CODEX;
      registry = jsonCommand(executable, ['plugin', 'list', '--json']);
    }
    if (!registry.installed?.some(plugin => plugin.pluginId === CORE_ID && plugin.installed === true && plugin.enabled === true)) {
      throw new Error('Install and enable closedloop-core@closedloop-ai before running this workflow');
    }
    const result = await codexSkills(executable, options.cwd || process.cwd());
    const candidates = (result.data || []).flatMap(entry => entry.skills || []).filter(skill =>
      skill.pluginId === CORE_ID && skill.name === SKILL_NAME && skill.enabled === true && isAbsolute(skill.path || ''),
    );
    const paths = [...new Set(candidates.map(skill => skill.path))];
    if (paths.length !== 1) throw new Error('Update closedloop-core: its enabled gh-monitor-pr skill is missing or ambiguous');
    skillDirectory = dirname(paths[0]);
  } else throw new Error('Runtime must be codex or claude');
  let contract;
  try {
    contract = jsonCommand(process.execPath, [resolve(skillDirectory, 'scripts/client-process-api.mjs')],
      JSON.stringify({ protocol: PROCESS_API, operation: 'contract' }));
  } catch { throw new Error('Update closedloop-core: its client process API is unavailable'); }
  if (contract.protocol !== PROCESS_API || contract.result?.protocol !== PROCESS_API) {
    throw new Error('Update closedloop-core: incompatible client process API');
  }
  return { protocol: PROCESS_API, runtime, skillDirectory };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try { process.stdout.write(`${JSON.stringify(await resolveCoreSkill(JSON.parse(input || '{}')))}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

/** The harness whose installed core is resolved: the one owning this command, never a CLAUDECODE inherited by a Codex thread. */
export function discoveryRuntime(env = process.env, harness = {}) {
  return harnessActor(env, harness)?.runtime ?? (env.CLAUDECODE === '1' ? 'claude' : 'codex');
}
