import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { credentialProblem, e2eSlotProblem, equalsWordProblem, forcePushProblem, heavySlotProblem, shellSafetyGuard, watcherLaunchProblem,
  wordSplitProblem } from "./shell-safety-guard.mjs";
import { activatedChat } from "./activation-test-support.mjs";
import { recordWorkerScope } from "../lib/vibe/scripts/worker-scope.mjs";

// The ClosedLoop provider's slot rule, as a chat it is bound to reads it.
const SLOT_RULE = JSON.parse(readFileSync(new URL("../../vibe-closedloop-provider/provider.json", import.meta.url), "utf8")).data.guards.e2eSlot;
const slotProblem = (command) => e2eSlotProblem(command, SLOT_RULE);

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

test("the PreToolUse hook denies unsafe Bash and is registered", (t) => {
  const chat = activatedChat(t);
  const run = (command) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(chat.payload({ tool_name: "Bash", tool_input: { command } })), encoding: "utf8", env: chat.env,
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
    assert.match(slotProblem(command) ?? "", /--head <sha>/, command);
  }
  assert.equal(slotProblem('~/vibe-remote/e2e-slot.sh --head 0123abc ISS-1 pnpm prepush --all'), null);
  assert.equal(slotProblem('~/vibe-remote/e2e-slot.sh --head 0123abc --native-desktop ISS-1 pnpm prepush --all'), null);
  assert.match(slotProblem('~/vibe-remote/e2e-slot.sh --head 0123abc ISS-1 --native-desktop pnpm prepush --all') ?? '', /before the owner label/);
  assert.match(slotProblem(`~/vibe-remote/e2e-slot.sh --head 0123abc --source-hash ${'a'.repeat(64)} ISS-1 run`) ?? '', /does not accept --source-hash/);
  assert.ok(slotProblem(`e2e-slot.sh ISS-1 run --head 0123abc`), 'identity flags passed to the child command do not bind the wrapper');
  assert.equal(slotProblem('cat ~/vibe-remote/e2e-slot.sh'), null);
  assert.equal(slotProblem("cat <<'EOF'\ne2e-slot.sh ISS-1 run\nEOF"), null,
    'heredoc body is not an E2E slot invocation');
  assert.match(slotProblem("cat <<EOF\n$(e2e-slot.sh ISS-1 run)\nEOF") ?? '', /--head/,
    'an unquoted heredoc still executes command substitutions');
  for (const command of ["# <<EOF\ne2e-slot.sh ISS-1 run",
    "echo $((1 << 2)); e2e-slot.sh ISS-1 run", "e2e-slot.sh</dev/null ISS-1 run"]) {
    assert.match(slotProblem(command) ?? '', /--head/, command);
  }
  for (const command of ["cat <<\\EOF\ne2e-slot.sh ISS-1 run\nEOF",
    "cat <<E\"OF\"\ne2e-slot.sh ISS-1 run\nEOF"]) {
    assert.equal(slotProblem(command), null, command);
  }
  const message = slotProblem('e2e-slot.sh ISS-1 run');
  assert.doesNotMatch(message, /pushed|before the push/);
});

test("ISS-14193 queued E2E script files are inspected and direct execution needs mode plus shebang", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-slot-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "queued.sh");
  writeFileSync(script, "#!/bin/sh\ne2e-slot.sh --head 0123abc --native-desktop ISS-1 pnpm test:e2e\n", { mode: 0o600 });
  assert.match(slotProblem(script) ?? "", /not executable with a shebang/);
  assert.equal(slotProblem(`bash ${script}`), null, "an explicit interpreter does not require executable mode");
  chmodSync(script, 0o700);
  assert.equal(slotProblem(script), null);
  writeFileSync(script, "#!/bin/sh\ne2e-slot.sh --native-desktop --head 0123abc ISS-1 pnpm test:e2e\n", { mode: 0o700 });
  assert.match(slotProblem(script) ?? "", /--head <sha>/);
});

