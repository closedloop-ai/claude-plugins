import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bindChat, unbindChat } from '../../../lib/fleet-orchestrator/scripts/chat-binding.mjs';
import { takeSleepNotices } from '../../../lib/codex-fleet-monitor/scripts/watch-gap.mjs';
import { readProcessIdentity } from '../../../shared/process-identity.mjs';
import { recordHookSkill } from '../../../hooks/hook-session-scope.mjs';
import { watcherState } from './watcher.mjs';
import { gapFixture, interruptGapPublication, workDir } from './test-support.mjs';

const WATCH = fileURLToPath(new URL('./watch.sh', import.meta.url));
const WATCHER = fileURLToPath(new URL('./watcher.mjs', import.meta.url));
const NOW = Date.parse('2026-10-21T12:00:00Z');

const write = (dir, state) => writeFileSync(join(dir, 'watcher.json'), JSON.stringify(state));
const at = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

test('a live watcher that ticked recently is ok', (t) => {
  const dir = workDir(t);
  write(dir, { pid: process.pid, startedAt: at(600), lastTickAt: at(100), intervalSeconds: 120 });
  assert.deepEqual(watcherState(dir, NOW), { ok: true, line: `watcher ok pid=${process.pid} tick=100s ago` });
});

test('each lapse is MISSING with its reason', (t) => {
  const dir = workDir(t);
  assert.deepEqual(watcherState(dir, NOW), { ok: false, line: 'watcher MISSING(no watcher.json)' });
  write(dir, { pid: process.pid, startedAt: at(9000), lastTickAt: at(7300), intervalSeconds: 120, exitedAt: at(7200) });
  assert.equal(watcherState(dir, NOW).line, 'watcher MISSING(exited 120m ago)');
  const dead = deadPid();
  write(dir, { pid: dead, startedAt: at(600), lastTickAt: at(10), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).line, `watcher MISSING(pid ${dead} dead)`);
  write(dir, { pid: process.pid, startedAt: at(900), lastTickAt: at(361), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).line, 'watcher MISSING(no tick for 361s)');
  write(dir, { pid: process.pid, startedAt: at(900), lastTickAt: at(360), intervalSeconds: 120 });
  assert.equal(watcherState(dir, NOW).ok, true, 'twice the interval plus 120 seconds is still live');
});

test('the command prints the line and exits 1 for a missing watcher', (t) => {
  const dir = workDir(t);
  const missing = spawnSync(process.execPath, [WATCHER, dir], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, 'watcher MISSING(no watcher.json)\n');
  write(dir, { pid: process.pid, startedAt: at(60), lastTickAt: at(30), intervalSeconds: 120 });
  const live = spawnSync(process.execPath, [WATCHER, dir, '--now', new Date(NOW).toISOString()], { encoding: 'utf8' });
  assert.equal(live.status, 0);
});

const BEDTIME = Date.parse('2026-11-19T17:09:00-06:00') / 1000;
const MORNING = Date.parse('2026-11-20T09:26:00-06:00') / 1000;
const SLEEP = "2026-11-19 17:09:00 -0600 Sleep               Entering Sleep state due to 'Clamshell Sleep'";
const WAKE = "2026-11-20 09:26:00 -0600 Wake                Wake from Deep Idle [CDNVA]";

