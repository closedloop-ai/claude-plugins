import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Cases run outside any chat (no harness ids) with a private HOME, so the chat bindings fleet-home.mjs writes
// never reach the real ~/.vibe-hook-scope; a case that tests a chat passes its id in `env`.
export const TEST_HOME = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-home-user-')));
process.on('exit', () => rmSync(TEST_HOME, { recursive: true, force: true }));
export const outsideChat = (env) => {
  const base = { ...process.env, HOME: TEST_HOME };
  Reflect.deleteProperty(base, 'CLAUDE_CODE_SESSION_ID');
  Reflect.deleteProperty(base, 'CODEX_THREAD_ID');
  Reflect.deleteProperty(base, 'FLEET_HOME');
  return { ...base, ...env };
};
export const run = (args, env = {}) => spawnSync(process.execPath, [path.join(HERE, 'fleet-home.mjs'), ...args], { encoding: 'utf8', env: outsideChat(env) });
export const tempRoot = (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fleet-home-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

export const chatEnv = (chat) => ({ CLAUDE_CODE_SESSION_ID: chat });
