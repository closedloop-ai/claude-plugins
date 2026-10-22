import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dispositionProblems, findingProblems } from './finding-brief.mjs';

const SCRIPT = fileURLToPath(new URL('./finding-brief.mjs', import.meta.url));
const FLEET = fileURLToPath(new URL('./fleet.sh', import.meta.url));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'finding-brief-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const orch = join(root, 'orch');
  mkdirSync(join(orch, 'prompts'), { recursive: true });
  writeFileSync(join(orch, 'config.env'), `REMOTE_HOST=box\nREMOTE_STATE_DIR=${root}/remote/sessions\nREMOTE_SHELL="bash -c"\n`);
  const shot = join(root, 'f7-drag.png');
  writeFileSync(shot, 'png');
  return { root, orch, shot };
}

test('a finding without a story or route, a viewport, or a selector or screenshot is refused', () => {
  assert.deepEqual(findingProblems([{ id: 'F1', summary: 'chip clipped' }], () => true), [
    'F1: no story id or route', 'F1: no viewport', 'F1: no selector or screenshot', 'F1: touchedSurface must say true or false',
  ]);
  assert.deepEqual(findingProblems([{ id: 'F2', summary: 's', route: '/board', viewport: '390x844', screenshots: ['gone.png'], touchedSurface: true }], () => false),
    ['F2: screenshot gone.png does not exist here']);
  assert.deepEqual(findingProblems([]), ['no findings']);
  assert.deepEqual(findingProblems([{ id: 'F3', summary: 's', story: 'board--drag', viewport: '1280x800', selector: '[data-row]', touchedSurface: true }]), []);
});

test('a remote brief copies the screenshots beside the prompt, names them at the remote path, and fleet.sh ships them', { timeout: 20_000 }, (t) => {
  const f = fixture(t);
  const findings = join(f.root, 'findings.json');
  writeFileSync(findings, JSON.stringify({ head: 'abc', findings: [{ id: 'F7', summary: 'drag chip renders a full-row copy', story: 'tree-grid--drag', viewport: '1440x900', screenshots: [f.shot], touchedSurface: true }] }));
  const prompt = join(f.orch, 'prompts', 'w2-03-findings.md');
  writeFileSync(join(f.orch, 'rulings.md'), '- Ruling 2026-10-21 (ticket: source-1): keep the prototype order\n');
  const built = spawnSync(process.execPath, [SCRIPT, f.orch, '--findings', findings, '--prompt', prompt, '--where', 'remote'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr + built.stdout);
  const shipped = join(f.root, 'remote', 'sessions', '.fleet-orchestrator');
  const text = readFileSync(prompt, 'utf8');
  assert.match(text, /^F7: drag chip renders a full-row copy$/m);
  assert.match(text, /^- Story: tree-grid--drag$/m);
  assert.ok(text.includes(`- Screenshot: ${join(shipped, 'w2-03-findings.md.evidence', 'F7-f7-drag.png')}`));

  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash\ncase "$1" in *work-dir.mjs) exec ${JSON.stringify(process.execPath)} "$@";; esac\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  const sent = spawnSync('bash', [FLEET, f.orch, 'remote', 'session', 'turn', 'w2', '--prompt-file', prompt, '--cwd', '/wt'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_EFFORT: 'high' },
  });
  assert.equal(sent.status, 0, sent.stderr);
  assert.ok(existsSync(join(shipped, 'w2-03-findings.md.evidence', 'F7-f7-drag.png')), 'the screenshot is where the prompt says');
  assert.ok(existsSync(join(shipped, 'rulings.md')), 'program rulings are mirrored with every remote prompt');
});

test('the command writes nothing when a finding is refused', (t) => {
  const f = fixture(t);
  const findings = join(f.root, 'findings.json');
  writeFileSync(findings, JSON.stringify({ findings: [{ id: 'F1', summary: 'prose only' }] }));
  const prompt = join(f.orch, 'prompts', 'w2-04.md');
  const refused = spawnSync(process.execPath, [SCRIPT, f.orch, '--findings', findings, '--prompt', prompt], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /F1: no story id or route/);
  assert.equal(existsSync(prompt), false);
});

test('a VQA finding on a touched surface blocks closeout without a fix or ticket', () => {
  const base = { id: 'X001', summary: 'avatar overlap', touchedSurface: true };
  assert.deepEqual(dispositionProblems([base]), [
    'X001: a finding on a touched surface needs disposition "fixed: <sha>" or "ticket: <id>"',
  ]);
  assert.deepEqual(dispositionProblems([{ ...base, disposition: 'fixed: deadbee' }]), []);
  assert.deepEqual(dispositionProblems([{ ...base, disposition: 'ticket: XY-1' }]), []);
  assert.deepEqual(dispositionProblems([{ ...base, touchedSurface: false }]), []);
  assert.deepEqual(dispositionProblems([{ id: 'X002' }]), ['X002: touchedSurface must say true or false']);
});
