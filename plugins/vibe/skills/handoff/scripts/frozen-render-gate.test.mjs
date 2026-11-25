import { tmpdir } from "node:os";
import { bindChat } from "../../../lib/fleet-orchestrator/scripts/chat-binding.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runDiffRules, storyId } from "./diff-rules.mjs";
import { frozenHeavySlots, frozenInputs, frozenRenders, frozenStoryFiles, selectFrozenStoryFiles } from "./frozen-render.mjs";
import { frozenGate, GateExit } from "./frozen-render-gate.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot } from "./frozen-render-test-fixture.mjs";
import { isFrozenStory, run } from "./diff-rules-test-fixture.mjs";
import { bindProviderInProcess, git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const fixture = bindProviderInProcess(after);
const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "frozen-render-gate.mjs");

const FIRST = "apps/storybook/stories/first.stories.tsx";
const SECOND = "apps/storybook/stories/second.stories.tsx";
const COMPONENT = "packages/design-system/components/first.tsx";
const BASE_FILES = {
  [FIRST]: 'import { First } from "@repo/design-system/components/first";\nexport default { title: "Composites v1.0/First", tags: ["v1.0"] };\nexport const Default = {};\nexport const Open = {};\n',
  [SECOND]: 'export default { title: "Composites v1.0/Second", tags: ["v1.0"] };\nexport const Default = {};\n',
  [COMPONENT]: "export const First = 1;\n",
  "apps/storybook/stories/current.stories.tsx": 'import { First } from "@repo/design-system/components/first";\nexport default { title: "Composites/Current" };\nexport const Default = {};\n',
};

test("selection matches the diff rules' frozen-render finding: closure hits only, renames counted, nothing for an unrelated change", (t) => {
  const finding = (result) => result.blocking.find((entry) => entry.rule === "frozen-render");
  const component = run(t, { base: BASE_FILES, head: { [COMPONENT]: "export const First = 2;\n" } });
  assert.deepEqual(selectFrozenStoryFiles(component.checkout, component.baseSha), [FIRST]);
  assert.match(finding(component).problem, /1 frozen v1\.0 story files .*first\.stories\.tsx$/);
  const unrelated = run(t, { base: BASE_FILES, head: { "docs/readme.md": "changed\n" } });
  assert.deepEqual(selectFrozenStoryFiles(unrelated.checkout, unrelated.baseSha), []);
  assert.equal(finding(unrelated), undefined);
  const global = run(t, { base: BASE_FILES, head: { "apps/storybook/.storybook/preview-head.html": "<style></style>\n" } });
  assert.deepEqual(selectFrozenStoryFiles(global.checkout, global.baseSha).sort(), [FIRST, SECOND]);
  // A committed rename moves the imported file out from under the story: only its old path is in the story's closure.
  const renamed = run(t, { base: BASE_FILES, commit: true,
    head: { [COMPONENT]: null, "packages/design-system/components/first-renamed.tsx": "export const First = 1;\n" } });
  assert.match(git(renamed.checkout, ["diff", "--name-status", "-M", renamed.baseSha], fixture.home), /^R100/m, "git reports a rename");
  assert.deepEqual(selectFrozenStoryFiles(renamed.checkout, renamed.baseSha), [FIRST]);
  assert.ok(finding(renamed));
  assert.equal(isFrozenStory(BASE_FILES[FIRST]), true);
});

const summaryFor = async (t, plays) => frozenRenders({ ids: ["first--default"], fileCount: 1, baseUrl: BASE, headUrl: HEAD,
  browser: fakeBrowser(plays), out: sandbox(t).out, command: "frozen-render.mjs --base abc --story-file a.stories.tsx", inputs: "0123456789abcdef" });

