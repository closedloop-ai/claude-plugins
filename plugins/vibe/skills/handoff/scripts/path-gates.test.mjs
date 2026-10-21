import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PATH_GATES_FILE, pathGateTests } from './path-gates.mjs';

const declared = (gates) => (file) => (file === PATH_GATES_FILE ? JSON.stringify({ gates }) : null);
const CATALOG = { name: 'catalog-imports', paths: ['apps/prototypes/**'], command: 'node apps/prototypes/scripts/check-catalog-imports.mjs' };

test('a change under a declared path requires a passing run of the gate command', () => {
  const required = pathGateTests([{ path: 'apps/prototypes/src/branches/page.tsx' }], declared([CATALOG]));
  assert.deepEqual(required.map((entry) => entry.path), [CATALOG.command]);
  assert.match(required[0].reason, /catalog-imports in \.vibe\/path-gates\.json: apps\/prototypes\/src\/branches\/page\.tsx changed/);
});

test('a change outside every declared path, or a repo with no declaration, requires nothing', () => {
  assert.deepEqual(pathGateTests([{ path: 'apps/app/page.tsx' }], declared([CATALOG])), []);
  assert.deepEqual(pathGateTests([{ path: 'apps/prototypes/x.tsx' }], () => null), []);
});

test('prefixes and single-segment globs match only what they name', () => {
  const gates = [
    { name: 'prefix', paths: ['packages/db'], command: 'db-gate' },
    { name: 'one', paths: ['e2e/*.spec.ts'], command: 'spec-gate' },
  ];
  assert.deepEqual(pathGateTests([{ path: 'packages/db/schema.sql' }], declared(gates)).map((entry) => entry.path), ['db-gate']);
  assert.deepEqual(pathGateTests([{ path: 'packages/dbx/a.ts' }], declared(gates)), []);
  assert.deepEqual(pathGateTests([{ path: 'e2e/a.spec.ts' }], declared(gates)).map((entry) => entry.path), ['spec-gate']);
  assert.deepEqual(pathGateTests([{ path: 'e2e/nested/a.spec.ts' }], declared(gates)), []);
});

test('a broken declaration is itself a required fix, never silently ignored', () => {
  assert.match(pathGateTests([{ path: 'a' }], () => '{nope')[0].reason, /could not be parsed/);
  assert.match(pathGateTests([{ path: 'a' }], () => '{}')[0].reason, /no gates list/);
  assert.match(pathGateTests([{ path: 'a' }], declared([{ name: 'x', paths: ['a'] }]))[0].reason, /needs a command/);
});
