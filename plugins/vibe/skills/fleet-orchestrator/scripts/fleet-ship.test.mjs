import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixture, remoteConfig } from './fleet-test-support.mjs';

const FLEET = fileURLToPath(new URL('./fleet.sh', import.meta.url));
const TIMEOUT = { timeout: 30_000 };
const REAL_TAR = '/usr/bin/tar';

function startFleet(f, args, env = {}) {
  const child = spawn('bash', [FLEET, f.orch, ...args], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, SLOT_LOCK_DIR: join(f.root, 'locks'),
      CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', ...env },
  });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr, stdout })));
}

test('a remote unpack that fails with File exists exits 74, the retryable shipment code, and runs nothing', TIMEOUT, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
    writeFileSync(join(f.root, 'bin', 'tar'), `#!/usr/bin/env bash
if [ "\${1:-}" = -C ] && [ "\${3:-}" = -xf ]; then
  cat >/dev/null
  printf "tar: Can't create 'plugins/vibe-core/.codex-plugin/plugin.json': File exists\\n" >&2
  exit 1
fi
exec ${REAL_TAR} "$@"
`, { mode: 0o755 });
    for (const lock of ['light', 'heavy']) {
      const result = f.run(['remote', 'slot', lock, 'w1 checks', f.root, 'echo', 'must-not-run']);
      assert.equal(result.status, 74, `${lock}: ${result.stdout}${result.stderr}`);
      assert.doesNotMatch(result.stdout, /must-not-run/);
      assert.match(result.stderr, /File exists/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a remote copy of the prompt and rulings to the stable store that fails exits 74 and runs nothing', TIMEOUT, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
    writeFileSync(join(f.orch, 'rulings.md'), '- Ruling 2026-11-18 (operator message): example\n');
    writeFileSync(join(f.root, 'bin', 'cp'), '#!/usr/bin/env bash\nif [ "$1" = -R ]; then echo "cp: No space left on device" >&2; exit 1; fi\nexec /bin/cp "$@"\n', { mode: 0o755 });
    const result = f.run(['remote', 'session', 'last', 'w1']);
    assert.equal(result.status, 74, result.stdout + result.stderr);
    assert.equal(f.argv(result).length, 0, 'no remote command ran');
    assert.match(result.stderr, /No space left on device/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('two identical remote slot shipments into a host with no generation yet both succeed under forced overlap', TIMEOUT, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.orch, 'config.env'), remoteConfig(f.root));
    const probe = join(f.root, 'extract');
    mkdirSync(probe);
    // Both unpacks wait for each other, so they overlap; a shared destination reports the historical collision.
    writeFileSync(join(f.root, 'bin', 'tar'), `#!/usr/bin/env bash
if [[ "\${1:-}" != -C || "\${3:-}" != -xf ]]; then exec ${REAL_TAR} "$@"; fi
probe=${JSON.stringify(probe)}
destination=$2
printf '%s\\n' "$destination" > "$probe/$SHIP_TEST_SIDE.path"
if ! mkdir "$destination.extracting" 2>/dev/null; then
  touch "$probe/$SHIP_TEST_SIDE.ready"
  printf "tar: Can't create 'plugins/vibe-core/.codex-plugin/plugin.json': File exists\\n" >&2
  exit 1
fi
trap 'rmdir "$destination.extracting"' EXIT
touch "$probe/$SHIP_TEST_SIDE.ready"
for (( attempt=0; attempt<200; attempt++ )); do
  if [[ -f "$probe/first.ready" && -f "$probe/second.ready" ]]; then ${REAL_TAR} "$@"; exit $?; fi
  sleep 0.05
done
exit 72
`, { mode: 0o755 });
    const results = await Promise.all(['first', 'second'].map((side) =>
      startFleet(f, ['remote', 'slot', side, side, f.root, 'echo', `ran-${side}`], { SHIP_TEST_SIDE: side })));
    assert.deepEqual(results.map(({ code }) => code), [0, 0], results.map(({ stderr }) => stderr).join('\n'));
    assert.match(results[0].stdout, /ran-first/);
    assert.match(results[1].stdout, /ran-second/);
    const destinations = ['first', 'second'].map((side) => readFileSync(join(probe, `${side}.path`), 'utf8').trim());
    assert.notEqual(destinations[0], destinations[1], 'each archive unpacks into its own stage');
    const generations = readdirSync(join(f.root, 'remote', 'sessions', '.fleet-orchestrator.generations'));
    assert.equal(generations.length, 1, `identical shipments share one generation: ${generations}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
