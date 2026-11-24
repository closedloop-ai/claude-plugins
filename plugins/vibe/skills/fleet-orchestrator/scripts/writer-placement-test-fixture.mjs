import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.mjs');
export const CODE_ONLY = { codeOnly: true, needsRunningApp: false, localEvidence: [] };
export const NEEDS_APP = { codeOnly: true, needsRunningApp: true, localEvidence: [] };

/** Build an isolated program and drive its real placement CLI with inert inputs. */
export const fixture = (t, operatorRuling) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'fleet-placement-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'programs', 'p1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, 'current'), 'p1\n');
  const evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'fleet-placement-evidence-'));
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }));
  const source = (ticket) => `2026-11-19 (AskUserQuestion: ${ticket} operator placement)`;
  const writeRuling = (ticket, quote) => writeFileSync(path.join(dir, 'rulings.md'), `- Ruling ${source(ticket)}: "${quote}"\n`);
  if (operatorRuling) writeRuling(operatorRuling.ticket, operatorRuling.quote);
  const run = (...args) => {
    const [command, ticket, option, quote] = args;
    const fixtureMatches = command === 'placement' && ticket === operatorRuling?.ticket
      && option === '--keep-local' && quote === operatorRuling?.quote && args.length === 4;
    const argv = fixtureMatches ? [...args, '--ruling-source', source(ticket)] : args;
    return spawnSync(process.execPath, [BOARD, dir, ...argv], { encoding: 'utf8' });
  };
  const evidence = (name, body) => {
    const file = path.join(evidenceDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(body));
    return file;
  };
  const keep = (ticket, quote) => {
    writeRuling(ticket, quote);
    return run('placement', ticket, '--keep-local', quote, '--ruling-source', source(ticket));
  };
  return { dir, run, evidence, keep, page: () => readFileSync(path.join(dir, 'board.md'), 'utf8') };
};