function blockRename(home, command, suffix) {
  // Obstruct the filesystem rename at its real destination, including UUID-bearing receipt names.
  writeFileSync(join(home, 'block-receipt.cjs'), `
    const fs = require('node:fs');
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target.endsWith(${JSON.stringify(suffix)}) && fs.existsSync(process.env.HOME + '/block')) {
        fs.mkdirSync(target, { recursive: true });
      }
      return rename(source, target);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  command('node', `exec "${process.execPath}" --require "$HOME/block-receipt.cjs" "$@"`);
  writeFileSync(join(home, 'block'), '');
}

test('AC-1 AC-2 AC-3 AC-4 AC-6: a confirmed late tick emits one event and one exact orchestrator notice', t => {
  const { home, program, watch, prompt } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP,
    '2026-11-20 05:02:00 -0600 DarkWake            DarkWake from Deep Idle',
    '2026-11-20 05:02:30 -0600 Sleep               Entering Sleep state due to Maintenance Sleep',
    WAKE].join('\n'));
  assert.equal(watch(BEDTIME - 10, MORNING + 20), 'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  assert.match(readFileSync(join(program, 'last-snapshot.txt'), 'utf8'), /SLEPT 16h17m/);
  const rearmed = watch(MORNING + 25, MORNING + 145);
  assert.match(rearmed, /^HEARTBEAT/);
  assert.doesNotMatch(rearmed, /SLEPT|WATCH-GAP|EVENT/);
  assert.equal(prompt({ skill: 'vibe' }), null);
  assert.equal(prompt({ fleetHome: join(home, 'other-fleet') }), null);
  assert.deepEqual(prompt(), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: 'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).' } });
  assert.equal(prompt(), null);
});

test('AC-4: a rejected hook output leaves one notice for the next two successful prompts', t => {
  const { home, watch, prompt } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  assert.equal(prompt({ rejectNotice: true, stderr: 'vibe-core UserPromptSubmit: write rejected\n' }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('AC-1: a failed clock read between ordinary ticks leaves the window unknown', t => {
  const { home, program, watch, command } = gapFixture(t);
  command('sleep', 'echo $(( $(cat "$HOME/clock") + 120 )) > "$HOME/clock"');
  command('date', `if [ "$1" != "+%s" ]; then exec /bin/date "$@"; fi
if [ "$(cat "$HOME/clock")" = "${BEDTIME + 120}" ]; then exit 1; fi
cat "$HOME/clock"`);
  assert.match(watch(BEDTIME, BEDTIME + 240, '240'), /^HEARTBEAT/);
  assert.equal(existsSync(join(home, 'reads')), false);
  assert.equal(existsSync(join(program, 'watch-gap')), false);
});

test('AC-1: an extra second of final bookkeeping preserves the entire tick window', t => {
  const { program, watch, command } = gapFixture(t);
  writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
  command('mv', `case "$2" in */last-snapshot.txt) echo ${BEDTIME + 361} > "$HOME/clock";; esac; exec /bin/mv "$@"`);
  assert.equal(watch(BEDTIME, BEDTIME + 120), 'EVENT\n> WATCH-GAP 6m\n');
  assert.match(readFileSync(join(program, 'watch-gap'), 'utf8'), new RegExp(`^watch-gap ${BEDTIME}-${BEDTIME + 361} `));
});

for (const blocked of ['claim', 'pointer']) {
  test(`AC-4: a delivered notice stays retired when ${blocked} cleanup fails`, t => {
    const { home, program, watch, prompt } = gapFixture(t);
    bindChat('watcher-owner', home, 'active', { HOME: home });
    writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
    assert.match(watch(BEDTIME, MORNING), /^EVENT/);
    const queue = join(program, 'pending-watcher-sleeps', 'chat-watcher-owner');
    const [id] = readdirSync(queue);
    const preload = join(home, 'reject-unlink.cjs');
    writeFileSync(preload, `const fs = require('node:fs'); const unlink = fs.unlinkSync;
      fs.unlinkSync = file => {
        if (${blocked === 'claim' ? `file.includes('.claim.')` : `file === ${JSON.stringify(join(queue,id))}`}) throw new Error('unlink rejected');
        return unlink(file);
      }; require('node:module').syncBuiltinESMExports();`);
    assert.match(prompt({ preload, stderr: blocked === 'claim' ? 'watcher-sleep: unlink rejected\n' : '' }).hookSpecificOutput.additionalContext, /^Heads up:/);
    assert.equal(existsSync(join(queue, id)), blocked === 'pointer');
    assert.equal(prompt(), null);
  });
}

test('AC-4: the registered prompt delivers once when ps denies the claimant identity lookup', t => {
  const { home, watch, prompt, command } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  command('ps', 'echo "$*" >> "$HOME/denied-ps"; exit 1');
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.match(readFileSync(join(home, 'denied-ps'), 'utf8'), /-o lstart=,command= -p \d+/);
  assert.equal(prompt(), null);
});

test('AC-4: a read-only program volume after accepted output cannot repeat the notice', t => {
  const { home, program, watch, prompt } = gapFixture(t);
  bindChat('watcher-owner', home, 'active', { HOME: home });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  const preload = join(home, 'readonly-after-write.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
    let readOnly = false;
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = function(text, ...args) {
      const result = write(text, ...args);
      if (text.includes('Heads up:')) readOnly = true;
      return result;
    };
    for (const operation of ['unlinkSync', 'renameSync', 'writeFileSync']) {
      const original = fs[operation];
      fs[operation] = (file, ...args) => {
        if (readOnly && file.startsWith(${JSON.stringify(program)})) throw Object.assign(new Error('read-only volume'), {code:'EROFS'});
        return original(file, ...args);
      };
    }
    require('node:module').syncBuiltinESMExports();`);
  assert.match(prompt({ preload, stderr: 'watcher-sleep: read-only volume\n' }).hookSpecificOutput.additionalContext, /^Heads up:/);
  assert.equal(prompt(), null);
});

test('AC-4: failed offer preparation preserves the combined return checklist and healthy notice', t => {
  const { home, watch, prompt } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  writeFileSync(join(home, 'log'), [SLEEP.replace('19 17:09', '20 17:09'), WAKE.replace('20 09:26', '21 09:26')].join('\n'));
  assert.match(watch(BEDTIME + 86400, MORNING + 86400), /^EVENT/);
  const preload = join(home, 'fail-first-offer.cjs');
  writeFileSync(preload, `const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.includes('watch-sleep.${BEDTIME}-') && to.endsWith('.offered')) throw new Error('offer unavailable');
      return rename(from, to);
    }; require('node:module').syncBuiltinESMExports();`);
  const context = prompt({ preload, promptText: "I'm back", stderr: 'watcher-sleep: offer unavailable\n' })?.hookSpecificOutput.additionalContext;
  assert.match(context, /The operator is back\./);
  assert.equal(context.match(/Heads up:/g)?.length, 1);
  assert.match(prompt()?.hookSpecificOutput.additionalContext, /^Heads up:/);
  assert.equal(prompt(), null);
});

/** Exit the registered hook immediately before stdout or immediately after its actual write. */
function interruptOffer(home, accepted) {
  const preload = join(home, 'interrupt-offer.cjs');
  writeFileSync(preload, accepted ? `const fs = require('node:fs');
    process.stdout.write = text => { fs.writeSync(1, text); process.exit(0); };` : `
    const fs = require('node:fs'); const rename = fs.renameSync;
    fs.renameSync = (from, to) => { rename(from, to); if (to.endsWith('.offered')) process.exit(0); };
    require('node:module').syncBuiltinESMExports();`);
  return preload;
}

