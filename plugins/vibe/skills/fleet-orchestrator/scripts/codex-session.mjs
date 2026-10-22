// Usage:
//   node codex-session.mjs turn  <stateDir> <name> --prompt-file <file> [--cwd <dir>] [--model <m>] [--effort <e>] [--sandbox <mode>]
//   node codex-session.mjs steer <stateDir> <name> --prompt-file <file>
//   node codex-session.mjs last  <stateDir> <name> [--count <n>]
// `turn` starts a thread bound to --cwd when <stateDir>/<name>.json does not exist (a new session also needs
// --effort and a prompt that starts with `$vibe`, since every writer is a vibe session), otherwise resumes the thread it names, then starts a turn with the prompt file's text. `steer` adds the prompt to the active turn.
// `last` prints the thread's status line and its last <n> agent messages (default 1).
// The state file is the one codex-fleet-monitor reads for a `local|remote <name>` session line.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  connectViaProxy, daemonSocket, exitAfterTotalTimeout, isEntryPoint, summarize,
} from '../../codex-fleet-monitor/scripts/liveness.mjs';

const COMMANDS = new Set(['turn', 'steer', 'last']);
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const SANDBOX_POLICIES = {
  'read-only': { type: 'readOnly' },
  'workspace-write': { type: 'workspaceWrite' },
  'danger-full-access': { type: 'dangerFullAccess' },
};
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const VIBE_PROMPT = /^\s*\$vibe\b/;

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'prompt-file': { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      sandbox: { type: 'string' },
      count: { type: 'string' },
    },
  });
  const [command, stateDir, name, ...extra] = positionals;
  if (!COMMANDS.has(command)) throw new Error(`command must be one of: ${[...COMMANDS].join(', ')}`);
  if (!stateDir || !name || extra.length) throw new Error('expected <stateDir> <name>');
  if (!NAME_PATTERN.test(name)) throw new Error('name must be letters, digits, dot, dash or underscore');
  if (command !== 'last' && !values['prompt-file']) throw new Error(`${command} needs --prompt-file`);
  if (command !== 'turn') {
    for (const key of ['cwd', 'model', 'effort', 'sandbox']) {
      if (values[key] !== undefined) throw new Error(`--${key} applies to turn only`);
    }
  }
  if (command !== 'last' && values.count !== undefined) throw new Error('--count applies to last only');
  if (values.effort !== undefined && !EFFORT_PATTERN.test(values.effort)) throw new Error('effort must be an identifier such as high');
  if (values.sandbox !== undefined && !SANDBOXES.has(values.sandbox)) throw new Error(`sandbox must be one of: ${[...SANDBOXES].join(', ')}`);
  const count = values.count === undefined ? 1 : Number(values.count);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer');
  return {
    command,
    stateDir,
    name,
    promptFile: values['prompt-file'],
    cwd: values.cwd === undefined ? undefined : resolve(values.cwd),
    model: values.model,
    effort: values.effort,
    sandbox: values.sandbox,
    count,
  };
}

export function statePath(stateDir, name) {
  return `${stateDir}/${name}.json`;
}

