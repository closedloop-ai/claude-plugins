#!/usr/bin/env node
// Private register of the user's session-level directives for one sweep root.
// It lives beside scope-exclusions.json, is mode 0600, fails closed when
// malformed, and is rendered verbatim into every worker launch and resume.
// The root runs `sweep-root-state.mjs assert-owner` before `add` or `remove`.
//
// Usage:
//   standing-orders.mjs render --root <rootPath>
//   standing-orders.mjs add --root <rootPath> --sweep-id <id> --project-id <id> --order <text> --user-words <text>
//   standing-orders.mjs remove --root <rootPath> --id <n> --user-words <text>

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'CL_SWEEP_STANDING_ORDERS v1';
export const FILE_NAME = 'standing-orders.json';

const ORDER_KEYS = ['id', 'order', 'userWords', 'addedAt'];
const REMOVED_KEYS = ['id', 'order', 'removedAt', 'removedBecause'];

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

const text = (value) => typeof value === 'string' && value.trim().length > 0;

export function validate(register) {
  const valid = exactKeys(register, ['schema', 'sweepId', 'projectId', 'orders', 'removed'])
    && register.schema === SCHEMA
    && text(register.sweepId) && text(register.projectId)
    && Array.isArray(register.orders) && Array.isArray(register.removed)
    && register.orders.every((order) => exactKeys(order, ORDER_KEYS) && Number.isInteger(order.id) && order.id > 0
      && text(order.order) && text(order.userWords) && !Number.isNaN(Date.parse(order.addedAt)))
    && register.removed.every((order) => exactKeys(order, REMOVED_KEYS) && Number.isInteger(order.id)
      && text(order.order) && text(order.removedBecause) && !Number.isNaN(Date.parse(order.removedAt)))
    && new Set([...register.orders, ...register.removed].map((order) => order.id)).size
      === register.orders.length + register.removed.length;
  if (!valid) fail('Invalid standing orders register');
  return register;
}

export function load(root) {
  const path = join(root, FILE_NAME);
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) fail(`Standing orders register must be mode 0600, found ${mode.toString(8)}: ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`Invalid standing orders register: ${path}`);
  }
  return validate(parsed);
}

function save(root, register) {
  validate(register);
  const path = join(root, FILE_NAME);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(register, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return register;
}

export function render(register) {
  if (!register || register.orders.length === 0) return 'Operator standing orders for this sweep: none.';
  const lines = register.orders.map((order) => `${order.id}. ${order.order} (user, ${order.addedAt.slice(0, 10)}: "${order.userWords}")`);
  return [
    'Operator standing orders for this sweep. They bind this worker; only a newer explicit user instruction changes one:',
    ...lines,
  ].join('\n');
}

export function addOrder(root, { sweepId, projectId, order, userWords, now = new Date() }) {
  if (!text(order) || !text(userWords)) fail('--order and --user-words are required');
  const register = load(root) ?? { schema: SCHEMA, sweepId, projectId, orders: [], removed: [] };
  if (register.sweepId !== sweepId || register.projectId !== projectId) fail('Register belongs to a different sweep or project');
  const nextId = Math.max(0, ...register.orders.map((o) => o.id), ...register.removed.map((o) => o.id)) + 1;
  register.orders.push({ id: nextId, order: order.trim(), userWords: userWords.trim(), addedAt: now.toISOString() });
  return save(root, register);
}

export function removeOrder(root, { id, userWords, now = new Date() }) {
  if (!text(userWords)) fail('--user-words naming the newer user instruction is required');
  const register = load(root);
  if (!register) fail('No standing orders register exists');
  const index = register.orders.findIndex((order) => order.id === id);
  if (index < 0) fail(`No active standing order ${id}`);
  const [removed] = register.orders.splice(index, 1);
  register.removed.push({ id: removed.id, order: removed.order, removedAt: now.toISOString(), removedBecause: userWords.trim() });
  return save(root, register);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`Invalid argument near ${key ?? '<end>'}`);
    args[key.slice(2)] = value;
  }
  if (!args.root) fail('--root is required');
  return args;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.command === 'render') process.stdout.write(`${render(load(args.root))}\n`);
    else if (args.command === 'add') {
      const register = addOrder(args.root, { sweepId: args['sweep-id'], projectId: args['project-id'], order: args.order, userWords: args['user-words'] });
      process.stdout.write(`${JSON.stringify({ added: register.orders.at(-1).id, active: register.orders.length })}\n`);
    } else if (args.command === 'remove') {
      const register = removeOrder(args.root, { id: Number(args.id), userWords: args['user-words'] });
      process.stdout.write(`${JSON.stringify({ removed: Number(args.id), active: register.orders.length })}\n`);
    } else fail(`Unknown command ${args.command ?? '<none>'}`);
    return 0;
  } catch (error) {
    process.stderr.write(`standing-orders: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
