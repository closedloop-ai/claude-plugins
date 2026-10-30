import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { credentialProblem, e2eSlotProblem, equalsWordProblem, forcePushProblem, shellSafetyGuard, watcherLaunchProblem, wordSplitProblem } from "./shell-safety-guard.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");

test("credential workarounds are refused at the first auth failure", () => {
  const refused = [
    "GH_TOKEN=$token DOCKER_CONFIG=$(mktemp -d) docker pull ghcr.io/acme/app:sha",
    "printf '%s' \"$GH_TOKEN\" | docker login ghcr.io -u operator --password-stdin",
    "echo '{\"auths\":{\"ghcr.io\":{\"auth\":\"'$TOKEN'\"}}}' > /tmp/config.json",
    "ssh primary 'DOCKER_CONFIG=/tmp/evidence GITHUB_TOKEN=$GITHUB_TOKEN docker pull ghcr.io/acme/app:sha'",
  ];
  for (const command of refused) assert.match(credentialProblem(command) ?? "", /credential/i, command);
  for (const command of ["gh run view 123 --log", "gh api repos/acme/app/actions/runs/123", "docker pull alpine:latest", "DOCKER_CONFIG=/tmp/test docker version"]) {
    assert.equal(credentialProblem(command), null, command);
  }
});

test("force push is refused for every remote, including a remote laptop and proof refs", () => {
  const refused = [
    "git push -f origin fix/work",
    "git push --force-with-lease fork HEAD:fix/work",
    "ssh primary 'git -C repo push --force local HEAD:proof/abc-1'",
    "git push scratch +HEAD:refs/heads/proof/abc-1",
  ];
  for (const command of refused) assert.match(forcePushProblem(command) ?? "", /force.push/i, command);
  assert.equal(forcePushProblem("git push primary HEAD:proof/abc-2"), null);
  assert.equal(forcePushProblem("git push origin fix/work"), null);
});

test("the PreToolUse hook denies unsafe Bash and is registered", () => {
  const run = (command) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), encoding: "utf8",
  });
  for (const command of ["GH_TOKEN=$token DOCKER_CONFIG=/tmp/x docker pull ghcr.io/acme/app:sha", "git push -f primary HEAD:proof/a-1"]) {
    const result = run(command);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  }
  assert.equal(run("gh run view 123 --log").stdout, "");
  assert.ok(PRE_TOOL_USE_ROUTES.Bash.some((guard) => guard.run === shellSafetyGuard), "the Bash guard is routed");
});

test("the fleet watcher starts only as its own background call (started with & twice, 2026-10-24)", () => {
  const refused = [
    { command: "zsh plugins/vibe/skills/codex-fleet-monitor/scripts/watch.sh orch 120 &", run_in_background: false },
    { command: "cd orch && scripts/watch.sh orch", run_in_background: true },
    { command: "scripts/watch.sh orch; echo done", run_in_background: true },
    { command: "scripts/watch.sh orch" },
  ];
  for (const input of refused) assert.match(watcherLaunchProblem(input) ?? "", /run_in_background/, input.command);
  for (const input of [{ command: "zsh scripts/watch.sh orch 120", run_in_background: true },
    { command: "scripts/watch.sh orch 2>&1", run_in_background: true }, { command: "cat scripts/watch.sh" }]) {
    assert.equal(watcherLaunchProblem(input), null, input.command);
  }
});

test("set -- $var is refused because zsh does not split it (the merge watcher never fired, 2026-10-23)", () => {
  assert.match(wordSplitProblem("st=$(gh pr view 1 --json state,headRefOid -q '.state+\" \"+.headRefOid'); set -- $st; [ \"$1\" = MERGED ]") ?? "", /read -r/);
  for (const command of ["read -r state sha <<< \"$st\"", "set -- \"$st\"", "set -- ${=st}", "set -e"]) assert.equal(wordSplitProblem(command), null, command);
});

test("e2e-slot.sh uses the deployed wrapper's --head, owner, command interface", () => {
  for (const command of ["~/vibe-remote/e2e-slot.sh ISS-1 pnpm e2e", "ssh host 'zsh -lic \"cd ~/wt && ~/vibe-remote/e2e-slot.sh ISS-1 e2e/run.sh\"'",
    "zsh e2e-slot.sh --head HEAD ISS-1 run"]) {
    assert.match(e2eSlotProblem(command) ?? "", /--head <sha>/, command);
  }
  assert.equal(e2eSlotProblem('~/vibe-remote/e2e-slot.sh --head 0123abc ISS-1 pnpm prepush --all'), null);
  assert.match(e2eSlotProblem(`~/vibe-remote/e2e-slot.sh --head 0123abc --source-hash ${'a'.repeat(64)} ISS-1 run`) ?? '', /does not accept --source-hash/);
  assert.ok(e2eSlotProblem(`e2e-slot.sh ISS-1 run --head 0123abc`), 'identity flags passed to the child command do not bind the wrapper');
  assert.equal(e2eSlotProblem('cat ~/vibe-remote/e2e-slot.sh'), null);
  const message = e2eSlotProblem('e2e-slot.sh ISS-1 run');
  assert.doesNotMatch(message, /pushed|before the push/);
});