test('nested remote shell options cannot bypass E2E identity', () => {
  const prefix = "ssh host 'zsh -lic \"~/vibe-remote/e2e-slot.sh";
  assert.match(slotProblem(`${prefix} ISS-1 run\"'`) ?? '', /--head/);
  const flags = `--head 0123abc`;
  for (const command of [`${prefix} ${flags} ISS-1 run\"'`,
    String.raw`ssh -p 2222 host 'bash -l -c "zsh -o errexit -lic \"~/vibe-remote/e2e-slot.sh ${flags} ISS-1 run\""'`]) {
    assert.equal(slotProblem(command), null, command);
  }
  // ISS-13701 AC-4: zsh -c executes one command-string argument. A later --head becomes $0,
  // not the slot's flag (https://zsh.sourceforge.io/Doc/Release/Invocation.html).
  const unquoted = `ssh -p 2222 host 'bash -l -c "zsh -o errexit -lic ~/vibe-remote/e2e-slot.sh ${flags} ISS-1 run"'`;
  assert.match(slotProblem(unquoted) ?? '', /--head <sha>/);
  assert.equal(slotProblem("printf '%s\\n' 'zsh -lic e2e-slot.sh ISS-1 run'"), null, 'quoted data is not an invocation');
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
    assert.match(slotProblem(form('ISS-1 run')) ?? '', /--head/, form('ISS-1 run'));
    assert.equal(slotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  assert.equal(slotProblem(`printf '%s\\n' 'KEY=value env exec ${slot} ISS-1 run'`), null);
  for (const data of [`note; ${slot} ISS-1 run`, `note && ${slot} ISS-1 run`, `note $( ${slot} ISS-1 run )`]) {
    assert.equal(slotProblem(`printf '%s\\n' '${data}'`), null, 'quoted operators remain data');
  }
  for (const form of [
    suffix => `KEY="two; words" ${slot} ${suffix}`,
    suffix => `ssh host 'zsh -lic "KEY=\\"two && words\\" ${slot} ${suffix}"'`,
    suffix => `KEY+=value ${slot} ${suffix}`,
  ]) {
    assert.match(slotProblem(form('ISS-1 run')) ?? '', /--head/);
    assert.equal(slotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  for (const form of [
    suffix => `result="$(${slot} ${suffix})"`,
    suffix => `echo "\`${slot} ${suffix}\`"`,
  ]) {
    assert.match(slotProblem(form('ISS-1 run')) ?? '', /--head/, 'double-quoted substitutions execute');
    assert.equal(slotProblem(form('--head 0123abc ISS-1 run')), null);
  }
  assert.equal(slotProblem(`printf '%s\\n' '$(${slot} ISS-1 run)' '\`${slot} ISS-1 run\``), null, 'single-quoted substitutions are data');
  for (const suffix of [`${slot} ISS-1 run`, `${slot} --head 0123abc ISS-1 run`]) {
    assert.equal(slotProblem(`printf '%s\\n' "$(echo safe) ${suffix}"`), null, 'literal suffix after substitution stays data');
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


test("with no provider bound there is no slot rule, so the wrapper's name means nothing", () => {
  assert.equal(e2eSlotProblem("e2e-slot.sh ISS-1 run", null), null);
  assert.equal(e2eSlotProblem("e2e-slot.sh ISS-1 run", undefined), null);
  assert.equal(heavySlotProblem("heavy-slot.sh ISS-1 run", null), null);
  assert.equal(heavySlotProblem("heavy-slot.sh ISS-1 run", undefined), null);
});

// A directory outside any vibe session, so a run from inside a session worktree never reads that session's binding.
const NEUTRAL_CWD = mkdtempSync(path.join(os.tmpdir(), "vibe-guard-cwd-"));

/** The guard's reason for `command` in a chat with no provider bound and no launcher record, or null. */
const guardReason = (command, event = {}) => shellSafetyGuard({ cwd: NEUTRAL_CWD, ...event, tool_input: { command } })?.reason ?? null;

/** Runs pre-tool-use.mjs for `command` in `chat` (as session `session`, when given); returns its hookSpecificOutput, or null. */
function runHook(chat, command, session) {
  const event = chat.payload({ ...(session ? { session_id: session } : {}), tool_name: "Bash", tool_input: { command } });
  const result = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(event), encoding: "utf8", env: chat.env, cwd: NEUTRAL_CWD });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput ?? null : null;
}

/** Points HOME at a fresh home for test `t`, restored after it, where session "vibe-launcher-worker" is a launcher worker. */
function launcherWorkerHome(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "vibe-worker-home-"));
  const previous = process.env.HOME;
  t.after(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  recordWorkerScope("vibe-launcher-worker", "/w", home);
}

test("git hook bypasses are refused: a failing hook means the commit is not ready (proof commit with --no-verify, ISS-14227)", () => {
  const refused = [
    "git commit --no-verify -m proof",
    "git commit -n -m proof",
    "git commit -anm proof",
    "git commit -nm proof",
    "git commit -am proof -n",
    "git commit -m\"proof\" -n",
    "git commit --no-verif -m proof",
    "git commit --amend --no-edit --no-verify",
    "git -C repo commit --no-verify -m proof",
    "git -c user.name=x --git-dir .git --work-tree . commit -n -m proof",
    "git --git-dir=.git --namespace ns commit --no-verify",
    "cd wt && git add -A && git commit --no-verify -m proof",
    "ssh host 'zsh -lic \"cd ~/wt && git -C r commit --no-verify -m proof\"'",
    "bash -lc 'git am -n patch.mbox'",
    "git am --no-verify patch.mbox",
    "git am -3n patch.mbox",
    "git merge --no-verify main",
    "git pull --no-verify origin main",
    "git push --no-verify origin HEAD",
    "git rebase --no-verify main",
    "git -c core.hooksPath=/dev/null commit -m proof",
    "git -c CORE.HOOKSPATH=/dev/null push origin HEAD",
    "git -c core.hooksPath status",
    "git --config-env=core.hooksPath=EMPTY commit -m proof",
    "git --config-env core.HooksPath=EMPTY merge main",
  ];
  for (const command of refused) assert.match(guardReason(command) ?? "", /failing hook means the commit is not ready/, command);
  const allowed = [
    "git commit -m proof",
    "git commit -m -n",
    "git commit -mn",
    "git commit -F -n",
    "git commit --message --no-verify",
    "git commit -m 'skip --no-verify'",
    "git commit --verify -m proof",
    "git commit -- -n",
    "git am -C -n patch.mbox",
    "git push -n origin HEAD",
    "git merge -n main",
    "git merge --no-verify-signatures main",
    "git rebase -n main",
    "git pull -n origin main",
    "git cherry-pick -n abc1234",
    "git -c core.editor=true commit -m proof",
    "git -C -n status",
    "echo 'git commit --no-verify'",
    "printf '%s\\n' 'git -c core.hooksPath=/dev/null commit'",
  ];
  for (const command of allowed) assert.equal(guardReason(command), null, command);
});

test("combined short force flags and git global options cannot hide a force push", () => {
  const refused = [
    "git push -uf origin fix/work",
    "git push -fu origin fix/work",
    "git push -vf origin fix/work",
    "git -C repo push -uf origin fix/work",
    "git --git-dir=.git -c push.default=current push --force",
    "git -c user.name=x push -qf scratch HEAD:proof/abc-1",
    "ssh host 'zsh -lic \"git -C wt push -uf origin fix/work\"'",
    "git push --force-if-includes --force-with-lease=fix/work origin fix/work",
    "ssh primary bash -s <<'EOF'\ngit push -f origin fix/work\nEOF",
  ];
  for (const command of refused) assert.match(forcePushProblem(command) ?? "", /force.push/i, command);
  for (const command of ["git push -u origin fix/work", "git push -n origin fix/work", "git push -o ci.skip origin fix/work",
    "git -C repo push origin HEAD:proof/abc-2", "git push --no-force origin fix/work"]) {
    assert.equal(forcePushProblem(command), null, command);
  }
});

test("a launcher worker deletes only exact paths: glob and brace deletes are refused, exact ones are not (ISS-14228)", (t) => {
  launcherWorkerHome(t);
  const worker = (command) => guardReason(command, { session_id: "vibe-launcher-worker" });
  const refused = [
    "rm -f /tmp/vibe-14191/e2e3.*",
    "rm -f /tmp/vibe-14191/frozen2.*",
    "rm -rf /tmp/vibe-14191/e2e3.{sh,json}",
    "rm -f /tmp/vibe-14191/e2e{1..3}.log",
    "rm /tmp/vibe-14191/e2e?.sh",
    "rm /tmp/vibe-14191/e2e[0-9].sh",
    "rm -rf \"$dir\"/*",
    "cd /tmp/vibe-14191 && rm -f e2e3.*",
    "unlink /tmp/vibe-14191/e2e3.*",
    "find /tmp/vibe-14191 -name 'e2e3.*' -delete",
    "find /tmp/vibe-14191 -maxdepth 1 -name 'e2e3.*' -exec rm -f {} +",
    "find /tmp/vibe-14191/e2e3.* -delete",
    "ssh host 'rm -f /tmp/vibe-14191/e2e3.*'",
    "ssh host rm -f \"/tmp/vibe-14191/e2e3.*\"",
    "zsh -lic 'rm -f /tmp/vibe-14191/e2e3.*'",
  ];
  for (const command of refused) assert.match(worker(command) ?? "", /deletes only exact paths it created, in its own per-worker directory/, command);
  const allowed = [
    "rm -f /tmp/vibe-14191/e2e3.sh /tmp/vibe-14191/e2e3.pid",
    "rm -rf \"$dir\"",
    "rm -rf \"${dir:?}\"",
    "rm -rf ${dir:?}",
    "rm -f '/tmp/vibe-14191/e2e3.*'",
    "ls /tmp/vibe-14191/e2e3.*",
    "find /tmp/vibe-14191 -name 'e2e3.*'",
    "find /tmp/vibe-14191 -name e2e3.sh -delete",
    "find /tmp/vibe-14191/e2e3 -exec rm -f {} +",
  ];
  for (const command of allowed) assert.equal(worker(command), null, command);
  assert.equal(guardReason("rm -f /tmp/vibe-14191/e2e3.*", { session_id: "orchestrator-chat" }), null, "only a launcher worker is held to exact paths");
});

test("a launcher worker may remove its own per-worker directory, or exact files in it, by exact path (ISS-14228)", (t) => {
  launcherWorkerHome(t);
  const worker = (command) => guardReason(command, { session_id: "vibe-launcher-worker" });
  const own = "/tmp/vibe-14191/workers/verify-e2e3";
  for (const command of [`rm -rf ${own}`, `rm -rf ${own}/`, `rm -f ${own}/e2e3.sh ${own}/e2e3.status`, `find ${own} -delete`,
    `ssh host 'rm -rf ${own}'`]) {
    assert.equal(worker(command), null, command);
  }
  assert.match(worker(`rm -f ${own}/*`) ?? "", /exact paths/, "a glob is refused even in its own directory");
});

test("through the hook, the ISS-14191 delete is refused in a launcher worker, so the orchestrator's e2e3.json beside the worker's e2e3.sh survives", (t) => {
  const chat = activatedChat(t);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "vibe-14228-scratch-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  recordWorkerScope("vibe-launcher-worker", scratch, chat.home);
  const orchestratorFiles = ["e2e3.json", "e2e3.out.json"].map((name) => path.join(scratch, name));
  const workerFile = path.join(scratch, "e2e3.sh");
  for (const file of [...orchestratorFiles, workerFile]) writeFileSync(file, "{}\n");
  // The harness runs a command only when the hook does not deny it.
  const attempt = (command) => {
    const output = runHook(chat, command, "vibe-launcher-worker");
    if (output?.permissionDecision !== "deny") assert.equal(spawnSync("/bin/sh", ["-c", command]).status, 0, command);
    return output;
  };
  const refused = attempt(`rm -f ${scratch}/e2e3.*`);
  for (const file of [...orchestratorFiles, workerFile]) assert.ok(existsSync(file), `${file} survives the refused glob`);
  assert.equal(refused?.permissionDecision, "deny");
  assert.match(refused.permissionDecisionReason, /exact paths it created/);
  assert.equal(attempt(`rm -f ${workerFile}`), null, "the exact path the worker created is allowed");
  assert.equal(existsSync(workerFile), false);
  for (const file of orchestratorFiles) assert.ok(existsSync(file), `${file} survives the exact delete`);
});

test("a bound provider's ungated heavy slot wrapper is refused, ssh payloads included; with no provider bound nothing is (ISS-14225)", (t) => {
  const bound = activatedChat(t, process.env, { provider: true });
  const refused = [
    "~/vibe-remote/heavy-slot.sh ISS-1 pnpm typecheck",
    "ssh host 'zsh -lic \"cd ~/Source/wt && ~/vibe-remote/heavy-slot.sh ISS-1 pnpm typecheck\"'",
    "bash ~/vibe-remote/heavy-slot.sh ISS-1 pnpm test",
    "HEAVY_SLOTS=3 heavy-slot.sh ISS-1 pnpm lint",
    "cd ~/wt && env FOO=1 ~/vibe-remote/heavy-slot.sh ISS-1 pnpm verify",
  ];
  for (const command of refused) {
    const output = runHook(bound, command);
    assert.equal(output?.permissionDecision, "deny", command);
    assert.match(output.permissionDecisionReason, /heavy-slot\.sh.*no load check.*fleet\.sh <orchDir> local\|remote slot heavy/, command);
  }
  for (const command of ["cat ~/vibe-remote/heavy-slot.sh", "scripts/fleet.sh orch remote slot heavy ISS-1 ~/wt pnpm typecheck"]) {
    assert.notEqual(runHook(bound, command)?.permissionDecision, "deny", command);
  }
  const unbound = activatedChat(t);
  assert.notEqual(runHook(unbound, refused[0])?.permissionDecision, "deny", "with no provider rule the script name means nothing");
});