for (const accepted of [false, true]) {
  test(`AC-4: abandoned offered turn with host acceptance ${accepted} reconciles from its own transcript`, t => {
    const { home, program, watch, prompt } = gapFixture(t);
    writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
    assert.match(watch(BEDTIME, MORNING), /^EVENT/);
    const transcript = join(home, 'fleet-orchestrator.jsonl');
    const task = (type, turn_id) => ({type: 'event_msg', payload: {type, turn_id}});
    const message = (role, text, kind) => ({type: 'response_item', payload: {type: 'message', role,
      content: [{type: 'input_text', text}], internal_chat_message_metadata_passthrough: {content_item_kinds: [kind]}}});
    const append = (...rows) => writeFileSync(transcript, rows.map(row => JSON.stringify(row) + '\n').join(''), { flag: 'a' });
    const notice = 'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).';
    append(message('user', '<skill><name>vibe:fleet-orchestrator</name></skill>'),
      task('task_started', 'previous'), message('developer', notice), task('task_complete', 'previous'), task('task_started', 'offer-turn'));
    const first = prompt({preload: interruptOffer(home, accepted), turn_id: 'offer-turn'});
    if (accepted) {
      assert.equal(first?.hookSpecificOutput.additionalContext, notice);
      append(message('developer', first.hookSpecificOutput.additionalContext, 'hooks.additional_context'));
    } else {
      assert.equal(first, null);
      const untagged = message('developer', notice);
      delete untagged.payload.internal_chat_message_metadata_passthrough;
      append(message('user', notice), message('developer', notice, 'instructions'), untagged);
      assert.equal(prompt({turn_id: 'concurrent'}), null, 'an unfinished turn cannot prove absence');
    }
    append(task('task_complete', 'offer-turn'), task('task_started', 'next'));
    assert.equal(prompt({turn_id: 'next'})?.hookSpecificOutput.additionalContext, accepted ? undefined : notice);
    assert.equal(readdirSync(program).some(name => name.endsWith('.offered')), false);
    assert.equal(prompt({turn_id: 'third'}), null);
  });

  test(`AC-4: a turnless abandoned offer with host acceptance ${accepted} recovers at its transcript position`, t => {
    const { home, program, watch, prompt } = gapFixture(t);
    writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
    assert.match(watch(BEDTIME, MORNING), /^EVENT/);
    const transcript = join(home, 'fleet-orchestrator.jsonl');
    const append = (...rows) => writeFileSync(transcript, rows.map(row => JSON.stringify({sessionId: 'watcher-owner', ...row}) + '\n').join(''), {flag: 'a'});
    const attached = (text, hookEvent = 'UserPromptSubmit') => ({type: 'attachment',
      attachment: {type: 'hook_additional_context', hookEvent, content: [text]}});
    const ended = {type: 'assistant', message: {role: 'assistant', stop_reason: 'end_turn'}};
    const notice = 'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).';
    append({type: 'user', message: {role: 'user', content: 'Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator'}},
      attached(notice), ended);
    const first = prompt({preload: interruptOffer(home, accepted)});
    if (accepted) {
      assert.equal(first?.hookSpecificOutput.additionalContext, notice);
      append(attached(first.hookSpecificOutput.additionalContext));
    } else {
      assert.equal(first, null);
      append({type: 'user', message: {role: 'user', content: notice}}, attached(notice, 'PreToolUse'),
        {...attached(notice), isSidechain: true}, {...ended, sessionId: 'different-session'});
      assert.equal(prompt(), null, 'the owner prompt is still incomplete');
    }
    append(ended);
    assert.equal(prompt()?.hookSpecificOutput.additionalContext, accepted ? undefined : notice);
    assert.equal(readdirSync(program).some(name => name.endsWith('.offered')), false);
    assert.equal(prompt(), null);
  });
}

test('AC-4: a turnless owner with a missing transcript keeps the notice ready and the checklist visible', t => {
  const { home, program, watch, prompt } = gapFixture(t);
  recordHookSkill('watcher-owner', 'vibe:fleet-orchestrator', home);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  const first = prompt({createTranscript: false, preload: interruptOffer(home, false), promptText: "I'm back",
    stderr: 'watcher-sleep: sleep notice has no recoverable transcript position\n'});
  assert.match(first?.hookSpecificOutput.additionalContext ?? '', /The operator is back\./);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /Heads up:/);
  const receipts = readdirSync(program).filter(name => name.startsWith('watch-sleep.'));
  assert.equal(receipts.length, 1);
  assert.match(receipts[0], /\.ready$/);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext, 'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('AC-4: a reused claimant PID releases a notice while the original process retains it', t => {
  const { home, program, watch, prompt } = gapFixture(t);
  const chat = `watcher-identity-test-${process.pid}`;
  bindChat(chat, home, 'active', { HOME: home });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  assert.match(takeSleepNotices(program, chat, () => true).context, /^Heads up:/);
  const [claim] = readdirSync(program).filter(name => name.includes('.claim.'));
  const prefix = claim.slice(0, claim.indexOf('.claim.')) + `.claim.${process.pid}.`;
  for (const tz of ['UTC', 'America/Chicago']) assert.equal(prompt({ chat, tz }), null);
  const identity = readProcessIdentity(process.pid, { env: { ...process.env, TZ: 'UTC' } });
  assert.equal(claim, prefix + createHash('sha256').update(identity).digest('hex'));
  renameSync(join(program, claim), join(program, prefix + createHash('sha256').update('a previous process').digest('hex')));
  assert.match(prompt({ chat }).hookSpecificOutput.additionalContext, /^Heads up:/);
  assert.equal(prompt({ chat }), null);
});

test('AC-2: a late pmset stream error discards even a complete pair and reports the gap', t => {
  const { home, watch, prompt, command } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n') + '\n');
  writeFileSync(join(home, 'broken-log.cjs'), `const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (file, ...args) => {
      if (file !== 'pmset') return spawn(file, ...args);
      const child = new (require('node:events').EventEmitter)();
      child.stdout = require('node:stream').Readable.from((async function* () {
        yield require('node:fs').readFileSync(process.env.HOME + '/log');
        await new Promise(resolve => setImmediate(resolve));
        throw Object.assign(new Error('power log read failed'), {code:'EIO'});
      })());
      child.stdout.once('close', () => child.emit('close', 0));
      return child;
    };
    require('node:module').syncBuiltinESMExports();`);
  command('node', `exec "${process.execPath}" --require "$HOME/broken-log.cjs" "$@"`);
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> WATCH-GAP 16h17m\n');
  assert.equal(prompt(), null);
});

test('AC-2: an impossible calendar date cannot confirm an in-window sleep', t => {
  const { home, watch, prompt } = gapFixture(t);
  const start = Date.parse('2026-03-02T00:00:00Z') / 1000;
  const sleep = '2026-03-02 00:00:00 +0000 Sleep Entering Sleep state';
  const wake = '2026-03-02 00:05:00 +0000 Wake Wake from Deep Idle';
  writeFileSync(join(home, 'log'), sleep.replace('03-02', '02-30') + '\n' + wake);
  assert.equal(watch(start, start + 300), 'EVENT\n> WATCH-GAP 5m\n');
  assert.equal(prompt(), null);
  const control = gapFixture(t);
  writeFileSync(join(control.home, 'log'), sleep + '\n' + wake);
  assert.match(control.watch(start, start + 300), /^EVENT\n> SLEPT 5m /);
});

