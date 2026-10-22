#!/usr/bin/env node

import {
  AppServerClient,
  initializeClient,
  readThreadState,
  sendInput,
} from './native-app-server-client.mjs';

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

/** Parse the legacy notifier CLI while delegating all App Server mechanics. */
export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--socket') values.socket = argv[++index];
    else if (argument === '--thread-id') values.threadId = argv[++index];
    else if (argument === '--cwd') values.cwd = argv[++index];
    else if (argument === '--probe-only') values.probeOnly = true;
    else if (argument === '--wait-seconds') values.waitSeconds = Number(argv[++index]);
    else if (argument === '--transport') values.transport = argv[++index];
    else if (argument === '--codex') values.codex = argv[++index];
    else fail(`Unknown App Server notification argument: ${argument}`, 2);
  }
  for (const key of ['socket', 'threadId']) {
    if (!values[key]) fail(`Missing App Server notification argument: --${key}`, 2);
  }
  values.transport ||= 'proxy';
  if (!new Set(['proxy', 'desktop', 'direct']).has(values.transport)) {
    fail('--transport must be proxy, direct, or desktop', 2);
  }
  if (values.transport === 'proxy' && !values.codex) values.codex = 'codex';
  if (!values.probeOnly && !values.cwd) fail('Missing App Server notification argument: --cwd', 2);
  values.waitSeconds = Number.isFinite(values.waitSeconds) ? values.waitSeconds : 30;
  return values;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Preserve the monitor's prompt API while using the generic state-aware sender. */
export async function deliverPrompt(client, options, prompt, retryDelayMs = 100) {
  return sendInput(client, options, [{ type: 'text', text: prompt }], retryDelayMs);
}

/** Execute the legacy notifier command through the generic App Server client. */
export async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const prompt = options.probeOnly ? '' : await readStdin();
  if (!options.probeOnly && !prompt.trim()) fail('The App Server notification received an empty prompt', 2);
  const client = new AppServerClient({
    transport: options.transport,
    codex: options.codex,
    socket: options.socket,
    requestPrefix: 'gh-monitor-pr',
  });
  try {
    await initializeClient(client, {
      name: 'gh_monitor_pr',
      title: 'GitHub PR Monitor',
      version: '5.0.0',
    });
    if (options.probeOnly) {
      const threadState = await readThreadState(client, options.threadId);
      return {
        result: 'probed',
        transport: options.transport,
        threadStatus: threadState.status,
        activeTurnId: threadState.activeTurnId,
      };
    }
    const accepted = await deliverPrompt(client, options, prompt);
    return { ...accepted, transport: options.transport };
  } finally {
    client.close();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`App Server notification failed: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