test('nested remote shell options cannot bypass E2E identity', () => {
  const prefix = "ssh host 'zsh -lic \"~/vibe-remote/e2e-slot.sh";
  assert.match(e2eSlotProblem(`${prefix} ISS-1 run\"'`) ?? '', /--head/);
  const flags = `--head 0123abc`;
  for (const command of [`${prefix} ${flags} ISS-1 run\"'`,
    `ssh -p 2222 host 'bash -l -c "zsh -o errexit -lic ~/vibe-remote/e2e-slot.sh ${flags} ISS-1 run"'`]) {
    assert.equal(e2eSlotProblem(command), null, command);
  }
  assert.equal(e2eSlotProblem("printf '%s\\n' 'zsh -lic e2e-slot.sh ISS-1 run'"), null, 'quoted data is not an invocation');
  assert.equal(watcherLaunchProblem({ command: "ssh host 'zsh -lic \"scripts/watch.sh orch\"'" }), null, 'only the e2e identity guard expands remote shell payloads');
});

test('assignments and executable wrappers cannot hide the E2E slot', () => {
  const slot = '~/vibe-remote/e2e-slot.sh';
  const forms = [
    suffix => `KEY=value ${slot} ${suffix}`,
    suffix => `zsh -lic "KEY=value ${slot} ${suffix}"`,
    suffix => `ssh host 'zsh -lic "KEY=value ${slot} ${suffix}"'`,
    suffix => `ssh host 'zsh -lic "env KEY=value ${slot} ${suffix}"'`,
    suffix => `ssh host 'zsh -lic "exec ${slot} ${suffix}"'`,
    suffix => `zsh -lic "env KEY=value command exec nohup ${slot} ${suffix}"`,
    suffix => `zsh -lic "env -i -- KEY=value command -- ${slot} ${suffix}"`,
    suffix => `zsh -lic "env --unset=OLD_KEY KEY=value exec -a slot ${slot} ${suffix}"`,
    suffix => `zsh -lic 'KEY="two words" ${slot} ${suffix}'`,
    suffix => `ssh host 'zsh -lic "KEY=\\"two words\\" ${slot} ${suffix}"'`,
    suffix => `zsh -lic "KEY+=value ${slot} ${suffix}"`,
    suffix => `zsh -lic "env --split-string='${slot} ${suffix}'"`,
    suffix => `zsh -lic "sudo --user=root ${slot} ${suffix}"`,
    suffix => `zsh -lic "builtin time ${slot} ${suffix}"`,
  ];
  for (const form of forms) {
    assert.match(e2eSlotProblem(form('ISS-1 run')) ?? '', /--head/, form('ISS-1 run'));
    assert.equal(e2eSlotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  assert.equal(e2eSlotProblem(`printf '%s\\n' 'KEY=value env exec ${slot} ISS-1 run'`), null);
  for (const data of [`note; ${slot} ISS-1 run`, `note && ${slot} ISS-1 run`, `note $( ${slot} ISS-1 run )`]) {
    assert.equal(e2eSlotProblem(`printf '%s\\n' '${data}'`), null, 'quoted operators remain data');
  }
  for (const form of [
    suffix => `KEY="two; words" ${slot} ${suffix}`,
    suffix => `ssh host 'zsh -lic "KEY=\\"two && words\\" ${slot} ${suffix}"'`,
    suffix => `KEY+=value ${slot} ${suffix}`,
  ]) {
    assert.match(e2eSlotProblem(form('ISS-1 run')) ?? '', /--head/);
    assert.equal(e2eSlotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  for (const form of [
    suffix => `result="$(${slot} ${suffix})"`,
    suffix => `echo "\`${slot} ${suffix}\`"`,
  ]) {
    assert.match(e2eSlotProblem(form('ISS-1 run')) ?? '', /--head/, 'double-quoted substitutions execute');
    assert.equal(e2eSlotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  assert.equal(e2eSlotProblem(`printf '%s\\n' '$(${slot} ISS-1 run)' '\`${slot} ISS-1 run\``), null, 'single-quoted substitutions are data');
  for (const suffix of [`${slot} ISS-1 run`, `${slot} --head 0123abc ISS-1 run`]) {
    assert.equal(e2eSlotProblem(`printf '%s\\n' "$(echo safe) ${suffix}"`), null, 'literal suffix after substitution stays data');
  }
});

test("an unquoted word starting with = is refused, because zsh aborts the whole list on it (echo ==== hid two reads, 2026-10-22)", () => {
  const refused = [
    "git diff a b -- x | head -70; echo ====; git log --oneline -- .claude/skills; echo ====; sed -n 1,30p AGENTS.md",
    "echo ==== && ls",
    "[ \"$a\" == b ] && echo same",
    "echo =foo",
    "printf '%s\\n' x; print -r -- ====",
    "x==1",
  ];
  for (const command of refused) assert.match(equalsWordProblem(command) ?? "", /quote/, command);
  const allowed = [
    "echo '===='", "echo \"====\"", "echo \\====", "echo =", "[ \"$a\" = b ]", "[[ $a == b ]] && echo same",
    "echo a=b", "git log --format=%H -1", "echo --x==y", "cat <<'EOF'\n====\nEOF", "awk -F= '{print $1}' f",
    "jq '.a == 1' f.json", "test \"$a\" != b",
  ];
  for (const command of allowed) assert.equal(equalsWordProblem(command), null, command);
  assert.equal(shellSafetyGuard({ tool_input: { command: "echo ====; cat AGENTS.md" } })?.decision, "deny");
});