test('AC-1 AC-2 AC-6: ordinary ticks stay quiet and unconfirmed gaps never report sleep', t => {
  const { home, watch, prompt } = gapFixture(t);
  assert.match(watch(BEDTIME, BEDTIME + 120), /^HEARTBEAT/);
  assert.match(watch(BEDTIME, BEDTIME + 240), /^HEARTBEAT/);
  assert.equal(existsSync(join(home, 'reads')), false);
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> WATCH-GAP 16h17m\n');
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  // The sleep record precedes this window. A wake alone proves nothing.
  assert.equal(watch(BEDTIME + 60, MORNING + 60), 'EVENT\n> WATCH-GAP 16h17m\n');
  writeFileSync(join(home, 'status'), '1');
  assert.equal(watch(BEDTIME - 1, MORNING + 1), 'EVENT\n> WATCH-GAP 16h17m\n');
  writeFileSync(join(home, 'os'), 'Linux');
  writeFileSync(join(home, 'status'), '0');
  assert.equal(watch(BEDTIME - 2, MORNING + 2), 'EVENT\n> WATCH-GAP 16h17m\n');
  assert.equal(readFileSync(join(home, 'reads'), 'utf8'), 'read\nread\nread\n');
  assert.equal(prompt(), null);
});

test('AC-1 AC-3: a gap during snapshot bookkeeping is counted at the next tick', t => {
  const { home, program, watch, command } = gapFixture(t);
  mkdirSync(join(program, 'events'));
  writeFileSync(join(program, 'events', 'steady'), 'steady');
  assert.match(watch(BEDTIME - 120, BEDTIME), /^HEARTBEAT/);
  // Advance during the first checksum, after its tick-end sample. Keep subsequent sleeps on that clock.
  command('cksum', `echo ${MORNING} > "$HOME/clock"; echo ${MORNING} > "$HOME/next"; exec /usr/bin/cksum`);
  assert.equal(watch(BEDTIME - 120, BEDTIME, '240'), 'EVENT\n> WATCH-GAP 16h17m\n');
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
});

test('AC-4: a second orchestrator in the same unbound program cannot consume the watcher owner’s notice', t => {
  const { home, watch, prompt } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  assert.equal(prompt({ chat: 'different-orchestrator' }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('AC-4 AC-6: a hook in UTC replays the exact times recorded in Chicago', t => {
  const { home, watch, prompt } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /sleep 17:09 CST, wake 09:26 CST/);
  assert.equal(prompt({ tz: 'UTC' })?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt({ tz: 'UTC' }), null);
});

test('AC-4 AC-6: the registered hook emits a custom flat watcher’s notice once across two owner prompts', t => {
  const { home, watch, prompt } = gapFixture(t, { flat: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT\n> SLEPT/);
  assert.equal(prompt({ chat: 'different-orchestrator' }), null);

  // Capture the actual core hook's stdout at the harness boundary. The host owns its transcript.
  const capture = join(home, 'registered-hook-output.jsonl');
  const output = openSync(capture, 'ax');
  const expected = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: 'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).' } };
  try {
    prompt({ output });
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), expected);
    prompt({ output });
  } finally {
    closeSync(output);
  }
  const records = readFileSync(capture, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records, [expected]);
});

