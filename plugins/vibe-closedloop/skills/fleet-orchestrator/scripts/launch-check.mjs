#!/usr/bin/env node
// Usage:
//   node launch-check.mjs codex <stateDir> <name> [--within <seconds>] [--interval <seconds>] [--settings <file>]...
//   node launch-check.mjs pane --capture <shell command printing the session's screen> [--within <s>] [--interval <s>] [--settings <file>]...
//   node launch-check.mjs gui-hooks [--settings <file>]...
// Run on the host the session runs on. A session started on another host once sat 14 minutes on its first tool
// call, "running PreToolUse hooks 3/4": a user-level hook called osascript, which never answers outside the
// logged-in desktop session, and nothing noticed.
// `codex` reads the writer's saved thread; `pane` re-reads a terminal session's screen (a tmux pane), and a failed
// read means the session is gone. Each waits up to --within seconds (default 60) for the first tool call to finish
// and prints one line: `LAUNCH ok ...` (exit 0), or `LAUNCH STUCK|NO-TOOL-CALL|GONE ...` (exit 1) naming the
// hooks that need a GUI session registered for the waiting event.
// `gui-hooks` lists each user-level hook whose command, or the script it runs, calls osascript, iTerm or
// AppleScript without an ITERM_SESSION_ID guard (`GUI-HOOK ...`, exit 1), else prints `gui-hooks ok`. It never
// changes a settings file. The defaults are ~/.claude/settings.json and ~/.codex/hooks.json, when present.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { vibeCore } from '../../../shared/vibe-core.mjs';
import { isEntryPoint } from '../../../shared/plugin-roots.mjs';

const { connectViaProxy, daemonSocket } = await vibeCore('lib/codex-fleet-monitor/scripts/liveness.mjs');

const DEFAULT_WITHIN_SECONDS = 60;
const DEFAULT_INTERVAL_SECONDS = 5;
const HOOK_WAIT = /running\s+(\w*ToolUse)\s+hooks?\b(?:[^\n]*?(\d+)\s*\/\s*(\d+))?/i;
// Claude Code prints a finished tool call's result under it, after this glyph.
const TOOL_RESULT = /^\s*⎿/m;
const GUI_NEED = /\bosascript\b|\biterm|\bapplescript\b/i;
// A test of the variable, not a mere use of it: `[ -n "$ITERM_SESSION_ID" ]`, `test -z ...`, `${ITERM_SESSION_ID:?}`.
const GUI_GUARD = /(?:\[\[?|\btest)\s+-[nz]\s+"?\$\{?ITERM_SESSION_ID|\$\{ITERM_SESSION_ID:\?/;
const TOOL_EVENT = /ToolUse$/;
// The App Server's status-bearing tool items and their end states (`codex app-server generate-ts`, v2/ThreadItem.ts).
const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall']);
const FINISHED = new Set(['completed', 'failed', 'declined', 'interrupted']);
const ENDED_TURNS = new Set(['completed', 'failed', 'interrupted']);
const WORD = /'([^']*)'|"([^"]*)"|(\S+)/g;
const HOME_PREFIX = /^(?:~|\$HOME)(?=\/)/;
// Interpreters such as node carry these words in their own binary.
const SCRIPT_BYTES = 512 * 1024;
const UNKNOWN_METHOD = /unknown variant|method not found/i;

export const LaunchState = Object.freeze({
  ToolDone: 'tool-done', ToolRunning: 'tool-running', HookWait: 'hook-wait', Waiting: 'waiting', TurnEnded: 'turn-ended', Gone: 'gone',
});

/** What a terminal session's screen says about its first tool call; a hook still running wins over an older result. */
export function classifyScreen(text) {
  const wait = HOOK_WAIT.exec(text);
  if (wait) return { state: LaunchState.HookWait, event: wait[1], progress: wait[2] ? `${wait[2]}/${wait[3]}` : '?' };
  return { state: TOOL_RESULT.test(text) ? LaunchState.ToolDone : LaunchState.Waiting };
}

/** What a Codex thread says about its first tool call. */
export function classifyThread(thread) {
  const turns = thread?.turns ?? [];
  const tools = turns.flatMap((turn) => turn.items ?? [])
    .filter((item) => TOOL_ITEMS.has(item?.type));
  if (tools.some((item) => FINISHED.has(item.status))) return { state: LaunchState.ToolDone };
  if (tools.length) return { state: LaunchState.ToolRunning, tool: tools[0].type };
  if (ENDED_TURNS.has(turns.at(-1)?.status)) return { state: LaunchState.TurnEnded, status: turns.at(-1).status };
  return { state: LaunchState.Waiting };
}

/** Polls `read` until the first tool call finishes or `within` seconds pass; a throwing read means the session is gone. */
export async function watchLaunch(read, { within = DEFAULT_WITHIN_SECONDS, interval = DEFAULT_INTERVAL_SECONDS,
  now = Date.now, sleep = (seconds) => delay(seconds * 1000) } = {}) {
  const started = now();
  for (;;) {
    let seen;
    try { seen = await read(); } catch (error) { return { state: LaunchState.Gone, reason: error.message, seconds: elapsed(started, now) }; }
    if (seen.state === LaunchState.ToolDone || seen.state === LaunchState.TurnEnded) return { ...seen, seconds: elapsed(started, now) };
    if (elapsed(started, now) >= within) return { ...seen, seconds: elapsed(started, now) };
    await sleep(interval);
  }
}

