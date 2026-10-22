import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blockGaps, mockBlocks } from './mock-gap.mjs';

const SCRIPT = fileURLToPath(new URL('./mock-gap.mjs', import.meta.url));
// A mixed file: one block spreads the real module, the use-users hook mock does not and lacks userKeys.
const MIXED = [
  "vi.mock('@app/api-client', async (importOriginal) => ({ ...(await importOriginal()), fetchUsers: vi.fn() }));",
  "",
  "vi.mock('@app/use-users', () => ({",
  "  useUsers: () => ({ users: [] }),",
  "}));",
  "",
].join('\n');

test("each mock block is judged on its own, so another block's importOriginal does not cover a gap", () => {
  const blocks = mockBlocks(MIXED, '@app/use-users');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].line, 3);
  assert.deepEqual(blockGaps(blocks[0].body, ['useUsers', 'userKeys']), ['userKeys']);
  assert.deepEqual(blockGaps(mockBlocks(MIXED, '@app/api-client')[0].body, ['fetchUsers', 'other']), [], 'a spread of the real module covers every export');
  const named = "vi.mock('@app/use-users', async (importOriginal) => {\n  const actual = await importOriginal();\n  return { ...actual, useUsers: vi.fn() };\n});";
  assert.deepEqual(blockGaps(mockBlocks(named, '@app/use-users')[0].body, ['userKeys']), []);
});

test('the command reports the failing block with its line', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mock-gap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'list.test.tsx');
  writeFileSync(file, MIXED);
  const result = spawnSync(process.execPath, [SCRIPT, '--module', '@app/use-users', '--exports', 'useUsers,userKeys', file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, `MOCK-GAP ${file}:3 @app/use-users lacks userKeys\n`);
  writeFileSync(file, MIXED.replace('useUsers: () => ({ users: [] }),', 'useUsers: () => ({ users: [] }),\n  userKeys: { all: [] },'));
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--module', '@app/use-users', '--exports', 'useUsers,userKeys', file], { encoding: 'utf8' }).status, 0);
});
