import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT = fileURLToPath(new URL('./snapshot.sh', import.meta.url));

// A fake gh: answers each call snapshot.sh makes while <root>/gh-mode says ok, prints nothing and fails otherwise.
const FAKE_GH = `#!/bin/sh
[ "$(cat "$FAKE_ROOT/gh-mode")" = ok ] || exit 1
case "$*" in
  "api user"*) echo me ;;
  "api graphql"*) cat "$FAKE_ROOT/threads" 2>/dev/null || echo 0 ;;
  "pr list"*--author*) cat "$FAKE_ROOT/mine" 2>/dev/null ;;
  "pr list"*) printf '5\\n7\\n' ;;
  "pr view"*isDraft*) cat "$FAKE_ROOT/push-$3" 2>/dev/null || cat "$FAKE_ROOT/push" 2>/dev/null || echo "false $(date -u +%Y-%m-%dT%H:%M:%SZ)" ;;
  "pr view"*) cat "$FAKE_ROOT/view-$3" 2>/dev/null || cat "$FAKE_ROOT/view" 2>/dev/null || echo "OPEN abcdef12 APPROVED MERGEABLE" ;;
  "pr checks"*) printf 'build\\tpass\\t1m\\nlint\\tpass\\t1m\\n' ;;
  *"/issues/"*) echo 2 ;;
  *"/reviews"*) echo 1 ;;
  *"/comments"*) echo 3 ;;
  *) exit 1 ;;
esac
`;

/** Provide fake host tools and an isolated fleet for the real snapshot shell tests. */
export function snapshotFixture({ fleetHome = false, inspect } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fleet-snapshot-'));
  const bin = join(root, 'bin');
  // The board writes only to a program in a fleet home (fleet-home.mjs), so a case that drives it uses one.
  const work = fleetHome ? join(root, 'home', 'programs', 'p1') : join(root, 'work');
  mkdirSync(bin);
  mkdirSync(work, { recursive: true });
  if (fleetHome) writeFileSync(join(root, 'home', 'current'), 'p1\n');
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  // No App Server here: codex fails, so the usage line reads READFAIL on every run.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat "${root}/claude-usage" 2>/dev/null || exit 1\n`);
  for (const name of ['gh', 'codex', 'claude']) chmodSync(join(bin, name), 0o755);
  writeFileSync(join(work, 'config.env'), 'WATCH_NEW_PR_REPOS="acme/app"\n');
  writeFileSync(join(work, 'prs.txt'), 'acme/app 42\n');
  const env = { ...process.env, FAKE_ROOT: root, PATH: `${bin}:${process.env.PATH}`, FLEET_SUPERVISOR_LOCK: join(root, 'supervisor.lock') };
  const run = (mode) => {
    writeFileSync(join(root, 'gh-mode'), mode);
    const result = spawnSync('zsh', [SNAPSHOT, work], { env, encoding: 'utf8', timeout: 50_000 });
    inspect(result);
    return result.stdout;
  };
  return { root, work, run };
}