test('AC-4: an explicit program under a custom home routes to the bound owner or launching chat', t => {
  const { home, watch, prompt } = gapFixture(t, { unsetFleetHome: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  assert.equal(prompt({ chat: 'different-orchestrator' }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
  bindChat('program-holder', home, 'active', { HOME: home });
  writeFileSync(join(home, 'log'), [SLEEP.replace('19 ', '20 '), WAKE.replace('20 ', '21 ')].join('\n'));
  assert.match(watch(BEDTIME + 86400, MORNING + 86400), /^EVENT/);
  assert.equal(prompt(), null);
  assert.equal(prompt({ chat: 'program-holder' })?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt({ chat: 'program-holder' }), null);
});

test('AC-1 AC-3 AC-4: a blocked notice queue preserves both snapshot changes and retries pending notices once', t => {
  const { home, program, watch, prompt } = gapFixture(t, { flat: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
  const hookState = join(home, '.vibe-hook-scope');
  mkdirSync(hookState, { recursive: true });
  const obstruction = join(hookState, 'watcher-sleeps');
  writeFileSync(obstruction, 'blocks directory creation');
  const first = watch(BEDTIME, MORNING);
  assert.match(first, /^EVENT\n/);
  assert.match(first, /^> SLEPT 16h17m /m);
  assert.match(first, /^> session local active DONE$/m);
  assert.match(readFileSync(join(program, 'last-snapshot.txt'), 'utf8'), /session local active DONE[\s\S]+SLEPT 16h17m/);
  writeFileSync(join(home, 'log'), [SLEEP.replace('19 ', '20 '), WAKE.replace('20 ', '21 ').replace('09:26', '08:26')].join('\n'));
  assert.match(watch(BEDTIME + 86400, MORNING + 86400), /^EVENT\n> SLEPT 15h17m /);
  rmSync(obstruction);
  assert.match(watch(MORNING + 86400, MORNING + 86520), /^HEARTBEAT/);
  assert.equal(prompt({ chat: 'different-orchestrator' }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext, [
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).',
    'Heads up: this computer was asleep for 15h17m (slept 17:09 CST, woke 08:26 CST).',
  ].join('\n'));
  assert.match(watch(MORNING + 86520, MORNING + 86640), /^HEARTBEAT/);
  assert.equal(prompt(), null);
});

test('AC-4: a flat notice stays with its origin across explicit fleet and binding changes', t => {
  const { home, program, watch, prompt } = gapFixture(t, { flat: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  const other = join(home, 'other-fleet');
  mkdirSync(join(other, 'programs', 'elsewhere'), { recursive: true });
  writeFileSync(join(other, 'current'), 'elsewhere\n');
  assert.equal(prompt({ fleetHome: other }), null);
  bindChat('watcher-owner', other, 'elsewhere', { HOME: home });
  assert.equal(prompt(), null);
  unbindChat('watcher-owner', { HOME: home });
  assert.equal(prompt({ fleetHome: program })?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('AC-1 AC-3: an empty failed recovery preserves fleet rows while an independently detected gap can wake', t => {
  const { home, program, watch } = gapFixture(t);
  const lastSnapshot = join(program, 'last-snapshot.txt');
  assert.match(watch(BEDTIME, MORNING), /^EVENT\n> WATCH-GAP/);
  const before = readFileSync(lastSnapshot, 'utf8');
  assert.match(before, /^session local active RUN\nwatch-gap /);
  writeFileSync(join(home, 'snapshot.sh'), 'exit 7\n');
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
  assert.equal(readFileSync(lastSnapshot, 'utf8'), before);
  assert.equal(watch(MORNING + 120, MORNING + 420), 'EVENT\n> WATCH-GAP 5m\n');
  assert.match(readFileSync(lastSnapshot, 'utf8'), /^session local active RUN\nwatch-gap [^ ]+ WATCH-GAP 5m\n$/);
  assert.match(watch(MORNING + 420, MORNING + 540), /^HEARTBEAT/);
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
  assert.equal(watch(MORNING + 540, MORNING + 660), 'EVENT\n< session local active RUN\n> session local active DONE\n');
});

test('AC-4: selecting another implicit current program leaves the original notice pending', t => {
  const { home, fleetHome, watch, prompt } = gapFixture(t, { unsetFleetHome: true, defaultFleet: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  mkdirSync(join(fleetHome, 'programs', 'other'));
  writeFileSync(join(fleetHome, 'current'), 'other\n');
  assert.equal(prompt(), null);
  bindChat('other-owner', fleetHome, 'other', { HOME: home });
  assert.equal(prompt(), null);
  writeFileSync(join(fleetHome, 'current'), 'active\n');
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('AC-1 AC-3 AC-4: failed initial receipt creation keeps confirmed events and both notices recoverable', t => {
  const { home, program, watch, prompt, command } = gapFixture(t, { flat: true });
  blockRename(home, command, '.retry');
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  writeFileSync(join(home, 'log'), [SLEEP.replace('19 ', '20 '), WAKE.replace('20 ', '21 ').replace('09:26', '08:26')].join('\n'));
  assert.equal(watch(BEDTIME + 86400, MORNING + 86400), 'EVENT\n> SLEPT 15h17m (sleep 17:09 CST, wake 08:26 CST)\n');
  assert.equal(prompt(), null);
  const blocked = readdirSync(program, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.retry'));
  assert.equal(blocked.length, 2);
  rmSync(join(home, 'block'));
  for (const entry of blocked) rmSync(join(program, entry.name), { recursive: true });
  assert.match(watch(MORNING + 86400, MORNING + 86520), /^HEARTBEAT/);
  assert.equal(prompt({ chat: 'unrelated' }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext, [
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).',
    'Heads up: this computer was asleep for 15h17m (slept 17:09 CST, woke 08:26 CST).',
  ].join('\n'));
  assert.equal(prompt(), null);
});

test('AC-1 AC-3: failed primary gap publication retains exact windows across a concurrent fleet wake', t => {
  const { home, program, watch, prompt, command } = gapFixture(t);
  const primary = join(program, 'watch-gap');
  blockRename(home, command, '/watch-gap');
  writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n< session local active RUN\n> session local active DONE\n');
  writeFileSync(join(home, 'log'), '');
  assert.match(watch(MORNING + 10, MORNING + 310), /^HEARTBEAT/);
  assert.equal(prompt(), null);
  rmSync(join(home, 'block'));
  rmSync(primary, { recursive: true });
  // Interrupt after the primary commit but before last-snapshot acknowledges the first restored window.
  writeFileSync(join(home, 'interrupt'), '');
  command('mv', 'if [ -f "$HOME/interrupt" ] && [ -f "$HOME/programs/active/watch-gap" ]; then rm "$HOME/interrupt"; kill -TERM "$(cat "$HOME/programs/active/watch.lock/pid")"; fi; exec /bin/mv "$@"');
  watch(MORNING + 310, MORNING + 430, '120', 143);
  assert.equal(watch(MORNING + 430, MORNING + 550), 'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  assert.equal(watch(MORNING + 550, MORNING + 670), 'EVENT\n> WATCH-GAP 5m\n');
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
  assert.match(watch(MORNING + 670, MORNING + 790), /^HEARTBEAT/);
});

test('AC-4: a supported flat fleet migration preserves the notice for its owning program', t => {
  const { home, program, watch, prompt } = gapFixture(t, { flat: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  const cli = fileURLToPath(new URL('../../fleet-orchestrator/scripts/fleet-home.mjs', import.meta.url));
  const destination = join(home, 'migrated');
  const result = spawnSync(process.execPath, [cli, 'migrate', '--from', program, '--home', destination, '--program', 'active'], {
    encoding: 'utf8', timeout: 8000, env: { ...process.env, HOME: home, FLEET_HOME: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: 'watcher-owner' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(prompt({ fleetHome: join(home, 'unrelated') }), null);
  assert.equal(prompt()?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
});

test('main compatibility: successful empty recovery clears fleet rows with an old or new gap', t => {
  const { home, program, watch } = gapFixture(t);
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  writeFileSync(join(home, 'snapshot.sh'), 'exit 0\n');
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
  assert.doesNotMatch(readFileSync(join(program, 'last-snapshot.txt'), 'utf8'), /session /);
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active RUN"\n');
  // Main diffs echo's empty line against the returning row.
  assert.equal(watch(MORNING + 120, MORNING + 240), 'EVENT\n< \n> session local active RUN\n');
  writeFileSync(join(home, 'snapshot.sh'), 'exit 0\n');
  assert.equal(watch(MORNING + 240, MORNING + 540), 'EVENT\n> WATCH-GAP 5m\n');
});

test('AC-3: a missing internal gap file cannot wake alone or mask a fleet change', t => {
  const { home, program, watch } = gapFixture(t);
  assert.match(watch(BEDTIME, MORNING), /^EVENT/);
  rmSync(join(program, 'watch-gap'));
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
  assert.match(watch(MORNING + 120, MORNING + 420), /^EVENT/);
  rmSync(join(program, 'watch-gap'));
  writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
  assert.equal(watch(MORNING + 420, MORNING + 540), 'EVENT\n< session local active RUN\n> session local active DONE\n');
});

for (const status of [0, 7]) {
  test(`AC-3: an event-file change survives empty recovery status ${status} and a new gap`, t => {
    const { home, program, watch } = gapFixture(t);
    assert.match(watch(BEDTIME, BEDTIME + 120), /^HEARTBEAT/);
    mkdirSync(join(program, 'events'));
    writeFileSync(join(program, 'events', 'ordinary'), 'changed');
    writeFileSync(join(home, 'snapshot.sh'), `exit ${status}\n`);
    const output = watch(BEDTIME + 120, BEDTIME + 420);
    assert.match(output, /^EVENT\n/);
    assert.match(output, /^> event ordinary \d+$/m);
    assert.match(output, /^> WATCH-GAP 5m$/m);
    const saved = readFileSync(join(program, 'last-snapshot.txt'), 'utf8');
    assert.equal(saved.includes('session local active RUN'), status !== 0);
    assert.match(watch(BEDTIME + 420, BEDTIME + 540), /^HEARTBEAT/);
  });
}

test('AC-4: a physical program reached through a case alias still delivers only to its bound holder', t => {
  const { home, program, watch, prompt } = gapFixture(t);
  bindChat('program-holder', home, 'active', { HOME: home });
  const alias = join(home, 'PROGRAMS');
  if (!existsSync(alias)) symlinkSync(join(home, 'programs'), alias, 'dir');
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.match(watch(BEDTIME, MORNING, '120', 0, join(alias, 'active')), /^EVENT/);
  assert.equal(prompt({ chat: 'program-holder' })?.hookSpecificOutput.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt({ chat: 'program-holder' }), null);
  assert.equal(prompt({ fleetHome: program }), null);
});

for (const fleetChange of [false, true]) {
  test(`AC-1 AC-3: final bookkeeping catches sleep on a single ${fleetChange ? 'fleet event' : 'heartbeat'} tick`, t => {
    const { home, program, watch, prompt, command } = gapFixture(t);
    writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
    if (fleetChange) writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
    writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
    // Advance after the final exitedAt stamp is prepared, as it is being installed.
    writeFileSync(join(home, 'advance'), '');
    command('mv', `case "$2" in */watcher.json) if [ -f "$HOME/advance" ] && grep -q exitedAt "$1"; then rm "$HOME/advance"; echo ${MORNING} > "$HOME/clock"; fi;; esac; exec /bin/mv "$@"`);
    const result = watch(BEDTIME - 120, BEDTIME);
    assert.match(result, /^EVENT\n/);
    assert.match(result, /^> SLEPT 16h17m \(sleep 17:09 CST, wake 09:26 CST\)$/m);
    assert.equal(result.includes('> session local active DONE'), fleetChange);
    assert.equal(prompt()?.hookSpecificOutput.additionalContext,
      'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
    assert.match(watch(MORNING + 86400, MORNING + 86520), /^HEARTBEAT/);
    assert.equal(prompt(), null);
  });
}

test('AC-1: the last snapshot write can push an ordinary tick just over its tolerance', t => {
  const { home, program, watch, command } = gapFixture(t);
  writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
  command('mv', `case "$2" in */last-snapshot.txt) echo ${BEDTIME + 241} > "$HOME/clock";; esac; exec /bin/mv "$@"`);
  assert.equal(watch(BEDTIME, BEDTIME + 120), 'EVENT\n> WATCH-GAP 4m\n');
});

for (const [tick, fleetChange, heartbeat] of [
  ['heartbeat', false, '120'], ['fleet event', true, '120'], ['quiet intermediate', false, '240'],
]) {
  test(`AC-1 AC-3: failed baseline verification samples a late rename on a ${tick} tick`, t => {
    const { home, program, watch, command } = gapFixture(t);
    writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
    if (fleetChange) writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
    const late = BEDTIME + 241;
    command('mv', `case "$2" in */last-snapshot.txt) echo ${late} > "$HOME/clock";; esac; exec /bin/mv "$@"`);
    command('cmp', 'case "$2" in */last-snapshot.txt) exit 2;; esac; exec /usr/bin/cmp "$@"');
    const first = watch(BEDTIME, BEDTIME + 120, heartbeat, fleetChange ? 0 : 1);
    assert.equal(first, fleetChange ? 'EVENT\n< session local active RUN\n> session local active DONE\n' : '');
    assert.equal(readFileSync(join(program, 'watch-gap-ack'), 'utf8'), '\n');
    rmSync(join(home, 'bin', 'mv'));
    rmSync(join(home, 'bin', 'cmp'));
    assert.equal(watch(late, late + 120), 'EVENT\n> WATCH-GAP 4m\n');
    assert.match(watch(late + 120, late + 240), /^HEARTBEAT/);
  });
}

test('AC-1 AC-3: failed baseline verification during a second late rename preserves both gaps', t => {
  const { home, program, watch, command } = gapFixture(t);
  writeFileSync(join(program, 'last-snapshot.txt'), 'session local active RUN\n');
  const first = BEDTIME + 241;
  const second = first + 360;
  // The first baseline write succeeds. Only the follow-up write containing the first gap fails verification.
  command('mv', `case "$2" in */last-snapshot.txt)
    if grep -q '^watch-gap ' "$1"; then echo ${second}; else echo ${first}; fi > "$HOME/clock";;
  esac; exec /bin/mv "$@"`);
  command('cmp', 'case "$2" in */last-snapshot.txt) if grep -q "^watch-gap " "$2"; then exit 2; fi;; esac; exec /usr/bin/cmp "$@"');
  assert.equal(watch(BEDTIME, BEDTIME + 120, '120', 1), '');
  assert.equal(readFileSync(join(program, 'watch-gap-ack'), 'utf8'), '\n');
  rmSync(join(home, 'bin', 'mv'));
  rmSync(join(home, 'bin', 'cmp'));
  assert.equal(watch(second, second + 120), 'EVENT\n> WATCH-GAP 4m\n');
  assert.equal(watch(second + 120, second + 240), 'EVENT\n> WATCH-GAP 6m\n');
  assert.match(watch(second + 240, second + 360), /^HEARTBEAT/);
});

test('AC-3: failed snapshot acknowledgment retains the previous baseline and the gap for one retry', t => {
  const { home, program, watch, command } = gapFixture(t);
  const baseline = 'session local active RUN\n';
  writeFileSync(join(program, 'last-snapshot.txt'), baseline);
  writeFileSync(join(home, 'block-ack'), 'not a directory');
  // Force the OS rename to fail while the prior acknowledgment remains a readable regular file.
  command('mv', 'case "$2" in */last-snapshot.txt) if [ -f "$HOME/block-ack" ]; then exec /bin/mv "$1" "$HOME/block-ack/missing"; fi; if [ -f "$HOME/drop-ack" ]; then exit 0; fi;; esac; exec /bin/mv "$@"');
  assert.equal(watch(BEDTIME, MORNING, '120', 1), '');
  assert.equal(readFileSync(join(program, 'last-snapshot.txt'), 'utf8'), baseline);
  assert.match(readFileSync(join(program, 'watch-gap'), 'utf8'), /WATCH-GAP 16h17m/);
  rmSync(join(home, 'block-ack'));
  writeFileSync(join(home, 'drop-ack'), '');
  assert.equal(watch(MORNING, MORNING + 120, '120', 1), '');
  assert.equal(readFileSync(join(program, 'last-snapshot.txt'), 'utf8'), baseline);
  rmSync(join(home, 'drop-ack'));
  assert.equal(watch(MORNING, MORNING + 120), 'EVENT\n> WATCH-GAP 16h17m\n');
  assert.match(watch(MORNING + 120, MORNING + 240), /^HEARTBEAT/);
});

for (const withGap of [false, true]) {
  test(`AC-3: failed baseline verification reports the fleet diff ${withGap ? 'and keeps the gap pending' : 'on an ordinary tick'}`, t => {
    const { home, program, watch, command } = gapFixture(t);
    const baseline = join(program, 'last-snapshot.txt');
    writeFileSync(baseline, 'session local active RUN\n');
    writeFileSync(join(home, 'snapshot.sh'), 'print "session local active DONE"\n');
    // Fail the verification of the installed baseline after the real rename succeeds.
    command('cmp', 'case "$2" in */last-snapshot.txt) exit 2;; esac; exec /usr/bin/cmp "$@"');
    const end = withGap ? MORNING : BEDTIME + 120;
    assert.equal(watch(BEDTIME, end), 'EVENT\n< session local active RUN\n> session local active DONE\n');
    assert.match(readFileSync(baseline, 'utf8'), /^session local active DONE$/m);
    assert.equal(readFileSync(join(program, 'watch-gap-ack'), 'utf8'), '\n');
    rmSync(join(home, 'bin', 'cmp'));
    if (withGap) assert.equal(watch(end, end + 120), 'EVENT\n> WATCH-GAP 16h17m\n');
    assert.match(watch(end + 120, end + 240), /^HEARTBEAT/);
  });
}

test('AC-3: deleting the fleet baseline keeps a reported gap quiet and an unacknowledged gap pending', t => {
  const { home, program, watch, command } = gapFixture(t);
  const baseline = join(program, 'last-snapshot.txt');
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> WATCH-GAP 16h17m\n');
  rmSync(baseline);
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
  assert.match(readFileSync(baseline, 'utf8'), /WATCH-GAP 16h17m/);
  writeFileSync(join(home, 'fail-next-ack'), '');
  command('mv', 'case "$2" in */watch-gap-ack) if [ -f "$HOME/fail-next-ack" ]; then rm "$HOME/fail-next-ack"; exit 1; fi;; esac; exec /bin/mv "$@"');
  assert.equal(watch(MORNING + 120, MORNING + 420, '120', 1), '');
  assert.match(readFileSync(baseline, 'utf8'), /WATCH-GAP 5m/);
  rmSync(baseline);
  assert.equal(watch(MORNING + 420, MORNING + 540), 'EVENT\n> WATCH-GAP 5m\n');
  assert.match(watch(MORNING + 540, MORNING + 660), /^HEARTBEAT/);
});

for (const stage of ['journal', 'snapshot']) test(`AC-3: a hard kill at the first ${stage} write preserves the event and notice`, t => {
  const { home, program, watch, prompt, command } = gapFixture(t);
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  interruptGapPublication(home, program, command, stage);
  assert.equal(watch(BEDTIME, MORNING, '120', null), '');
  assert.equal(watch(MORNING, MORNING + 120), 'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  assert.equal(prompt()?.hookSpecificOutput?.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
  assert.match(watch(MORNING + 120, MORNING + 240), /^HEARTBEAT/);
});

for (const scenario of ['later', 'matching', 'interrupted matching']) test(`AC-3: a truncated regular journal does not block the ${scenario} confirmed window`, t => {
  const { home, program, watch, prompt, command } = gapFixture(t);
  const window = scenario === 'later' ? `${BEDTIME - 360}-${BEDTIME - 60}` : `${BEDTIME}-${MORNING}`;
  const partial = join(program, `watch-window.${window}.pending`);
  writeFileSync(partial, '{"line":');
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  const interrupted = scenario === 'interrupted matching';
  if (interrupted) {
    interruptGapPublication(home, program, command, 'collision');
    assert.equal(watch(BEDTIME, MORNING, '120', null), '');
  }
  assert.equal(watch(interrupted ? MORNING : BEDTIME, interrupted ? MORNING + 120 : MORNING, '240'),
    'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  assert.equal(existsSync(partial), false);
  assert.equal(readFileSync(`${partial}.incomplete`, 'utf8'), '{"line":');
  assert.equal(prompt()?.hookSpecificOutput?.additionalContext,
    'Heads up: this computer was asleep for 16h17m (slept 17:09 CST, woke 09:26 CST).');
  assert.equal(prompt(), null);
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
});

test('AC-3: a failed first journal write retries the same sampled duration', t => {
  const { home, watch, command } = gapFixture(t);
  writeFileSync(join(home, 'fail-journal'), '');
  writeFileSync(join(home, 'later'), String(BEDTIME + 480));
  writeFileSync(join(home, 'fail-journal.cjs'), `
    const fs = require('node:fs');
    const create = fs.symlinkSync;
    fs.symlinkSync = (value, file) => {
      const marker = process.env.HOME + '/fail-journal';
      if (file.endsWith('.pending') && fs.existsSync(marker)) {
        fs.unlinkSync(marker);
        throw Object.assign(new Error('journal temporarily unavailable'), { code: 'EIO' });
      }
      return create(value, file);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  command('node', `exec "${process.execPath}" --require "$HOME/fail-journal.cjs" "$@"`);
  command('sleep', 'if [ -f "$HOME/fail-journal" ]; then cp "$HOME/next" "$HOME/clock"; else cp "$HOME/later" "$HOME/clock"; fi');
  assert.equal(watch(BEDTIME, BEDTIME + 360, '240'), 'EVENT\n> WATCH-GAP 6m\n');
  assert.match(watch(BEDTIME + 480, BEDTIME + 600), /^HEARTBEAT/);
});

test('AC-3: clock rollback recovers a newly sampled earlier window before a later pending one', t => {
  const { home, program, watch, prompt, command } = gapFixture(t);
  blockRename(home, command, '/watch-gap');
  assert.match(watch(MORNING + 120, MORNING + 420), /^HEARTBEAT/);
  rmSync(join(home, 'block'));
  rmSync(join(program, 'watch-gap'), { recursive: true });
  writeFileSync(join(home, 'log'), [SLEEP, WAKE].join('\n'));
  assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> SLEPT 16h17m (sleep 17:09 CST, wake 09:26 CST)\n');
  assert.match(prompt()?.hookSpecificOutput?.additionalContext ?? '', /^Heads up:/);
  assert.equal(prompt(), null);
  assert.equal(watch(MORNING, MORNING + 120), 'EVENT\n> WATCH-GAP 5m\n');
});

test('AC-3: interruption after gap acknowledgment but before stdout leaves the exact window pending', t => {
  const { home, program, watch, command } = gapFixture(t);
  writeFileSync(join(home, 'interrupt'), '');
  // The final clock read follows the successful replacement and verification of watch-gap-ack.
  command('date', `if [ "$1" != "+%s" ]; then exec /bin/date "$@"; fi
if [ -f "$HOME/interrupt" ] && grep -qs '^watch-gap ' "$HOME/programs/active/watch-gap-ack"; then
  rm "$HOME/interrupt"; kill -TERM "$(cat "$HOME/programs/active/watch.lock/pid")"
fi
cat "$HOME/clock"`);
  assert.equal(watch(BEDTIME, MORNING, '120', 143), '');
  const identity = `watch-gap ${BEDTIME}-${MORNING} WATCH-GAP 16h17m`;
  const receipt = join(program, 'watch-gap-ack');
  assert.deepEqual(readFileSync(receipt, 'utf8').trimEnd().split('\n'), ['', identity]);
  assert.equal(watch(MORNING, MORNING + 120), 'EVENT\n> WATCH-GAP 16h17m\n');
  assert.deepEqual(readFileSync(receipt, 'utf8').trimEnd().split('\n'), ['', identity, identity]);
  assert.match(watch(MORNING + 120, MORNING + 240), /^HEARTBEAT/);
});

for (const signal of ['TERM', 'HUP', 'INT']) {
  test(`AC-3: a staged gap survives ${signal} at the event header and stdout-to-ack boundary`, t => {
    const { home, watch } = gapFixture(t);
    writeFileSync(join(home, '.zshenv'), `signal_watcher() {
      local watcher_pid=$(<"$HOME/programs/active/watch.lock/pid")
      [[ $watcher_pid == $$ && $watcher_pid -gt 1 ]] || return 1
      /bin/kill -s ${signal} "$watcher_pid"
    }
    echo() {
      builtin echo "$@" || return $?
      if [[ $1 == EVENT ]]; then builtin print header >> "$HOME/signals"; signal_watcher || return 1; fi
    }
    print() {
      builtin print "$@" || return $?
      if [[ $3 == '> WATCH-GAP '* ]]; then builtin print gap >> "$HOME/signals"; signal_watcher || return 1; fi
    }\n`);
    assert.equal(watch(BEDTIME, MORNING), 'EVENT\n> WATCH-GAP 16h17m\n');
    assert.equal(readFileSync(join(home, 'signals'), 'utf8'), 'header\ngap\n');
    rmSync(join(home, '.zshenv'));
    assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
  });
}

test('AC-3: a gap wakes once when file growth fails immediately after stdout', t => {
  const { home, watch } = gapFixture(t);
  // Let the real gap line reach stdout, then make subsequent regular-file growth fail in this arm.
  writeFileSync(join(home, '.zshenv'), `function print() {
    builtin print "$@" || return $?
    if [[ $1 == -r && $2 == -- && $3 == '> WATCH-GAP '* ]]; then
      trap '' XFSZ
      ulimit -f 0
    fi
  }\n`);
  const first = watch(BEDTIME, MORNING);
  assert.equal(first, 'EVENT\n> WATCH-GAP 16h17m\n');
  rmSync(join(home, '.zshenv'));
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
});

test('AC-3: the window stays retired when the post-output delivery rename fails', t => {
  const { home, watch } = gapFixture(t);
  writeFileSync(join(home, '.zshenv'), 'zf_mv() { return 1; }\n');
  const first = watch(BEDTIME, MORNING);
  assert.equal(first, 'EVENT\n> WATCH-GAP 16h17m\n');
  rmSync(join(home, '.zshenv'));
  assert.match(watch(MORNING, MORNING + 120), /^HEARTBEAT/);
});
