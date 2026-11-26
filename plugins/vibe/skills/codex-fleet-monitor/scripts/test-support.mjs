// Shared by the node:test suites in this directory; not used at runtime.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturedJson } from '../../../lib/vibe/scripts/captured-json.mjs';

const WATCH = fileURLToPath(new URL('./watch.sh', import.meta.url));
const PROMPT_HOOK = fileURLToPath(new URL('../../../../vibe-core/hooks/user-prompt-submit.mjs', import.meta.url));

export function workDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-watcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real watcher and hook sharing a temporary fleet and a clock that advances inside sleep. */
export function gapFixture(t, { flat = false, unsetFleetHome = flat, defaultFleet = false } = {}) {
  const home = workDir(t);
  const fleetHome = defaultFleet ? join(home, 'fleet-orchestrator') : home;
  const program = flat ? join(home, 'custom-watcher-dir') : join(fleetHome, 'programs', 'active');
  const bin = join(home, 'bin');
  mkdirSync(program, { recursive: true });
  mkdirSync(bin);
  if (!flat) writeFileSync(join(fleetHome, 'current'), 'active\n');
  const command = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  command('date', 'if [ "$1" = "+%s" ]; then cat "$HOME/clock"; else exec /bin/date "$@"; fi');
  command('sleep', 'cp "$HOME/next" "$HOME/clock"');
  command('uname', 'cat "$HOME/os"');
  command('pmset', '[ "$*" = "-g log" ] || exit 2; echo read >> "$HOME/reads"; cat "$HOME/log"; exit "$(cat "$HOME/status")"');
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active RUN"\n');
  writeFileSync(join(home, 'status'), '0');
  writeFileSync(join(home, 'os'), 'Darwin');
  writeFileSync(join(home, 'log'), '');
  const env = { ...process.env, HOME: home, FLEET_HOME: fleetHome, TZ: 'America/Chicago', HEARTBEAT_SECONDS: '120',
    CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'watcher-owner',
    PATH: `${bin}:${process.env.PATH}`, WATCH_SNAPSHOT: join(home, 'snapshot.sh') };
  if (unsetFleetHome) delete env.FLEET_HOME;
  const watch = (start, end, heartbeat = '120', expectedExit = 0, watchDir = program) => {
    writeFileSync(join(home, 'clock'), String(start));
    writeFileSync(join(home, 'next'), String(end));
    const run = spawnSync('zsh', [WATCH, watchDir, '120'], { encoding: 'utf8', timeout: 8000, env: { ...env, HEARTBEAT_SECONDS: heartbeat } });
    assert.equal(run.status, expectedExit, run.stderr || run.error?.message || run.stdout);
    if (expectedExit === null) assert.equal(run.signal, 'SIGKILL');
    return run.stdout;
  };
  const prompt = ({ skill = 'fleet-orchestrator', fleetHome = env.FLEET_HOME, chat = 'watcher-owner', tz = 'America/Chicago', output = 'pipe',
    rejectNotice = false, preload, stderr = '', promptText = 'hello', turn_id, createTranscript = true } = {}) => {
    const transcript = join(home, `${skill}.jsonl`);
    if (createTranscript && !existsSync(transcript)) writeFileSync(transcript, JSON.stringify({ type: 'user', message: `Base directory for this skill: /plugins/vibe/skills/${skill}` }));
    const args = rejectNotice ? ['--input-type=module', '-e', `
      import { runEvent } from ${JSON.stringify(new URL('../../../../vibe-core/hooks/vibe-runtime.mjs', import.meta.url).href)};
      await runEvent('UserPromptSubmit', { async write(text) {
        if (text.includes('Heads up:')) throw new Error('write rejected');
        process.stdout.write(text);
      } });
    `] : [...(preload ? ['--require', preload] : []), PROMPT_HOOK];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', output, 'pipe'],
      env: { ...env, ...(fleetHome ? { FLEET_HOME: fleetHome } : {}), TZ: tz },
      input: JSON.stringify({ session_id: chat, turn_id, prompt: promptText, cwd: home, transcript_path: transcript }) });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
    assert.equal(run.stderr, stderr);
    return run.stdout ? capturedJson(run.stdout) : null;
  };
  return { home, fleetHome, program, watch, prompt, command };
}

/** Stop the fixture's recorded watcher and exit the helper before it can publish. */
export function interruptGapPublication(home, program, command, stage) {
  writeFileSync(join(home, 'interrupt'), '');
  writeFileSync(join(home, 'interrupt-publication.cjs'), `
    const fs = require('node:fs');
    const marker = process.env.HOME + '/interrupt';
    function interrupt() {
      const parent = Number(fs.readFileSync(${JSON.stringify(join(program, 'watch.lock', 'pid'))}, 'utf8'));
      if (parent <= 1 || parent !== process.ppid) throw new Error('wrong watcher');
      fs.unlinkSync(marker);
      process.kill(parent, 'SIGKILL');
      process.exit(137);
    }
    const rename = fs.renameSync, symlink = fs.symlinkSync, write = fs.writeFileSync;
    const journal = file => ['journal', 'collision'].includes(${JSON.stringify(stage)}) && file.endsWith('.pending') && fs.existsSync(marker);
    fs.renameSync = (source, target) => {
      if (${JSON.stringify(stage)} === 'snapshot' && target === ${JSON.stringify(join(program, 'watch-gap'))} && fs.existsSync(marker)) interrupt();
      const result = rename(source, target);
      if (${JSON.stringify(stage)} === 'collision' && target.endsWith('.incomplete') && fs.existsSync(marker)) interrupt();
      return result;
    };
    fs.symlinkSync = (value, file) => {
      symlink(value, file);
      if (journal(file)) interrupt();
    };
    fs.writeFileSync = (file, value, options) => {
      if (typeof file === 'string' && journal(file)) { write(file, '', options); interrupt(); }
      return write(file, value, options);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  command('node', `exec "${process.execPath}" --require "$HOME/interrupt-publication.cjs" "$@"`);
}

/**
 * The App Server's thread reads: `thread/read` returns turns only with includeTurns, `thread/turns/list` the
 * newest turns without items, `thread/items/list` a turn's newest items. With `legacy`, only `thread/read` exists.
 */
export function answerThreadRead(threads, method, params, { legacy = false } = {}) {
  const thread = threads[params?.threadId];
  if (!thread) throw new Error('no such thread');
  const turns = thread.turns ?? [];
  if (method === 'thread/read') return { thread: structuredClone({ ...thread, turns: params.includeTurns ? turns : [] }) };
  if (legacy) throw new Error(`Invalid request: unknown variant \`${method}\`, expected one of \`thread/read\``);
  if (method === 'thread/turns/list') {
    const newest = turns.slice(-(params.limit ?? turns.length)).reverse();
    return { data: newest.map((turn) => ({ ...structuredClone(turn), items: [], itemsView: 'notLoaded' })), nextCursor: null };
  }
  if (method === 'thread/items/list') {
    const items = turns.find((turn) => turn.id === params.turnId)?.items ?? [];
    return { data: items.slice(-(params.limit ?? items.length)).reverse().map((item) => ({ turnId: params.turnId, item })), nextCursor: null };
  }
  return undefined;
}