test("the gate prints one PASS line, appends the change-log line, and passes an empty selection without rendering (ISS-14395)", async (t) => {
  const { out } = sandbox(t);
  const changeLog = path.join(out, "changes.md");
  mkdirSync(out, { recursive: true });
  writeFileSync(changeLog, "earlier line");
  const summary = await summaryFor(t, { [BASE]: { "first--default": passes(shot(GREY)) }, [HEAD]: { "first--default": passes(shot(GREY)) } });
  const calls = [];
  const result = await frozenGate({ repo: "/repo", base: "abc", baseDir: "/base", out, changeLog, workers: 3 }, {
    record: () => null, select: () => [FIRST], launch: () => "launcher",
    compare: async (args, dependencies) => { calls.push({ args, dependencies }); return summary; },
  });
  assert.deepEqual(result, { exitCode: GateExit.Pass, line: "FROZEN PASS 1 files 1 stories inputs 0123456789abcdef" });
  assert.equal(calls[0].args.staticBuild, true, "the gate always renders static builds");
  assert.equal(calls[0].args.workers, 3);
  assert.deepEqual(calls[0].args.storyFiles, [FIRST]);
  assert.equal(calls[0].dependencies.launch, "launcher");
  assert.equal(readFileSync(changeLog, "utf8"), `earlier line\n${summary.changeLogLine}\n`);

  const empty = await frozenGate({ repo: "/repo", base: "abc", out, changeLog }, {
    record: () => null, select: () => [], inputsOf: (_repo, _base, files) => `digest-of-${files.length}`,
    compare: async () => { throw new Error("nothing selected, nothing rendered"); }, launch: () => { throw new Error("no browser"); },
  });
  assert.deepEqual(empty, { exitCode: GateExit.Pass, line: "FROZEN PASS 0 files 0 stories inputs digest-of-0" });
});

test("the gate prints one BLOCK line naming results.json and writes no change-log line for the known-changed story (ISS-14395)", async (t) => {
  const { out } = sandbox(t);
  const changeLog = path.join(out, "changes.md");
  const summary = await summaryFor(t, { [BASE]: { "first--default": passes(shot(GREY)) }, [HEAD]: { "first--default": passes(shot(GREY, BLUE)) } });
  const result = await frozenGate({ repo: "/repo", base: "abc", baseDir: "/base", out, changeLog }, {
    record: () => null, select: () => [FIRST], launch: () => "launcher", compare: async () => summary,
  });
  assert.deepEqual(result, { exitCode: GateExit.Block, line: `FROZEN BLOCK 1 stories: ${path.join(out, "results.json")}` });
  assert.throws(() => readFileSync(changeLog, "utf8"), /ENOENT/);
});

test("without --base-dir the gate prepares, bootstraps and always removes its own base worktree (ISS-14395)", async (t) => {
  const { out } = sandbox(t);
  mkdirSync(out, { recursive: true });
  const changeLog = path.join(out, "changes.md");
  const summary = await summaryFor(t, { [BASE]: { "first--default": passes(shot(GREY)) }, [HEAD]: { "first--default": passes(shot(GREY)) } });
  const events = [];
  const own = path.join(out, "base-worktree");
  const dependencies = {
    record: () => null, select: () => [FIRST, SECOND], launch: () => "launcher",
    prepare: (args) => events.push(["prepare", args]),
    bootstrap: (dir) => { events.push(["bootstrap", dir]); return { status: "OK" }; },
    removeWorktree: (repo, dir) => events.push(["remove", repo, dir]),
    compare: async (args) => { events.push(["compare", args.baseDir]); return summary; },
  };
  const result = await frozenGate({ repo: "/repo", base: "abc", out, changeLog }, dependencies);
  assert.equal(result.exitCode, GateExit.Pass, result.line);
  assert.deepEqual(events, [
    ["prepare", { repo: "/repo", base: "abc", storyFiles: [FIRST, SECOND], dir: own }],
    ["bootstrap", own], ["compare", own], ["remove", "/repo", own],
  ]);

  events.length = 0;
  await assert.rejects(frozenGate({ repo: "/repo", base: "abc", out, changeLog }, { ...dependencies, compare: async () => { throw new Error("render crashed"); } }), /render crashed/);
  assert.deepEqual(events.at(-1), ["remove", "/repo", own], "a failed render still removes the base worktree");

  events.length = 0;
  const failedBootstrap = await frozenGate({ repo: "/repo", base: "abc", out, changeLog }, { ...dependencies,
    bootstrap: () => ({ status: "NEEDS_AGENT", reason: "pnpm install failed" }) });
  assert.deepEqual(failedBootstrap, { exitCode: GateExit.Error, line: "FROZEN ERROR the base worktree's bootstrap did not finish (NEEDS_AGENT): pnpm install failed" });
  assert.deepEqual(events.map(([name]) => name), ["prepare", "remove"]);

  events.length = 0;
  await frozenGate({ repo: "/repo", base: "abc", baseDir: "/prepared", out, changeLog }, dependencies);
  assert.deepEqual(events, [["compare", "/prepared"]], "--base-dir overrides: nothing is prepared or removed");
});

