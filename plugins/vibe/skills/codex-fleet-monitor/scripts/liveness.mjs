// Usage: node liveness.mjs <stateDir> <stateName>...
// Reads <stateDir>/<stateName>.json (an app-server-orchestrator state file with a threadId)
// and prints "<stateName> <lastTurnStatus> <itemCount> <flag>"; flag is LIMIT, ERROR, READFAIL or -.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

setTimeout(() => process.exit(1), 120_000).unref();

const clientPath =
  process.env.APP_SERVER_CLIENT ??
  `${homedir()}/.codex/skills/app-server-orchestrator/scripts/app-server-client.mjs`;
const { AppServerClient, initializeClient } = await import(clientPath);
const [dir, ...names] = process.argv.slice(2);
let socket = `${homedir()}/.codex/app-server-control/app-server-control.sock`;
try {
  const started = execFileSync('codex', ['app-server', 'daemon', 'start'], { encoding: 'utf8' });
  socket = JSON.parse(started).socketPath ?? socket;
} catch {}
const client = new AppServerClient({ transport: 'proxy', socket });
await initializeClient(client, { name: 'fleet-liveness', title: 'Fleet liveness', version: '1.0.0' });
for (const n of names) {
  try {
    const { threadId } = JSON.parse(readFileSync(`${dir}/${n}.json`, 'utf8'));
    const r = await client.request('thread/read', { threadId, includeTurns: true });
    const t = (r.thread?.turns ?? []).at(-1);
    const err = JSON.stringify(t?.error ?? '').toLowerCase();
    let flag = '-';
    if (/usage|limit|quota|rate/.test(err)) flag = 'LIMIT';
    else if (t?.error) flag = 'ERROR';
    console.log(`${n} ${t?.status ?? 'none'} ${(t?.items ?? []).length} ${flag}`);
  } catch {
    console.log(`${n} unreadable 0 READFAIL`);
  }
}
client.close();
process.exit(0);
