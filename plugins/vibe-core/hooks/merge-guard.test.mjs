import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mergeCalls, mergeGuard, mergeProblem } from "./merge-guard.mjs";
import { PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "pre-tool-use.mjs");

/** A gh stand-in: the signed-in login, and each PR number's author and branch. */
const fakeGh = (me, prs) => (args) => {
  if (args[0] === "api") return `${me}\n`;
  const pr = prs[args[2]?.startsWith("-") ? "current" : args[2]];
  return JSON.stringify({ author: { login: pr.author }, headRefName: pr.branch });
};

/**
 * A gh stand-in that resolves the repository as gh does: `-R` when given, else
 * the checkout the lookup runs in. `prs` is keyed `owner/repo#number`; every
 * pr view call is recorded in `views`.
 */
const repoGh = (me, checkouts, prs) => {
  const views = [];
  const gh = (args, { cwd } = {}) => {
    if (args[0] === "api") return `${me}\n`;
    const flag = args.indexOf("-R");
    const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(args[2]);
    const repo = url?.[1] ?? (flag >= 0 ? args[flag + 1] : checkouts[cwd]);
    const key = `${repo}#${url?.[2] ?? args[2]}`;
    views.push(key);
    const pr = prs[key];
    if (!pr) throw new Error(`no pull request ${key}`);
    return JSON.stringify({ author: { login: pr.author }, headRefName: pr.branch });
  };
  return { gh, views };
};

