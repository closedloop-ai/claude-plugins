import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN_FREE_BYTES = 64_000_000_000n;

function systemRun(binary, args) {
  return spawnSync(binary, args, { encoding: 'utf8', timeout: 30_000 });
}

function sameInode(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function output(binary, args, run) {
  const result = run(binary, args);
  if (result.error || result.status !== 0) throw new Error(binary + ' probe is unreadable: '
    + String(result.stderr ?? result.error ?? '').trim());
  return String(result.stdout ?? '').trim();
}

/** Only direct containerized E2E builds consume the disk admission budget. */
export function isContainerizedBuild(command, args = []) {
  const words = [command, ...args];
  const runner = words.some((word) => /(?:^|\/)run-containerized\.sh$/.test(word));
  if (runner) return !args.includes('--no-build');
  return path.basename(command ?? '') === 'dagger' && args[0] === 'call' && args[1] === 'e-2-e';
}

/** Measure the Docker backing filesystem in integer 1024-byte df blocks. */
export function measureDockerDisk({ home = os.homedir(), run = systemRun, exists = existsSync,
  sameFile = sameInode, docker = process.env.VIBE_E2E_DOCKER || 'docker' } = {}) {
  const root = output(docker, ['info', '--format', '{{.DockerRootDir}}'], run);
  if (!root) throw new Error('Docker root probe is unreadable');
  const endpoint = output(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], run);
  if (!endpoint.startsWith('unix://')) throw new Error('Docker context is nonlocal: ' + endpoint);
  const socketPath = endpoint.slice('unix://'.length);
  let backing;
  const desktopSocket = path.join(home, '.docker', 'run', 'docker.sock');
  if (sameFile(socketPath, desktopSocket)) {
    const socket = path.join(home, 'Library', 'Containers', 'com.docker.docker', 'Data', 'backend.sock');
    const settings = JSON.parse(output('curl', ['-s', '--unix-socket', socket, 'http://localhost/app/settings'], run));
    backing = settings?.vm?.resources?.dataFolder;
    if (typeof backing !== 'string' || !exists(backing)) throw new Error('Docker Desktop data folder is unreadable');
  } else if (exists(root)) {
    backing = root;
  } else if (exists(home)) {
    // Dory, Colima and OrbStack expose a local Unix socket while DockerRootDir
    // lives inside their VM. The repository's own prepush contract measures
    // the host home filesystem that contains those VM disks.
    backing = home;
  } else {
    throw new Error('Docker context has no verified local backing path: ' + endpoint);
  }
  let diskTable;
  try { diskTable = output('df', ['-Pk', backing], run); }
  catch (error) { throw new Error('Docker free-space probe is unreadable under ' + backing + ': ' + error.message); }
  const lines = diskTable.split(/\r?\n/);
  const available = lines[1]?.trim().split(/\s+/)[3];
  if (!/^[0-9]+$/.test(available ?? '')) {
    throw new Error('Docker free-space probe is unreadable under ' + backing + '; requires 64,000,000,000 bytes');
  }
  const free = BigInt(available) * 1024n;
  if (free > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Docker free-space probe exceeds exact integer range');
  return { path: backing, freeBytes: Number(free), thresholdBytes: Number(MIN_FREE_BYTES) };
}

/** Warn and refuse a verified build below the repo's 64 GB decimal standard. */
export function requireDockerDisk(options = {}) {
  let measured;
  try { measured = measureDockerDisk(options); }
  catch (error) { throw new Error('Docker disk admission unavailable: '
    + String(error instanceof Error ? error.message : error) + '; requires 64,000,000,000 bytes'); }
  if (BigInt(measured.freeBytes) < MIN_FREE_BYTES) {
    throw new Error('Docker build refused: ' + measured.freeBytes + ' bytes free under ' + measured.path
      + '; requires 64,000,000,000 bytes');
  }
  return measured;
}
