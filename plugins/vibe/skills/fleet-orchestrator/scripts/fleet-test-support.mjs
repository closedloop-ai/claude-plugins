import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { OWN_PLUGIN } from "../../vibe/scripts/plugin-cli.mjs";

const { LoadBasis, loadedSkillEvidence } = await vibeCore("lib/vibe/scripts/loaded-skill.mjs");

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
export const PLUGIN_ROOT = realpathSync(join(SCRIPTS, '..', '..', '..'));
const FLEET = join(SCRIPTS, 'fleet.sh');
export const loadEvidence = (actor = 'test', runtime = 'codex') => loadedSkillEvidence(actor, runtime, PLUGIN_ROOT,
  'fleet-orchestrator', LoadBasis.InstalledAtSpawn);
export const TIMEOUT = { timeout: 20_000 };

/** Shared fleet CLI fixture for the base and remote transaction suites. */
export function fixture(config) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-')));
  const orch = join(root, 'orch');
  const bin = join(root, 'bin');
  mkdirSync(orch);
  mkdirSync(bin);
  if (config !== undefined) writeFileSync(join(orch, 'config.env'), config);
  writeFileSync(join(orch, 'plugin-version.json'), JSON.stringify({ status: 'current', runtime: 'codex', checkedAt: 'now', loadedSkill: loadEvidence(), harnesses: [] }));
  // Resolution, freshness and owned admission use real Node; other operational calls remain recorded.
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*/vibe/scripts/provider.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *e2e-lock.mjs) [ "$2" = intent ] && exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
  writeLoopbackSsh(bin, join(root, 'ssh-args'));
  writeFileSync(join(bin, 'cut'), '#!/bin/sh\nprintf "%s\\n" "${FLEET_TEST_LOAD:-0}"\n');
  writeFileSync(join(bin, 'sysctl'), '#!/bin/sh\nprintf "{ %s 0 0 }\\n" "${FLEET_TEST_LOAD:-0}"\n');
  writeFileSync(join(bin, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "${FLEET_TEST_CORES:-8}"\n');
  writeRemoteCodexStub(bin, PLUGIN_ROOT);
  for (const command of ['node', 'ssh', 'cut', 'sysctl', 'getconf']) chmodSync(join(bin, command), 0o755);
  const prompt = join(root, 'prompts', 'w1-01-start.md');
  mkdirSync(join(root, 'prompts'));
  writeFileSync(prompt, '$vibe ISS-1\n');
  const run = (args, env = {}) => spawnSync('bash', [FLEET, orch, ...args], {
    encoding: 'utf8',
    // No chat of the test runner's binds the lead: a case that needs one names it in `env`.
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOCK_DIR: join(root, 'locks'), CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', ...env },
  });
  const argv = (result) => result.stdout.split('\n').filter((l) => l.startsWith('arg:')).map((l) => l.slice(4));
  return { root, orch, prompt, run, argv };
}

export const remoteConfig = (root, extra = '') => `REMOTE_HOST=box\nREMOTE_STATE_DIR=${root}/remote/sessions\nREMOTE_SHELL="bash -c"\n${extra}`;

/** Let the real fleet shell complete a remote turn while the test launcher writes only remote state. */
export function successfulRemoteWriter(f, exitStatus = 0) {
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *ship-plugins.mjs|*work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs|*/vibe/scripts/provider.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit ${exitStatus};; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  return join(f.root, 'future-worktree');
}

/** Install a fake remote Codex CLI for fleet shell tests without using the developer's CLI. */
export function writeRemoteCodexStub(bin, pluginRoot) {
  const target = join(bin, 'codex');
  writeFileSync(target, `#!${process.execPath}\nconst root=process.env.FAKE_REMOTE_PLUGIN_ROOT||${JSON.stringify(pluginRoot)}; console.log(JSON.stringify({installed:[{name:${JSON.stringify(OWN_PLUGIN)},installed:true,enabled:true,source:{path:root}}]}));\n`);
  chmodSync(target, 0o755);
}

/** Run the SSH adapter's final shell argument locally and retain its argv for transport assertions. */
export function writeLoopbackSsh(bin, receipt, { archive } = {}) {
  const target = join(bin, 'ssh');
  const quoted = `'${receipt.replaceAll("'", "'\\''")}'`;
  const capture = archive ? `cat > '${archive.replaceAll("'", "'\\''")}'\nexec < '${archive.replaceAll("'", "'\\''")}'\n` : '';
  writeFileSync(target, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${quoted}\n${capture}exec bash -c "\${@: -1}"\n`);
  chmodSync(target, 0o755);
}

/** Starts `fleet.sh <args>` like fixture's run, but asynchronously: `stopped` settles when fleet.sh exits, `exited` once its output is complete. */
export function startFleet(f, args, env = {}) {
  const child = spawn('bash', [FLEET, f.orch, ...args], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks'), ...f.bound, ...env },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  // A command's own child can outlive a stopped slot and hold these pipes: macOS /bin/bash 3.2 forks the last command of
  // `bash -c 'a; b'` where bash 5 execs it, so `close` can trail the exit by the life of that child.
  const stopped = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout })));
  return { child, stopped, exited };
}

/** The macOS system bash (3.2), when this machine has it; the fleet scripts must keep working under it. */
const MAC_BASH = '/bin/bash';
const MAC_BASH_VERSION = process.platform === 'darwin' && existsSync(MAC_BASH)
  ? spawnSync(MAC_BASH, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' }) : null;
export const HAS_MAC_BASH32 = MAC_BASH_VERSION?.status === 0 && MAC_BASH_VERSION.stdout.startsWith('3.');

/** Puts macOS /bin/bash first on the fixture's PATH, so every `bash` and `env bash` in the fleet chain runs 3.2. */
export function pinMacBash(f) {
  symlinkSync(MAC_BASH, join(f.root, 'bin', 'bash'));
}

export async function waitFor(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