test("the gate errors with exit 2 when the run has no verdict", async () => {
  const moved = await frozenGate({ repo: "/repo", base: "abc", baseDir: "/base", out: "/out", changeLog: "/log" }, {
    record: () => null, select: () => [FIRST], launch: () => "launcher",
    compare: async () => ({ ok: false, blocking: [], lines: ["SOURCE-MOVED: HEAD\nchanged during the run"] }),
  });
  assert.deepEqual(moved, { exitCode: GateExit.Error, line: "FROZEN ERROR SOURCE-MOVED: HEAD changed during the run" });
});

test("the gate CLI prints exactly one line: PASS for a diff no frozen story renders, ERROR with exit 2 on bad usage", (t) => {
  const home = makeHome("vibe-frozen-gate-cli-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  for (const [file, text] of Object.entries(BASE_FILES)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, ["add", "-A"], home.home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home.home);
  const base = git(checkout, ["rev-parse", "HEAD"], home.home);
  writeFileSync(path.join(checkout, "notes.md"), "unrelated\n");
  const env = { ...process.env, HOME: fixture.home };
  const pass = spawnSync(process.execPath, [GATE, "--repo", checkout, "--base", base], { encoding: "utf8", env });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.equal(pass.stdout, `FROZEN PASS 0 files 0 stories inputs ${frozenInputs(checkout, base, [])}\n`);
  const unboundEnv = { ...process.env, HOME: home.home, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" };
  const unbound = spawnSync(process.execPath, [GATE, "--repo", checkout, "--base", base], { encoding: "utf8", env: unboundEnv });
  assert.equal(unbound.status, 2, unbound.stdout + unbound.stderr);
  assert.equal(unbound.stdout, "FROZEN ERROR no vibe provider layout is bound; selection cannot be computed\n");
  const usage = spawnSync(process.execPath, [GATE, "--base", base], { encoding: "utf8", env });
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout.split("\n").length, 2);
  assert.match(usage.stdout, /^FROZEN ERROR Usage: frozen-render-gate\.mjs/);
  const workers = spawnSync(process.execPath, [GATE, "--repo", checkout, "--base", base, "--workers", "0"], { encoding: "utf8", env });
  assert.equal(workers.status, 2);
  assert.equal(workers.stdout, "FROZEN ERROR --workers must be a whole number of at least 1\n");
  assert.equal(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.some((entry) => entry.rule === "frozen-render"), false);
});

test("the change-log line the gate appends clears handoff's frozen-render rule for the selected story file (ISS-14395)", async (t) => {
  const selected = run(t, { base: BASE_FILES, head: { [COMPONENT]: "export const First = 2;\n" } });
  const finding = () => runDiffRules({ worktree: selected.checkout, base: selected.baseSha, isFrozenStory }).blocking.find((entry) => entry.rule === "frozen-render");
  assert.ok(finding(), "the component change selects the first story file");
  const ids = ["Default", "Open"].map((name) => storyId("Composites v1.0/First", name));
  const plays = { [BASE]: {}, [HEAD]: {} };
  for (const id of ids) {
    plays[BASE][id] = passes(shot(GREY));
    plays[HEAD][id] = passes(shot(GREY));
  }
  const { out } = sandbox(t);
  const changeLog = path.join(git(selected.checkout, ["rev-parse", "--absolute-git-dir"], fixture.home), "vibe-changes.md");
  const result = await frozenGate({ repo: selected.checkout, base: selected.baseSha, baseDir: "/prepared-base", out, changeLog }, {
    launch: () => "launcher",
    compare: (args) => frozenStoryFiles({ ...args, baseUrl: BASE, headUrl: HEAD, browser: fakeBrowser(plays) }),
  });
  assert.equal(result.exitCode, GateExit.Pass, result.line);
  assert.equal(result.line, `FROZEN PASS 1 files 2 stories inputs ${frozenInputs(selected.checkout, selected.baseSha, [FIRST])}`);
  assert.equal(finding(), undefined, "the appended line is the one the rule accepts");
});

test("a story selected only through a session local fix is left out, as the inventory leaves it out of the frozen-render rule (ISS-14395)", async (t) => {
  const selected = run(t, { base: BASE_FILES, head: { [COMPONENT]: "export const First = 2;\n" } });
  assert.deepEqual(selectFrozenStoryFiles(selected.checkout, selected.baseSha), [FIRST]);
  const gitDir = git(selected.checkout, ["rev-parse", "--absolute-git-dir"], fixture.home);
  writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ localFixes: [{ ticket: "ISS-9", paths: [COMPONENT] }] }));
  const { out } = sandbox(t);
  const result = await frozenGate({ repo: selected.checkout, base: selected.baseSha, out, changeLog: path.join(out, "changes.md") }, {
    compare: async () => { throw new Error("a local fix selects nothing to render"); }, launch: () => "launcher",
  });
  assert.deepEqual(result, { exitCode: GateExit.Pass, line: `FROZEN PASS 0 files 0 stories inputs ${frozenInputs(selected.checkout, selected.baseSha, [])}` });
  assert.equal(runDiffRules({ worktree: selected.checkout, base: selected.baseSha, isFrozenStory, exclude: new Set([COMPONENT]) })
    .blocking.some((entry) => entry.rule === "frozen-render"), false, "the diff rules with the same exclusion agree");
});

