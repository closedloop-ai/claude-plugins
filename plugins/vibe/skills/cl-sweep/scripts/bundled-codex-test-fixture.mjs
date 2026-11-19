// Loaded into the test process and, through NODE_OPTIONS --import, into every Node process it starts
// (core-client-fixture.mjs). resolve-core-skill.mjs falls back to the bundled Codex app when the PATH codex fails;
// here that app never exists, so no test spawns it, whether or not this machine has it.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { BUNDLED_CODEX } from '../../vibe/scripts/plugin-cli.mjs';

/** The marker on the wrapped `existsSync`, holding the path it hides, so a test can check a process loaded this file. */
export const HIDDEN_BUNDLED_CODEX = Symbol.for('cl-sweep.hiddenBundledCodex');

/** `existsSync` with `hidden` reported missing; every other path is answered by `existsSync`. */
export function hidingExistsSync(existsSync, hidden) {
  const wrapped = (file) => file !== hidden && existsSync(file);
  wrapped[HIDDEN_BUNDLED_CODEX] = hidden;
  return wrapped;
}

if (fs.existsSync[HIDDEN_BUNDLED_CODEX] !== BUNDLED_CODEX) {
  fs.existsSync = hidingExistsSync(fs.existsSync, BUNDLED_CODEX);
  syncBuiltinESMExports();
}
