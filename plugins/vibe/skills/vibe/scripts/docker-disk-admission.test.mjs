import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isContainerizedBuild, measureDockerDisk, requireDockerDisk } from './e2e-lock.mjs';

const HOME = '/fixture/home';
const ROOT = '/docker/native-root';
const DATA = '/host/docker-data';
const df = (blocks) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100000000 1 ${blocks} 1% /host\n`;

function probe({ root = ROOT, endpoint = 'unix:///var/run/docker.sock', dataFolder = DATA, blocks = 62_500_000,
  rootVisible = true, desktop = false } = {}) {
  const calls = [];
  const run = (binary, args) => {
    calls.push([binary, args]);
    if (binary === 'docker' && args[0] === 'info') return { status: 0, stdout: root };
    if (binary === 'docker' && args[0] === 'context') return { status: 0, stdout: endpoint };
    if (binary === 'curl') return { status: 0, stdout: JSON.stringify({ vm: { resources: { dataFolder } } }) };
    if (binary === 'df') return { status: 0, stdout: df(blocks) };
    return { status: 1, stderr: 'unexpected probe' };
  };
  const exists = (candidate) => candidate === HOME || candidate === DATA && desktop || candidate === ROOT && rootVisible;
  const sameFile = () => desktop;
  return { calls, run, exists, sameFile };
}

test('Docker Desktop active socket selects its host data folder', () => {
  const p = probe({ desktop: true, rootVisible: false, endpoint: 'unix://' + path.join(HOME, '.docker/run/docker.sock') });
  const result = measureDockerDisk({ home: HOME, ...p });
  assert.ok(result, 'Docker Desktop backing-path probe must return a measurement');
  assert.equal(result.path, DATA);
  assert.deepEqual(p.calls.find(([binary]) => binary === 'df')?.[1], ['-Pk', DATA]);
});

test('native visible DockerRootDir is measured; unmapped VM roots refuse a host proxy', () => {
  const native = measureDockerDisk({ home: HOME, ...probe() });
  assert.ok(native, 'host-visible DockerRootDir must be measured');
  assert.equal(native.path, ROOT);
  assert.throws(() => measureDockerDisk({ home: HOME, ...probe({ rootVisible: false }) }),
    /no verified local backing path/);
  assert.throws(() => measureDockerDisk({ home: HOME, ...probe({ endpoint: 'unix:///home/user/.colima/default/docker.sock' }) }),
    /no verified local backing path/);
});

test('tcp and ssh Docker contexts never borrow local free-space measurements', () => {
  for (const endpoint of ['tcp://remote:2375', 'ssh://builder@example.invalid']) {
    const p = probe({ endpoint, rootVisible: true });
    assert.throws(() => requireDockerDisk({ home: HOME, ...p }), /nonlocal/);
    assert.equal(p.calls.some(([binary]) => binary === 'df'), false);
  }
});

test('64 GB decimal boundary uses integer df -Pk blocks without rounding', () => {
  assert.throws(() => requireDockerDisk({ home: HOME, ...probe({ blocks: 62_499_999 }) }),
    /64,000,000,000|64000000000/);
  const admitted = requireDockerDisk({ home: HOME, ...probe({ blocks: 62_500_000 }) });
  assert.equal(admitted.freeBytes, 64_000_000_000);
  assert.equal(admitted.path, ROOT);
});

test('unreadable required probe refuses with path and threshold', () => {
  const p = probe();
  const run = (binary, args) => binary === 'df' ? { status: 1, stderr: 'unavailable' } : p.run(binary, args);
  assert.throws(() => requireDockerDisk({ home: HOME, run, exists: p.exists, sameFile: p.sameFile }),
    /Docker.*\/docker\/native-root.*64,000,000,000/);
  const missingRoot = () => ({ status: 1, stderr: 'Docker unavailable' });
  assert.throws(() => requireDockerDisk({ home: HOME, run: missingRoot, exists: p.exists, sameFile: p.sameFile }),
    /Docker.*unreadable|Docker.*unavailable/);
});

test('only verified containerized build intent is admitted; no-build and ordinary checks skip', () => {
  assert.equal(isContainerizedBuild('e2e/run-containerized.sh', []), true);
  assert.equal(isContainerizedBuild('dagger', ['call', 'e-2-e']), true);
  assert.equal(isContainerizedBuild('e2e/run-containerized.sh', ['--no-build']), false);
  for (const args of [['lint'], ['typecheck'], ['test'], ['storybook']]) {
    assert.equal(isContainerizedBuild('pnpm', args), false, args.join(' '));
  }
});

test('spawned check and intent dispatch after disk constants initialize', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-disk-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const docker = path.join(dir, 'docker');
  const dfBin = path.join(dir, 'df');
  writeFileSync(docker, `#!/bin/sh\ncase "$1" in\n  info) printf '%s\\n' '${dir}' ;;\n  context) printf '%s\\n' 'unix:///var/run/docker.sock' ;;\n  *) exit 9 ;;\nesac\n`, { mode: 0o700 });
  writeFileSync(dfBin, "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/disk 100000000 1 62500000 1% /'\n", { mode: 0o700 });
  const script = fileURLToPath(new URL('./e2e-lock.mjs', import.meta.url));
  const env = { ...process.env, VIBE_E2E_DOCKER: docker, PATH: dir + path.delimiter + process.env.PATH };
  const check = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8', env });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).freeBytes, 64_000_000_000);
  const intent = spawnSync(process.execPath, [script, 'intent', 'e2e/run-containerized.sh'], { encoding: 'utf8', env });
  assert.equal(intent.status, 0, intent.stderr);
});