test("with no provider layout bound the gate refuses with exit 2 instead of passing an empty selection", async () => {
  const result = await frozenGate({ repo: "/repo", base: "abc", out: "/out", changeLog: "/log" }, {
    layout: () => ({}), record: () => null, select: () => { throw new Error("selection must not run"); },
  });
  assert.deepEqual(result, { exitCode: GateExit.Error, line: "FROZEN ERROR no vibe provider layout is bound; selection cannot be computed" });
  const unbound = await frozenGate({ repo: "/repo", base: "abc", out: "/out", changeLog: "/log" }, { layout: () => undefined, select: () => [] });
  assert.equal(unbound.exitCode, GateExit.Error);
});

test("standalone frozen rendering reads the slots of the current chat's bound program", t => {
  const root = mkdtempSync(path.join(tmpdir(), "frozen-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "fleet"), program = path.join(home, "programs", "p");
  mkdirSync(program, { recursive: true });
  const env = { HOME: root, CODEX_THREAD_ID: "frozen-chat" };
  bindChat("frozen-chat", home, "p", env);
  writeFileSync(path.join(home, "config.env"), "HEAVY_SLOTS=2\n");
  assert.equal(frozenHeavySlots(env), "2");
});

test("ISS-14682 AC1: the gate records an authorized frozen story move with its ticket and criterion and does not select it", async (t) => {
  const { out } = sandbox(t);
  const changeLog = path.join(out, "changes.md");
  mkdirSync(out, { recursive: true });
  const ids = [storyId("Composites v1.0/First", "Default"), storyId("Composites v1.0/First", "Open")];
  const move = { path: FIRST, to: "apps/storybook/stories/current-first.stories.tsx", kind: "moved", ticket: "ISS-123", criterion: "AC-1",
    version: 2, storyIds: ids, disclosures: [] };
  const line = `Frozen story move: ${FIRST} -> apps/storybook/stories/current-first.stories.tsx: ISS-123 AC-1: 2 stories (${ids.join(", ")})`;
  const summary = await summaryFor(t, { [BASE]: { "first--default": passes(shot(GREY)) }, [HEAD]: { "first--default": passes(shot(GREY)) } });
  const compared = [];
  const gate = (selected) => frozenGate({ repo: "/repo", base: "abc", baseDir: "/base", out, changeLog }, {
    record: () => ({ frozenStoryMoves: [{ path: FIRST, ticket: "ISS-123", cites: "AC-1" }] }),
    moves: (repo, base, record) => { assert.deepEqual([repo, base, record.frozenStoryMoves[0].path], ["/repo", "abc", FIRST]); return { moves: [move], problems: [] }; },
    select: () => selected, launch: () => "launcher", inputsOf: () => "digest",
    compare: async (args) => { compared.push(args.storyFiles); return summary; },
  });
  assert.deepEqual(await gate([FIRST]), { exitCode: GateExit.Pass, line: "FROZEN PASS 0 files 0 stories inputs digest" });
  assert.deepEqual(compared, []);
  assert.equal(readFileSync(changeLog, "utf8"), `${line}\n`);
  await gate([FIRST, SECOND]);
  assert.deepEqual(compared, [[SECOND]]);
  // The move is recorded once however often the gate runs.
  assert.equal(readFileSync(changeLog, "utf8").split("\n").filter((entry) => entry === line).length, 1);
});