/** Returns the saved state, or null when the session has none yet. */
export function loadState(stateDir, name) {
  let text;
  try {
    text = readFileSync(statePath(stateDir, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(text);
  if (typeof state?.threadId !== 'string' || !state.threadId || typeof state.cwd !== 'string' || !state.cwd) {
    throw new Error(`${statePath(stateDir, name)} has no threadId and cwd`);
  }
  return state;
}

/** Write through a temp file and rename, so a crash never leaves the monitor a half-written state file. */
export function saveState(stateDir, name, state) {
  const target = statePath(stateDir, name);
  const temp = `${target}.${process.pid}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, target);
}

/**
 * Merges the options into the saved state for the next turn. A session stays bound to the worktree it
 * started in, so a different --cwd on an existing session is refused rather than silently moved.
 */
export function nextState(saved, options) {
  if (saved && options.cwd && options.cwd !== saved.cwd) {
    throw new Error(`session is bound to ${saved.cwd}; start a new session name for ${options.cwd}`);
  }
  if (!saved && !options.cwd) throw new Error('a new session needs --cwd');
  if (!saved && !options.effort) throw new Error('a new session needs --effort');
  return {
    threadId: saved?.threadId,
    cwd: saved?.cwd ?? options.cwd,
    model: options.model ?? saved?.model,
    effort: options.effort ?? saved?.effort,
    sandbox: options.sandbox ?? saved?.sandbox,
    turns: saved?.turns ?? [],
  };
}

function textInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/**
 * Starts or resumes the thread, then starts a turn. approvalPolicy is always `never`: this client
 * disconnects once the turn is accepted, so an approval request would have nobody to answer it.
 */
export async function startTurn(client, state, prompt, promptFile) {
  const threadOptions = defined({ cwd: state.cwd, model: state.model, sandbox: state.sandbox, approvalPolicy: 'never' });
  let { threadId } = state;
  if (threadId) await client.request('thread/resume', { threadId, ...threadOptions });
  else {
    const started = await client.request('thread/start', threadOptions);
    threadId = started?.thread?.id;
    if (!threadId) throw new Error('App Server returned no thread id');
  }
  const result = await client.request('turn/start', defined({
    threadId,
    input: textInput(prompt),
    cwd: state.cwd,
    model: state.model,
    effort: state.effort,
    sandboxPolicy: state.sandbox && SANDBOX_POLICIES[state.sandbox],
    approvalPolicy: 'never',
  }));
  const turnId = result?.turn?.id;
  if (!turnId) throw new Error('App Server returned no turn id');
  return { ...state, threadId, turns: [...state.turns, { turnId, kind: 'turn', promptFile }] };
}

export async function readThread(client, threadId) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: true });
  return thread;
}

export async function steerTurn(client, state, prompt, promptFile) {
  const turn = (await readThread(client, state.threadId))?.turns?.at(-1);
  if (turn?.status !== 'inProgress') throw new Error(`no active turn to steer (last turn is ${turn?.status ?? 'none'}); use turn`);
  const result = await client.request('turn/steer', { threadId: state.threadId, expectedTurnId: turn.id, input: textInput(prompt) });
  if (result?.turnId !== turn.id) throw new Error('App Server steered a different turn');
  return { ...state, turns: [...state.turns, { turnId: turn.id, kind: 'steer', promptFile }] };
}

/** The status line codex-fleet-monitor prints, then the last `count` agent messages, oldest first. */
export function lastMessages(name, thread, count) {
  const messages = (thread?.turns ?? [])
    .flatMap((turn) => (turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => ({ turn, item })))
    .slice(-count);
  return [
    summarize(name, thread),
    ...messages.map(({ turn, item }) => `--- turn ${turn.id} ${turn.status}\n${item.text ?? ''}`),
  ].join('\n');
}

export async function run(client, options) {
  const saved = loadState(options.stateDir, options.name);
  if (options.command === 'last') {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    return lastMessages(options.name, await readThread(client, saved.threadId), options.count);
  }
  const prompt = readFileSync(options.promptFile, 'utf8');
  if (!prompt.trim()) throw new Error(`${options.promptFile} is empty`);
  if (options.command === 'turn' && !saved && !VIBE_PROMPT.test(prompt)) {
    throw new Error(`a new session's prompt must start with $vibe; ${options.promptFile} does not`);
  }
  const promptFile = resolve(options.promptFile);
  let state;
  if (options.command === 'turn') state = await startTurn(client, nextState(saved, options), prompt, promptFile);
  else {
    if (!saved) throw new Error(`no session ${options.name} in ${options.stateDir}`);
    state = await steerTurn(client, saved, prompt, promptFile);
  }
  saveState(options.stateDir, options.name, state);
  const { turnId, kind } = state.turns.at(-1);
  return `${options.name} ${kind} ${state.threadId} ${turnId}`;
}

async function main() {
  exitAfterTotalTimeout();
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`codex-session: ${error.message}`);
    process.exit(2);
  }
  const client = connectViaProxy(daemonSocket());
  let code = 0;
  try {
    await client.initialize();
    console.log(await run(client, options));
  } catch (error) {
    console.error(`codex-session: ${error.message}`);
    code = 1;
  }
  client.close();
  process.exit(code);
}

if (isEntryPoint(import.meta.url)) await main();