/** User-level hooks that need a GUI session, from Claude or Codex hook settings; `guarded` when they test ITERM_SESSION_ID. */
export function guiHooks(settings, { file = 'settings', readScript = readScriptText } = {}) {
  const found = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command !== 'string') continue;
        const script = readScript(hook.command);
        const text = `${hook.command}\n${script}`;
        if (GUI_NEED.test(text)) found.push({ event, file, command: hook.command, guarded: GUI_GUARD.test(text) });
      }
    }
  }
  return found;
}

/** The one line a finished watch prints, with the GUI-needing hooks registered for the event it waits on. */
export function launchLine(result, hooks) {
  const after = `after ${result.seconds}s`;
  if (result.state === LaunchState.ToolDone) return `LAUNCH ok first tool call finished ${after}`;
  if (result.state === LaunchState.TurnEnded) return `LAUNCH ok turn ${result.status} with no tool call ${after}`;
  if (result.state === LaunchState.Gone) return `LAUNCH GONE ${after}: ${result.reason}`;
  const events = result.event ? [result.event] : [...new Set(hooks.map((hook) => hook.event))].filter((event) => TOOL_EVENT.test(event));
  const named = hooks.filter((hook) => events.includes(hook.event));
  const suspects = named.length
    ? named.map((hook) => `${hook.event} ${JSON.stringify(hook.command)}${hook.guarded ? ' (guarded)' : ''}`).join('; ')
    : 'no GUI-session hook found in the scanned settings';
  if (result.state === LaunchState.HookWait) return `LAUNCH STUCK running ${result.event} hooks ${result.progress} ${after}; GUI-session hooks: ${suspects}`;
  if (result.state === LaunchState.ToolRunning) return `LAUNCH STUCK first tool call (${result.tool}) still running ${after}; GUI-session hooks: ${suspects}`;
  return `LAUNCH NO-TOOL-CALL ${after}; GUI-session hooks: ${suspects}`;
}

export function defaultSettingsFiles(home = homedir()) {
  return [path.join(home, '.claude', 'settings.json'), path.join(home, '.codex', 'hooks.json')];
}

export function scanSettings(files) {
  return files.filter((file) => existsSync(file)).flatMap((file) => guiHooks(JSON.parse(readFileSync(file, 'utf8')), { file }));
}

function elapsed(started, now) {
  return Math.round((now() - started) / 1000);
}

/** The text of every file a hook command names (`bash ~/x.sh`, `node x.mjs`); an interpreter binary is over the size cap. */
function readScriptText(command) {
  const texts = [];
  for (const match of command.matchAll(WORD)) {
    const word = (match[1] ?? match[2] ?? match[3]).replace(HOME_PREFIX, homedir());
    try {
      if (!word.includes('/') || !statSync(word).isFile() || statSync(word).size > SCRIPT_BYTES) continue;
      texts.push(readFileSync(word, 'utf8'));
    } catch { /* not a readable file */ }
  }
  return texts.join('\n');
}

/** The newest turn and its newest items, as codex-fleet-monitor reads them, never the thread's whole history. */
async function readNewestTurn(client, threadId) {
  let turns;
  try {
    turns = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  } catch (error) {
    if (!UNKNOWN_METHOD.test(error.message)) throw error;
    return (await client.request('thread/read', { threadId, includeTurns: true })).thread;
  }
  const turn = turns?.data?.[0];
  if (!turn) return { turns: [] };
  const items = await client.request('thread/items/list', { threadId, turnId: turn.id, limit: 50, sortDirection: 'desc' });
  return { turns: [{ ...turn, items: (items?.data ?? []).map((entry) => entry.item) }] };
}

function readPane(command) {
  const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`screen read failed (exit ${result.status ?? result.signal}): ${(result.stderr ?? '').trim()}`);
  return classifyScreen(result.stdout);
}

async function codexReader(stateDir, name) {
  const { threadId } = JSON.parse(readFileSync(path.join(stateDir, `${name}.json`), 'utf8'));
  const client = connectViaProxy(daemonSocket());
  await client.initialize();
  const read = async () => classifyThread(await readNewestTurn(client, threadId));
  return { read, close: () => client.close() };
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    within: { type: 'string' }, interval: { type: 'string' }, capture: { type: 'string' }, settings: { type: 'string', multiple: true },
  } });
  const [mode, ...rest] = positionals;
  const files = values.settings ?? defaultSettingsFiles();
  if (mode === 'gui-hooks' && rest.length === 0) {
    const hooks = scanSettings(files);
    const open = hooks.filter((hook) => !hook.guarded);
    for (const hook of open) console.log(`GUI-HOOK ${hook.event} ${hook.file}: ${hook.command}`);
    if (!open.length) console.log(`gui-hooks ok (${hooks.length} guarded)`);
    return open.length ? 1 : 0;
  }
  const within = Number(values.within ?? DEFAULT_WITHIN_SECONDS);
  const interval = Number(values.interval ?? DEFAULT_INTERVAL_SECONDS);
  if (!(within > 0) || !(interval > 0)) throw new Error('--within and --interval must be positive seconds');
  let reader;
  if (mode === 'pane' && rest.length === 0 && values.capture) reader = { read: async () => readPane(values.capture), close() {} };
  else if (mode === 'codex' && rest.length === 2) reader = await codexReader(rest[0], rest[1]);
  else {
    process.stderr.write(`${readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 4).map((line) => line.slice(3)).join('\n')}\n`);
    return 2;
  }
  try {
    const result = await watchLaunch(reader.read, { within, interval });
    const line = launchLine(result, scanSettings(files));
    console.log(line);
    return line.startsWith('LAUNCH ok') ? 0 : 1;
  } finally {
    reader.close();
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`launch-check: ${error.message}\n`);
    process.exit(2);
  });
}
