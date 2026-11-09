import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadBasis, loadedSkillEvidence } from '../../vibe/scripts/loaded-skill.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
export const PLUGIN_ROOT = realpathSync(join(SCRIPTS, '..', '..', '..'));
const FLEET = join(SCRIPTS, 'fleet.sh');
export const loadEvidence = (actor = 'test', runtime = 'codex') => loadedSkillEvidence(actor, runtime, PLUGIN_ROOT,
  'fleet-orchestrator', LoadBasis.InstalledAtSpawn);

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
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *e2e-lock.mjs) [ "$2" = intent ] && exec ${JSON.stringify(process.execPath)} "$@";; esac\nprintf "arg:%s\\n" "$@"\n`);
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SLOT_LOCK_DIR: join(root, 'locks'), ...env },
  });
  const argv = (result) => result.stdout.split('\n').filter((l) => l.startsWith('arg:')).map((l) => l.slice(4));
  return { root, orch, prompt, run, argv };
}

export const remoteConfig = (root, extra = '') => `REMOTE_HOST=box\nREMOTE_STATE_DIR=${root}/remote/sessions\nREMOTE_SHELL="bash -c"\n${extra}`;

/** Let the real fleet shell complete a remote turn while the test launcher writes only remote state. */
export function successfulRemoteWriter(f, exitStatus = 0) {
  writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root, 'CODEX_EFFORT=high\n'));
  writeFileSync(join(f.root, 'bin', 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs|*skill-freshness.mjs|*owned-state.mjs|*fleet-remote-evidence.mjs) exec ${JSON.stringify(process.execPath)} "$@";; *codex-session.mjs) mkdir -p "$3"; printf '%s\\n' '{"threadId":"remote-thread","cwd":"/fixture"}' > "$3/$4.json"; exit ${exitStatus};; esac\nprintf "arg:%s\\n" "$@"\n`);
  chmodSync(join(f.root, 'bin', 'node'), 0o755);
  return join(f.root, 'future-worktree');
}

/** Install a fake remote Codex CLI for fleet shell tests without using the developer's CLI. */
export function writeRemoteCodexStub(bin, pluginRoot) {
  const target = join(bin, 'codex');
  writeFileSync(target, `#!${process.execPath}\nconst root=process.env.FAKE_REMOTE_PLUGIN_ROOT||${JSON.stringify(pluginRoot)}; console.log(JSON.stringify({installed:[{name:"vibe",installed:true,enabled:true,source:{path:root}}]}));\n`);
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