/** Two sibling checkouts whose PR 413 has different authors, as on 2026-11-09. */
function twoCheckouts(t) {
  const root = mkdtempSync(path.join(tmpdir(), "merge-guard-repos-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "symphony-alpha");
  const plugins = path.join(root, "claude-plugins");
  mkdirSync(app);
  mkdirSync(plugins);
  const { gh, views } = repoGh("operator", { [app]: "acme/app", [plugins]: "acme/plugins" }, {
    "acme/app#413": { author: "teammate", branch: "fetch-link-tree" },
    "acme/plugins#413": { author: "operator", branch: "fix/iss-13834" },
  });
  return { app, plugins, gh, views };
}

test("merging, enqueueing or arming auto-merge on another author's pull request is refused (#9169 was enqueued for its author)", (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), "merge-guard-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "wt"));
  const gh = fakeGh("operator", { 9169: { author: "teammate", branch: "fix/their-work" }, 9160: { author: "operator", branch: "vibe/bulk" }, current: { author: "operator", branch: "vibe/x" } });
  const problem = (command) => mergeProblem(command, gh, { cwd, environment: {} });
  assert.match(problem("gh pr merge 9169 --squash --auto -R acme/app"), /^pull request 9169 is teammate's \(branch fix\/their-work\), not operator's/);
  assert.match(problem("cd wt && gh pr merge --auto 9169"), /teammate's/);
  assert.equal(problem("gh pr merge 9160 --squash --auto"), null, "our own pull request");
  assert.equal(problem("gh pr merge --squash --auto"), null, "the current branch's own pull request");
  assert.equal(problem("MERGE_AUTHOR_OK=teammate gh pr merge 9169 --squash --auto"), null, "the operator approved it");
  assert.match(problem("MERGE_AUTHOR_OK=someone-else gh pr merge 9169 --auto"), /teammate's/);
  assert.equal(problem("gh pr view 9169 && git merge main"), null);
});

test("the repo and the target are read past value flags", () => {
  const pick = (calls) => calls.map(({ target, repo, allowed }) => ({ target, repo, allowed }));
  const options = { cwd: "/session", environment: {} };
  assert.deepEqual(pick(mergeCalls("gh pr merge -t 'title' --repo=acme/app 12 --auto", options)), [{ target: "12", repo: "acme/app", allowed: null }]);
  assert.deepEqual(pick(mergeCalls("gh pr merge --body-file b.md -R acme/app https://github.com/acme/app/pull/12", options)), [{ target: "https://github.com/acme/app/pull/12", repo: "acme/app", allowed: null }]);
  assert.deepEqual(pick(mergeCalls("gh pr merge -Racme/app 12", options)), [{ target: "12", repo: "acme/app", allowed: null }]);
  assert.deepEqual(pick(mergeCalls("gh -R acme/app pr merge 12", options)), [{ target: "12", repo: "acme/app", allowed: null }]);
  assert.deepEqual(mergeCalls("ssh host 'bash -lc \"gh pr merge 12 --auto\"'", options), [], "remote merges are not judged with local GitHub identity");
});

test("a leading cd decides the repository gh merges in, so the incident's own PR passes and another author's is refused (ISS-13886)", (t) => {
  const { app, plugins, gh, views } = twoCheckouts(t);
  const problem = (command, cwd = app) => mergeProblem(command, gh, { cwd, environment: {} });
  assert.equal(problem(`cd ${plugins} && gh pr merge 413 --squash --delete-branch`), null, "claude-plugins #413 is the operator's");
  assert.equal(problem(`cd ${plugins}; gh pr merge 413 --squash`), null);
  assert.equal(problem(`(cd ${plugins} && gh pr merge 413 --squash)`), null);
  assert.equal(problem(`env -C ${plugins} gh pr merge 413 --squash`), null, "a chdir prefix runs gh in that directory");
  assert.equal(problem(`env --chdir=${plugins} gh pr merge 413`), null);
  assert.equal(problem(`sudo -D ${plugins} gh pr merge 413`), null);
  assert.equal(problem(`pushd ${plugins} && gh pr merge 413`), null);
  assert.match(problem(`pushd ${plugins} && popd && gh pr merge 413`), /teammate's/);
  assert.match(problem(`cd ${app} && gh pr merge 413 --squash --auto`, plugins), /^pull request 413 is teammate's \(branch fetch-link-tree\)/, "the false pass: the session repo's #413 is the operator's");
  assert.match(problem(`cd ${app}; gh pr merge 413 --squash`, plugins), /teammate's/);
  assert.match(problem(`cd .. && cd ${path.basename(app)} && gh pr merge 413`, plugins), /teammate's/);
  assert.match(problem(`(cd ${plugins}); gh pr merge 413`), /teammate's/, "a subshell's cd does not move the parent shell");
  assert.deepEqual(views.slice(0, 2), ["acme/plugins#413", "acme/plugins#413"]);
});

test("an explicit -R wins over the directory and GH_REPO", (t) => {
  const { app, plugins, gh } = twoCheckouts(t);
  const problem = (command, environment = {}) => mergeProblem(command, gh, { cwd: app, environment });
  assert.equal(problem("gh pr merge 413 --squash -R acme/plugins"), null);
  assert.equal(problem("gh -R acme/plugins pr merge 413 --squash"), null);
  assert.match(problem(`cd ${plugins} && gh pr merge 413 --repo acme/app`), /teammate's/);
  assert.match(problem("gh pr merge 413 -R acme/app", { GH_REPO: "acme/plugins" }), /teammate's/);
  assert.match(problem("GH_REPO=acme/plugins gh pr merge 413 -R acme/app"), /teammate's/);
});

test("GH_REPO wins over the directory, from the session, an inline assignment or an export", (t) => {
  const { app, plugins, gh } = twoCheckouts(t);
  const problem = (command, environment = {}, cwd = app) => mergeProblem(command, gh, { cwd, environment });
  assert.equal(problem("gh pr merge 413 --squash", { GH_REPO: "acme/plugins" }), null);
  assert.match(problem("gh pr merge 413 --squash", { GH_REPO: "acme/app" }, plugins), /teammate's/);
  assert.match(problem("GH_REPO=acme/app gh pr merge 413", {}, plugins), /teammate's/);
  assert.equal(problem(`export GH_REPO=acme/plugins; cd ${app} && gh pr merge 413`), null);
  assert.match(problem(`export GH_REPO=acme/app && cd ${plugins} && gh pr merge 413`, {}, plugins), /teammate's/);
  assert.match(problem("GH_REPO=acme/plugins; gh pr merge 413"), /teammate's/, "an unexported shell variable never reaches gh");
  assert.equal(problem("GH_REPO=acme/plugins; export GH_REPO; gh pr merge 413"), null, "a bare export publishes the shell variable");
  assert.equal(problem("GH_REPO=acme/plugins; gh pr merge 413", { GH_REPO: "acme/other" }), null, "assigning an exported variable changes what gh sees");
  assert.match(problem("unset GH_REPO; gh pr merge 413", { GH_REPO: "acme/plugins" }), /teammate's/);
  assert.match(problem("GH_REPO= gh pr merge 413", { GH_REPO: "acme/plugins" }), /teammate's/, "an empty GH_REPO is unset");
});

test("a directory the guard cannot prove is refused with a request for -R, and gh is never asked", (t) => {
  const { app, plugins, gh, views } = twoCheckouts(t);
  const problem = (command, environment = {}) => mergeProblem(command, gh, { cwd: app, environment });
  for (const command of [
    'cd "$WT" && gh pr merge 413 --squash',
    'cd "$(git rev-parse --show-toplevel)" && gh pr merge 413',
    "cd `git rev-parse --show-toplevel`; gh pr merge 413",
    `cd ${plugins}/missing; gh pr merge 413`,
    `if [ -d ${plugins} ]; then cd ${plugins}; fi; gh pr merge 413`,
    'env -C "$WT" gh pr merge 413',
    `env -C ${plugins} bash -c 'gh pr merge 413'`,
    "cd ~/Source/claude-plugins && gh pr merge 413",
    "gh pr merge 413 -R $(echo acme/plugins)",
    "GH_REPO=$(echo acme/plugins) gh pr merge 413",
  ]) {
    assert.match(problem(command, { WT: plugins }) ?? "", /^gh pr merge 413 refused: cannot tell which repository .*; rerun with -R <owner\/repo>/, command);
  }
  assert.deepEqual(views, [], "no lookup ran against a guessed repository");
  assert.equal(problem(`WT=${plugins}; cd "$WT" && gh pr merge 413`), null, "a variable the command itself sets is known");
  assert.equal(problem('cd "$WT" && gh pr merge 413 -R acme/plugins'), null, "an explicit repository needs no directory");
  assert.equal(problem('cd "$WT" && gh pr merge 413', { GH_REPO: "acme/plugins" }), null);
  assert.equal(problem('cd "$WT" && gh pr merge https://github.com/acme/plugins/pull/413'), null, "a URL names its repository");
});

test("the hook denies through the PreToolUse contract and stays silent when gh cannot answer", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "merge-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = path.join(dir, "gh");
  writeFileSync(gh, '#!/usr/bin/env bash\nif [ "$1" = api ]; then echo operator; else echo \'{"author":{"login":"teammate"},"headRefName":"fix/x"}\'; fi\n', { mode: 0o755 });
  const run = (command, bin = gh) => spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", cwd: dir, tool_input: { command } }), encoding: "utf8", env: { ...process.env, MERGE_GUARD_GH: bin } });
  assert.equal(JSON.parse(run("gh pr merge 9169 --auto").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("git status").stdout, "");
  const broken = run("gh pr merge 9169 --auto", path.join(dir, "missing-gh"));
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, /^merge-guard: /);
  assert.ok(PRE_TOOL_USE_ROUTES.Bash.some((guard) => guard.run === mergeGuard), "the Bash guard is routed");
});

test("the hook looks the pull request up in the directory the command runs in, without the session's GH_REPO", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "merge-guard-hook-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, "session");
  const other = path.join(root, "other");
  mkdirSync(session);
  mkdirSync(other);
  const gh = path.join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash
if [ "$1" = api ]; then echo operator; exit 0; fi
if [ -n "$GH_REPO" ]; then echo "GH_REPO leaked" >&2; exit 1; fi
case " $* " in *" -R acme/other "*) echo '{"author":{"login":"teammate"},"headRefName":"fix/other"}'; exit 0;; esac
if [ "$(pwd -P)" = "${other}" ]; then echo '{"author":{"login":"teammate"},"headRefName":"fix/other"}'; else echo '{"author":{"login":"operator"},"headRefName":"vibe/mine"}'; fi
`, { mode: 0o755 });
  const run = (command, extra = {}) => {
    const env = { ...process.env, MERGE_GUARD_GH: gh, ...extra };
    if (!("GH_REPO" in extra)) delete env.GH_REPO;
    const result = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name: "Bash", cwd: session, tool_input: { command } }), encoding: "utf8", env });
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : result.stderr;
  };
  assert.equal(run("gh pr merge 7 --squash"), "", "the session checkout's own pull request");
  assert.equal(run(`cd ${other} && gh pr merge 7 --squash`).permissionDecision, "deny");
  assert.equal(run("gh pr merge 7 --squash", { GH_REPO: "acme/other" }).permissionDecision, "deny");
  assert.match(run('cd "$WT" && gh pr merge 7', { WT: other }).permissionDecisionReason, /rerun with -R <owner\/repo>/);
});
