import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";
import { run } from "./diff-rules-test-fixture.mjs";
import { runDiffRules } from "./diff-rules.mjs";
import { exactReplacedMoves } from "./diff-rules-repo.mjs";
import { checkAgentDecisionCitations } from "./comment-rules.mjs";
import {
  checkComparators,
  checkOrphanedTypeMembers,
  checkParserLayoutProof,
  checkRangeParamCopies,
  checkRenderedCopyAssertions,
  checkStoragePrefixCopies,
} from "./review-gap-rules.mjs";
import {
  checkDisplayNameSqlOwners,
  checkOrphanedHookNames,
  checkOrphanedModules,
  checkRetainedContractComments,
  checkTieBreakerFixtureReach,
} from "./removal-review-rules.mjs";
import { checkStoryStateCoverage } from "./story-coverage-rules.mjs";

bindProviderInProcess(after);

const baseCommit = "b".repeat(40);

function changed(file, before, after) {
  const lines = (source) => (source ?? "").split("\n").map((text, offset) => ({ text, line: offset + 1 }));
  return { path: file, status: before === null ? "A" : after === null ? "D" : "M", added: lines(after), removed: lines(before) };
}

function repo(before, after) {
  const files = Object.keys(after);
  return {
    baseCommit,
    baseFiles: new Set(Object.keys(before)),
    headFiles: files,
    base: (file) => before[file] ?? null,
    head: (file) => after[file] ?? null,
    wordFiles: (name) => files.filter((file) => after[file].includes(name)),
    importersOf: () => new Map(),
    sessionIds: ["DT-030"],
  };
}

function findings(check, files, source) {
  const values = [];
  check(files, source, (rule, file, line) => values.push({ rule, file, line }));
  return values;
}

function singleFileRule(check, file, before, after) {
  return findings(check, [changed(file, before, after)], repo({ [file]: before }, { [file]: after }));
}

test("ISS-14476 ranks only ordering candidates, not a local closure exclusively called under await", () => {
  const file = "modules/frozen-render.mjs";
  const run = (text) => {
    const found = [];
    checkComparators([changed(file, null, text)], repo({}, { [file]: text }), null, (rule) => found.push(rule), "");
    return found;
  };
  assert.deepEqual(run(`async function prepare({ compare = defaultCapture }) {
    return await compare(repo);
  }
  async function captureAll() {
    const compare = (worker, id) => frozenStory(worker, id).catch(failed);
    result = await compare(worker, id);
  }`), []);
  for (const source of [
    `function sortRows(rows) {
      const compare = (a, b) => a.rank - b.rank;
      return rows.sort(compare);
    }`,
    `export const compareRows = (a, b) => a.rank - b.rank;`,
    `const items = rows.sort((a, b) => b.directory.length - a.directory.length);`,
    `async function unclear() {
      const compare = (worker, id) => frozenStory(worker, id);
      return compare(worker, id);
    }`,
    `async function nestedUse() {
      const compare = (a, b) => a.rank - b.rank;
      const sortRows = () => rows.sort(compare);
      await compare(a, b);
      return sortRows();
    }`,
  ]) assert.deepEqual(run(source), ["comparator-tie"]);
});

test("ISS-14476 requires parser proof at the exact base and row even when the named test exists", () => {
  const parser = "modules/list-parser.mjs";
  const fixture = "modules/list-parser.test.mjs";
  const head = "export function parse(input) { return input.split(','); }";
  const diff = [changed(parser, null, head)];
  const source = repo({}, { [parser]: head, [fixture]: "import test from 'node:test';" });
  const required = [];
  const problems = [];
  const check = (proof) => checkParserLayoutProof(diff, source, proof, (rule) => problems.push(rule), required);

  check("Parser layouts: " + parser + ": base " + "c".repeat(40) + ", rows DT-030, property test " + fixture);
  check("Parser layouts: " + parser + ": base " + baseCommit + ", rows DT-031, property test " + fixture);
  check("Parser layouts: " + parser + ": base " + baseCommit + ", rows DT-030, property test " + fixture);

  assert.deepEqual(problems, ["parser-layout-proof", "parser-layout-proof"]);
  assert.deepEqual(required.map(({ path }) => path), [fixture]);
});

test("ISS-14476 catches text tests whose oracle changes with the rendering helper", () => {
  const file = "packages/app/row.test.tsx";
  const lookup = (arg) => "screen.queryByText" + "(" + arg + ");";
  assert.equal(singleFileRule(checkRenderedCopyAssertions, file, "",
    lookup("getRenderedLabel(row)"))[0]?.rule, "rendered-copy-oracle");
  assert.equal(singleFileRule(checkRenderedCopyAssertions, file, "",
    "const expected = getRenderedLabel(row);\n" + lookup("expected"))[0]?.rule, "rendered-copy-oracle");
  assert.deepEqual(singleFileRule(checkRenderedCopyAssertions, file, "", lookup("EMPTY_ROW_LABEL")), []);
});

test("AC-47 ISS-14476 catches a linked unused type member without removing another production producer", () => {
  const provider = "packages/app/row.ts";
  const type = "packages/app/row-types.ts";
  const other = "packages/app/alternate.ts";
  const before = "import type { Row } from './row-types';\nexport const row: Row = {\n  content: <Empty />,\n};";
  const after = "import type { Row } from './row-types';\nexport const row: Row = {};";
  const shape = "export interface Row {\n  content?: ReactNode;\n}";
  const check = (current) => findings(checkOrphanedTypeMembers, [changed(provider, before, after)],
    repo({ [provider]: before, [type]: shape }, current));

  assert.equal(check({ [provider]: after, [type]: shape })[0]?.file, type);
  assert.deepEqual(check({ [provider]: after, [type]: shape, [other]: before }), []);
});

test("AC-48 ISS-14476 detects copied storage prefixes and query keys while allowing owner imports and unrelated copy", () => {
  const storage = "packages/app/remembered.ts";
  const query = "packages/app/remembered-policy.ts";
  const file = "packages/app/remembered.test.ts";
  const owners = { [storage]: "export const view = { keyPrefix: 'sessions:remembered:' };",
    [query]: "export const LIST_RANGE_PARAM = 'range';" };
  const bad = "const key = 'sessions:remembered:one';\nsearchParams.set('range', selected);";
  const good = "const key = view.keyPrefix + 'one';\nsearchParams.set(LIST_RANGE_PARAM, selected);\nconst label = 'range';";
  const check = (head) => {
    const source = repo({}, { ...owners, [file]: head });
    const diff = [changed(file, null, head)];
    return [...findings(checkStoragePrefixCopies, diff, source), ...findings(checkRangeParamCopies, diff, source)].map(({ rule }) => rule);
  };

  assert.deepEqual(check(bad), ["copied-storage-prefix", "copied-query-key"]);
  assert.deepEqual(check(good), []);
});

test("AC-51 ISS-14476 refuses orchestrator or fleet lead product provenance without an actual human or ticket criterion", () => {
  const file = "packages/app/row.tsx";
  const source = { rules: { ticketed: /\bISS-\d+\b/ } };
  const check = (s) => findings(checkAgentDecisionCitations, [changed(file, "", s)], source);
  assert.equal(check("// V-1: (orchestrator)").at(0)?.rule, "agent-decision-citation");
  assert.equal(check("// ISS-13707 (fleet lead ruling Q-4): order by tag names.").at(0)?.rule, "agent-decision-citation");
  assert.deepEqual(check("// ISS-13707 AC-2 (fleet lead ruling Q-4): order by tag names."), []);
  assert.deepEqual(check("// (orchestrator) refresh the tool connection."), []);
});

test("AC-52 ISS-14476 demands whole-file retirement provenance at the ordinary diff entry point", (t) => {
  const deleted = "packages/app/retired.test.ts";
  const stillLive = "packages/app/current.test.ts";
  const owner = "packages/app/retired-route.ts";
  const text = [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { enabled } from './retired-route';",
    "test('retired route', () => { assert.equal(enabled(), true); });",
  ].join("\n");
  const result = run(t, { base: { [deleted]: text, [stillLive]: "import test from 'node:test';\n", [owner]: "export const enabled = () => true;\n" },
    head: { [deleted]: null, [owner]: null }, binding: null });
  const gitDir = path.join(result.checkout, ".git");
  const sidecar = path.join(gitDir, "vibe-retired-tests.json");
  const rerun = (entries) => {
    writeFileSync(sidecar, JSON.stringify(entries));
    return runDiffRules({ worktree: result.checkout, base: result.baseSha, binding: null }).blocking
      .filter(({ rule }) => rule === "retired-test-record").map(({ file }) => file);
  };
  const evidence = { path: deleted, retiredBy: "ISS-14476", covers: "Retired flag-only route",
    assertions: [{ case: "retired route", index: 1, source: owner }] };

  assert(result.found.some(([rule, file]) => rule === "retired-test-record" && file === deleted));
  assert.deepEqual(rerun([{ ...evidence, case: "old case" }]), [deleted]);
  assert.deepEqual(rerun([{ ...evidence, path: stillLive }]), [deleted]);
  assert.deepEqual(rerun([evidence]), []);
});

test("AC-53 ISS-14476 counts only a production import as an owner after a deletion", () => {
  const shell = "packages/app/modal-shell.tsx";
  const wrapper = "packages/app/modal.tsx";
  const testFile = "packages/app/modal.test.tsx";
  const secondCaller = "packages/app/modal-shell-host.tsx";
  const imported = "import { Shell } from './modal-shell';\nexport const Modal = Shell;";
  const before = { [wrapper]: imported, [shell]: "export const Shell = () => null;" };
  const after = { [shell]: before[shell], [testFile]: imported };
  const diff = [changed(wrapper, imported, null)];
  const fixture = (more) => ({ ...repo(before, { ...after, ...more }), importersOf: () => new Map([[shell, new Set([testFile, secondCaller])]]) });

  assert.equal(findings(checkOrphanedModules, diff, fixture({}))[0]?.file, shell);
  assert.deepEqual(findings(checkOrphanedModules, diff, fixture({ [secondCaller]: imported })), []);
});

test("AC-54 ISS-14476 differentiates active behavior docs and a pure function from preserved hook behavior", () => {
  const file = "packages/app/use-detail.ts";
  const staleComment = "/** Issues only while " + "\x60issues-v2\x60" + " is enabled. */\n";
  const author = "export function useDetail() {\n  return useFeatureFlag(ISSUES_V2_FEATURE_FLAG_KEY);\n}\n";
  const pure = "export function useDetail() {\n  return true;\n}\n";
  const historical = staleComment.replace("only while", "previously used");
  const before = staleComment + author;

  assert.equal(singleFileRule(checkRetainedContractComments, file, before, staleComment + pure)[0]?.rule, "stale-behavior-comment");
  assert.deepEqual(singleFileRule(checkRetainedContractComments, file, before, historical + pure), []);
  assert.equal(singleFileRule(checkOrphanedHookNames, file, before, pure)[0]?.rule, "orphaned-hook-name");
  assert.deepEqual(singleFileRule(checkOrphanedHookNames, file, before, pure.replace("useDetail", "detailSection")), []);
  assert.deepEqual(singleFileRule(checkOrphanedHookNames, file, before, author), []);
});


test("AC-56 ISS-14476 locates a second SQL name transform even when empty names diverge", () => {
  const owner = "apps/api/lib/artifact-sort-key-sql.ts";
  const caller = "apps/api/app/documents/document-list-definition.ts";
  const canonical = "export const nameSql = Prisma.sql\x60COALESCE(NULLIF(btrim(concat_ws(' ', assignee.first_name, assignee.last_name)), ''), assignee.email)\x60;";
  const copy = "const ownerSql = Prisma.sql\x60NULLIF(COALESCE(btrim(concat_ws(' ', account.first_name, account.last_name)), account.email), '')\x60;";
  const use = "import { nameSql } from '../../lib/artifact-sort-key-sql';\nconst ownerSql = nameSql;";
  const check = (source) => findings(checkDisplayNameSqlOwners, [changed(caller, "", source)],
    repo({ [owner]: canonical }, { [owner]: canonical, [caller]: source }));

  assert.equal(check(copy)[0]?.file, caller);
  assert.deepEqual(check(use), []);
});

test("AC-57 ISS-14476 only selects pagination proofs when tied keys cross the actual page boundary", () => {
  const file = "apps/api/document-list.integration.test.ts";
  const suite = (size) => [
    "const PAGE_SIZE = " + size + ";",
    "it.each([[Direction.Asc, [0, 2, 1, 3]], [Direction.Desc, [1, 3, 0, 2]]])(",
    "  'orders by Project with ties', async () => {",
    "    const corpus = await seedCorpus([{project: 'alpha'}, {project: 'beta'}, {project: 'alpha'}, {project: 'beta'}]);",
    "    await readPages(corpus, DocumentListField.Project, {limit: PAGE_SIZE});",
    "  });",
  ].join("\n");
  const required = [];
  const check = (size) => {
    const source = suite(size);
    return findings((files, read, add) => checkTieBreakerFixtureReach(files, read, add, required),
      [changed(file, null, source)], repo({}, { [file]: source }));
  };

  assert.equal(check(2)[0]?.rule, "unreached-cursor-tiebreak");
  assert.deepEqual(required, []);
  assert.deepEqual(check(1), []);
  assert.deepEqual(required.map(({ path }) => path), [file]);
});

test("ISS-14476 checks flag stories and current history states while ignoring historical releases", () => {
  const config = ".vibe/storybook-rules.json";
  const manifest = "apps/storybook/package.json";
  const history = "apps/storybook/release.ts";
  const story = "packages/app/list.stories.tsx";
  const flag = "packages/api/list-flag.ts";
  const live = "packages/app/use-list.ts";
  const texts = {
    [config]: JSON.stringify({ release: { versionFile: manifest, historyFiles: [history] } }),
    [manifest]: JSON.stringify({ version: "1.2.0" }),
    [history]: "const releases = [{version:'1.2.0', changes:['Surfaces/Issue List: Loading added.']}, {version:'1.1.0', changes:['Surfaces/Issue List: Historical added.']}];",
    [flag]: "export const LIST_FLAG_KEY = 'list-flag';",
    [live]: "import {LIST_FLAG_KEY} from '../api/list-flag'; export const List = () => useFeatureFlagGate(LIST_FLAG_KEY);",
  };
  const enabled = "import { LIST_FLAG_KEY } from '../api/list-flag';\nimport { List } from './use-list';\nexport default { component: List, title: 'Surfaces/Issue List' };\nexport const Loading = { parameters: { appCore: { enabledFlags: [LIST_FLAG_KEY] } } };";
  const check = (source) => findings(checkStoryStateCoverage,
    [changed(flag, null, texts[flag]), changed(history, "", texts[history])], repo({}, { ...texts, [story]: source }));

  assert.deepEqual(check(enabled).map(({ rule }) => rule), ["flag-story-arms"]);
  assert.deepEqual(check(enabled.replace("./use-list", "./unrelated") + "\nexport const Default = { args: {} };")
    .map(({ rule }) => rule), ["flag-story-arms"]);
  assert.deepEqual(check(enabled + "\nexport const AlsoEnabled = { ...Loading };").map(({rule}) => rule), ["flag-story-arms"]);
  const named = enabled.replace("export default", "const ON = [LIST_FLAG_KEY];\nexport default")
    .replace("enabledFlags: [LIST_FLAG_KEY]", "enabledFlags: ON");
  assert.deepEqual(check(named + "\nexport const Default = { args: {} };"), []);
  const flat = enabled.replace("appCore: { enabledFlags: [LIST_FLAG_KEY] }", "enabledFlags: [LIST_FLAG_KEY]");
  assert.deepEqual(check(flat + "\nexport const Default = {};").map(({rule}) => rule), ["flag-story-arms"]);
  const inherited = enabled.replace("component: List", "parameters:{appCore:{enabledFlags:[LIST_FLAG_KEY]}}, component: List");
  assert.deepEqual(check(inherited + "\nexport const Default = { parameters:{appCore:{enabledFlags:[]}} };"), []);
  for (const filter of ["excludeStories: ['Fixture']", "includeStories: /^Loading$/"]) {
    const selected = enabled.replace("component: List", filter + ", component: List") + "\nexport const Fixture = { args: {} };";
    assert.deepEqual(check(selected).map(({rule}) => rule), ["flag-story-arms"]);
  }
  const priorHistory = texts[history];
  texts[history] = priorHistory.replace("Loading added", "new Missing story");
  assert.deepEqual(check(enabled + "\nexport const Default = {};").map(({rule}) => rule), ["storybook-history-state"]);
  texts[history] = priorHistory.replace("Loading added", "new Active Users story");
  assert.deepEqual(check(enabled.replace("Loading = {", "Loading = { name: 'Active Users',") + "\nexport const Default = {};"), []);
  texts[history] = priorHistory.replace("Surfaces/Issue List: Loading", "Foundations/Colors: Missing");
  assert.deepEqual(check(enabled + "\nexport const Default = {};").map(({rule}) => rule), ["storybook-history-state"]);
  texts[history] = priorHistory;
  assert.deepEqual(check(enabled + "\nexport const Default = { args: {} };"), []);
  assert.deepEqual(check(enabled.replace("export const Loading", "export const Empty") + "\nexport const Default = { args: {} };")
    .map(({ rule }) => rule), ["storybook-history-state"]);
});

test("ISS-14476 classifies an exact unique replacement separately from a copy, edited blob or changed mode", () => {
  const before = "packages/app/old-render.ts";
  const added = "packages/app/replacement-render.ts";
  const body = "export function render() { return null; }";
  const same = { mode: "100644", oid: "a".repeat(40) };
  const different = { ...same, oid: "b".repeat(40) };
  const check = (prior, replacement) => exactReplacedMoves(
    [changed(before, body, body + "\n"), changed(added, null, body)],
    { baseObjects: new Map([[before, same]]), headRegularBlob: (file) => file === before ? prior : replacement },
  )[1];

  assert.deepEqual({ status: check(different, same).status, oldPath: check(different, same).oldPath }, { status: "R", oldPath: before });
  assert.equal(check(same, same).status, "A");
  assert.equal(check(different, different).status, "A");
  assert.equal(check(different, { ...same, mode: "100755" }).status, "A");
});

test("ISS-14476 runs the same duplicate helper rule for tracked edits and untracked files before handoff", (t) => {
  const owner = "packages/shared/normalize.ts";
  const copied = "packages/shared/copy.ts";
  const body = "function localNormalize(value: string) {\n  return value.trim().toLowerCase().normalize();\n}\n";
  const isDuplicate = ({ found }) => found.some(([rule, file]) => rule === "duplicate-helper" && file === copied);
  assert.equal(isDuplicate(run(t, { base: { [owner]: body }, head: { [copied]: body } })), true);
  assert.equal(isDuplicate(run(t, { base: { [owner]: body, [copied]: "const part = 1;\n" }, head: { [copied]: body } })), true);
  assert.equal(isDuplicate(run(t, { base: { [owner]: body }, head: { [copied]: body.replace("value.trim()", "value.normalize()") } })), false);
});

for (const [label, declaration, states, want] of [
  ["static flag spreads", "const base=[];", "export const On={parameters:{appCore:{enabledFlags:[...base,F]}}}; export const Off={};", true],
  ["unknown spread with explicit flag", "", "export const On={parameters:{appCore:{enabledFlags:[...external,F]}}}; export const Off={};",true],
  ["unresolved spread does not prove absence", "", "export const On={parameters:{appCore:{enabledFlags:[F]}}}; export const Off={parameters:{appCore:{enabledFlags:[...external]}}};",false],
  ["args override applied last", "", "export const On={parameters:{appCore:{enabledFlags:['actual']},appCoreFromArgs:()=>({enabledFlags:[]})}}; export const Off={};",false],
  ["unresolved args override", "", "export const On={parameters:{appCore:{enabledFlags:['actual']},appCoreFromArgs:dynamic}}; export const Off={};",false],
  ["local flag literal beats spelling", "const ACTUAL_FLAG_KEY='other';", "export const On={parameters:{appCore:{enabledFlags:[ACTUAL_FLAG_KEY]}}}; export const Off={};",false],
  ["same named import from another file", "import { ACTUAL_FLAG_KEY } from './other';", "export const On={parameters:{appCore:{enabledFlags:[ACTUAL_FLAG_KEY]}}}; export const Off={};",false],
  ["empty function cannot demonstrate an arm", "", "export const On={parameters:{appCore:{enabledFlags:[F]}}}; export function Off(){return null}",false],
  ["function renders the surface", "", "export const On={parameters:{appCore:{enabledFlags:[F]}}}; export function Off(){return <View/>}",true],
  ["literal args drive both arms", "", "export const On={args:{enabled:true},parameters:{appCoreFromArgs:({enabled})=>({enabledFlags:enabled?[F]:[]})}}; export const Off={args:{enabled:false},parameters:{appCoreFromArgs:(args)=>({enabledFlags:args.enabled?[F]:[]})}};",true],
  ["aliased consumer requires both states", "", "export const On={parameters:{appCore:{enabledFlags:[F]}}};",false],
]) test("AC-058 review " + label, () => {
  const flag="src/flags.ts", component="src/view.tsx", story="src/view.stories.tsx";
  const texts = { [flag]:"export const ACTUAL_FLAG_KEY='actual';", [component]:label.startsWith("aliased consumer") ? "import {ACTUAL_FLAG_KEY as flag} from './flags'; export const View=()=>useFeatureFlagGate(flag);" : "import {ACTUAL_FLAG_KEY} from './flags';export const View=()=>useFeatureFlagGate(ACTUAL_FLAG_KEY);",
    "src/other.ts":"export const ACTUAL_FLAG_KEY='other';", [story]: "import { View } from './view'; import { ACTUAL_FLAG_KEY as F } from './flags'; " + declaration + " export default {component:View}; " + states };
  const found=findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts));
  assert.equal(found.some(f=>f.rule==="flag-story-arms"),!want);
});

for (const [name, story, trigger, expected] of [
  ["uncollected colocated story","packages/ui/view.stories.tsx","history",true],
  ["collection only edit","packages/ui/view.stories.tsx","config",true],
  ["collected mjs story","apps/catalog/stories/view.stories.mjs","history",false],
  ["story-only rename","apps/catalog/stories/view.stories.tsx","story",true],
]) test("AC-058 review " + name, () => {
  const history="apps/catalog/release.ts";
  const texts={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"apps/catalog/package.json",historyFiles:[history]}}),
    "apps/catalog/package.json":'{"version":"1.2.0"}', [history]:"const release={version:'1.2.0',notes:['Surfaces/V: new Checked story.']};",
    "apps/catalog/.storybook/main.ts":"export default {stories:['../stories/**/*.stories.@(js|tsx|mjs)']};",
    [story]:"export default {title:'Surfaces/V'}; export const " + (trigger==="story"?"Renamed":"Checked") + "={};"};
  const file=trigger==="history"?history:trigger==="config"?"apps/catalog/.storybook/main.ts":story;
  const found=findings(checkStoryStateCoverage,[changed(file,"",texts[file])],repo({},texts));
  assert.equal(found.some(f=>f.rule==="storybook-history-state"),expected);
});

for (const [label, component, body, complete] of [
  ["saved factory owner","Panel","{let V=Panel;const make=()=> <V/>;const saved=make();V=Badge;return saved}",true],
  ["saved factory sibling","Panel","{let V=Badge;const make=()=> <V/>;const saved=make();V=Panel;return saved}",false],
  ["sequential declaration list","Panel","{let V=Panel;const saved=<V/>,unused=(V=Badge);return saved}",true],
  ["taken conditional write","Panel","{let V=Panel;true ? V=Badge : V=Panel;return <V/>}",false],
  ["unknown conditional writes","Panel","{let V=Panel;unknown ? V=Badge : V=Badge;return <V/>}",false],
  ["dead short circuit","Short","<Short/>",false],
  ["returned short circuit","Panel","true && <Panel/>",true],
  ["unreached return operand","Panel","true || <Panel/>",false],
  ["attribute reads flag","Attribute","<Attribute/>",true],
  ["module closure ignores caller shadow","Wrapped","{const View=Panel;return <Wrapped/>}",false],
  ["module closure retains actual binding","Mounted","{const Target=()=>null;return <Mounted/>}",true],
  ["reassigned component","Panel","{let View=Panel;View=Badge;return <View/>}",false],
  ["reassigned JSX","Panel","{let view=null;view=<Panel/>;return view}",true],
  ["removed JSX","Panel","{let view=<Panel/>;view=null;return view}",false],
  ["actual direct component","Panel","<Panel/>",true],
  ["unrelated sibling component","Badge","<Badge/>",false],
  ["actual barrel alias","PublishedPanel","<PublishedPanel/>",true],
  ["unrelated re-export","PublishedBadge","<PublishedBadge/>",false],
  ["early return","Panel","{if(true)return null; return <Panel/>}",false],
  ["early throw","Panel","{throw Error(); return <Panel/>}",false],
  ["local element alias","Panel","{const element=<Panel/>;return element}",true],
  ["completed inner shadow","Panel","{{const Panel=()=>null;}return <Panel/>}",true],
  ["imported forwarding wrapper","Panel","<Forward><Panel/></Forward>",true],
  ["imported dropping wrapper","Panel","<Drop><Panel/></Drop>",false],
  ["lexical shadow","Panel","{const Panel=()=>null;return <Panel/>}",false],
  ["dropped children","Panel","<Blank><Panel/></Blank>",false],
  ["forwarded children","Panel","<Pass><Panel/></Pass>",true],
  ["locally shadowed flag binding","ShadowFlag","<ShadowFlag/>",false],
  ["local flag alias","LocalFlag","<LocalFlag/>",true],
  ["uninvoked hook","Unused","<Unused/>",false],
  ["unreachable hook","After","<After/>",false],
  ["saved owner","Panel","{let V=Panel;const Saved=V;V=Badge;return <Saved/>}",true],
  ["saved sibling","Badge","{let V=Badge;const Saved=V;V=Panel;return <Saved/>}",false],
  ["nested outer write","Badge","{let V=Panel;{V=Badge}return <V/>}",false],
  ["taken outer write","Panel","{let V=Badge;if(true){V=Panel}return <V/>}",true],
  ["shadowed write","Panel","{let V=Panel;{let V=Badge;V=Blank}return <V/>}",true],
  ["closure reads outer","Panel","{let V=Badge;const Saved=()=> <V/>;V=Panel;return <Saved/>}",true],
  ["unknown branch","Badge","{let V=Panel;if(unknown){V=Badge}return <V/>}",false],
  ["reachable conditional","Panel","{if(false)return null; return <Panel/>}",true],
]) test("registered story export ownership: "+label,()=>{
  const flag="src/flags.ts", view="src/surface.tsx", story="src/surface.stories.tsx";
  const texts={
    [flag]:"export const PANEL_FLAG_KEY='panel';",
    [view]:"import {PANEL_FLAG_KEY} from './flags'; export function Panel(){return useFeatureFlagGate(PANEL_FLAG_KEY) ? <div/> : null} export function Short(){false && useFeatureFlagGate(PANEL_FLAG_KEY);return null} export const Attribute=()=> <div data-flag={useFeatureFlagGate(PANEL_FLAG_KEY)}/>; export function Badge(){return <span/>} export function Unused(){const inner=()=>useFeatureFlagGate(PANEL_FLAG_KEY);return <span/>} export function After(){return null;useFeatureFlagGate(PANEL_FLAG_KEY)} export function ShadowFlag(){const PANEL_FLAG_KEY=other;return useFeatureFlagGate(PANEL_FLAG_KEY)} export function LocalFlag(){const configured=PANEL_FLAG_KEY;return useFeatureFlagGate(configured)}",
    "src/frame.tsx":"export const Forward=(props)=><div>{props.children}</div>; export const Drop=()=>null;",
    "src/barrel.ts":"export {Panel as PublishedPanel, Badge as PublishedBadge} from './surface';",
    [story]:`import {Panel,Badge,Unused,After,ShadowFlag,LocalFlag,Short,Attribute} from './surface'; import {PublishedPanel,PublishedBadge} from './barrel';import {Forward,Drop} from './frame';const View=()=>null; const Wrapped=()=> <View/>;const Target=Panel;const Mounted=()=> <Target/>;const Blank=()=>null;const Pass=({children})=>children; export default {component:Panel}; export const On={parameters:{appCore:{enabledFlags:['panel']}}}; export const Off={render:()=>${body}};`
  };
  const found=findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts));
  assert.equal(found.some(f=>f.rule==="flag-story-arms"),!complete,component);
});

for(const layout of ["public alias","renamed hook","colocated"]) test("flag consumer ownership through " + layout,()=>{
  const flag="src/flag.tsx", view="src/panel.tsx", story="src/panel.stories.tsx";
  const texts={[flag]:"export const PANEL_FLAG_KEY='panel';","src/public.ts":"import {PANEL_FLAG_KEY} from './flag';export const PUBLIC_KEY=PANEL_FLAG_KEY;",
    [view]:"import {PUBLIC_KEY} from './public';export const Panel=()=>useFeatureFlagGate(PUBLIC_KEY);",
    [story]:"import {Panel} from './panel';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}}"};
  if(layout==="renamed hook") texts[view]="import {useFeatureFlagEnabled as useGate} from 'posthog-js/react';"+texts[view].replace("useFeatureFlagGate(","useGate(");
  if(layout==="colocated"){texts[flag]+="export const Panel=()=>useFeatureFlagGate(PANEL_FLAG_KEY)";delete texts[view]; texts[story]=texts[story].replace("./panel","./flag");}
  const found=findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts));
  assert.ok(found.some(f=>f.rule==="flag-story-arms"));
  texts[story]+=";export const Off={};";
  assert.deepEqual(findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts)),[]);
});

test("current release lists each displayed state after new with",()=>{
  const history="catalog/release.ts", story="catalog/table.stories.tsx";
  const texts={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"catalog/package.json",historyFiles:[history]}}),
    "catalog/package.json":'{"version":"1.0.0"}',[history]:"const entry={version:'1.0.0',notes:['Composites/Table: new, with Default, Single Level and Fixed Order. More detail.']};",
    [story]:"export default {title:'Composites/Table'};export const Default={};"};
  const check=()=>findings(checkStoryStateCoverage,[changed(history,"",texts[history])],repo({},texts)).filter(f=>f.rule==="storybook-history-state");
  assert.equal(check().length,2);
  texts[story]+="export const SingleLevel={name:'Single Level'};export const FixedOrder={name:'Fixed Order'};";
  assert.deepEqual(check(),[]);
});

for(const [label,decorators,condition,covered] of [
  ["function as JSX child","[Story=><div>{Story}</div>]","read()",false],
  ["returned function","[Story=>Story]","read()",false],
  ["forwarded helper argument","[Story=>localFrame(Story)]","read()",true],
  ["dropped helper argument","[Story=>drop(Story)]","read()",false],
  ["reassigned decorator","[reassigned]","read()",false],
  ["named decorator","[localFrame]","read()",true],
  ["imported decorator","[frame]","read()",true],
  ["aliased hook","[]","useRead()",true],
  ["dropping decorator","[()=>null]","read()",false],
  ["substituted decorator","[()=> <Panel/>]","read()",false],
  ["forwarding decorator","[Story=><Story/>]","read()",true],
  ["forwarding call","[Story=>Story()]","read()",true],
  ["negated imported hook","[]","!read()",true],
  ["irrelevant imported hook","[]","other()",false],
]) test("registered decorator and imported hook coverage "+label,()=>{
  const flag="src/flags.ts",view="src/view.tsx",story="src/view.stories.tsx";
  const texts={[flag]:"export const PANEL_FLAG_KEY='panel';","src/hook.ts":"import {PANEL_FLAG_KEY} from './flags';export const read=()=>useFeatureFlagEnabled(PANEL_FLAG_KEY); export const other=()=>false;",
    "src/frame.tsx":"export function frame(Story){return <div><Story/></div>}",
    [view]:"import {read,other} from './hook'; const useRead=read; export const Panel=()=>"+condition+" ? <div/> : null;",
    [story]:"import {Panel} from './view';import {frame} from './frame'; function localFrame(S){return <div><S/></div>} const drop=S=>null;let reassigned=localFrame;reassigned=drop; export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};export const Off={decorators:"+decorators+"};"};
  const actual=findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts));
  assert.equal(actual.some(f=>f.rule==="flag-story-arms"),!covered);
});

for (const [label, setup, off, expected] of [
  ["captured sibling","let Target=Badge;export default {component:Target};Target=Panel;", "export const Off={}",false],
  ["captured owner","let Target=Panel;export default {component:Target};Target=Badge;", "export const Off={}",true],
  ["replaced renderer","export default {component:Panel};","export const Off={render:()=> <Panel/>};Off.render=()=> <Badge/>",false],
  ["restored renderer","export default {component:Panel};","export const Off={render:()=> <Badge/>};Off.render=()=> <Panel/>",true],
  ...[true,false].flatMap(show=>[
    ["factory "+show,"export default {component:Panel};",`export const Off={args:{show:${show}},render:args=>{function choose(){if(args.show)return Panel;return Badge} const View=choose();return <View/>}}`,show],
    ["helper "+show,"export default {component:Panel};",`export const Off={args:{show:${show}},render:args=>{let View=Badge;function choose(){if(args.show){View=Panel}} choose();return <View/>}}`,show],
  ]),
  ["unknown factory choice","export default {component:Panel};","export const Off={render:()=>{const choose=()=>{if(unknown)return Panel;return Badge};const View=choose();return <View/>}}",false],
]) test("effective registered story "+label,()=>{
  const f="src/flags.ts", texts={[f]:"export const PANEL_FLAG_KEY='panel';",
    "src/view.tsx":"import {PANEL_FLAG_KEY} from './flags';export const Panel=()=>useFeatureFlagGate(PANEL_FLAG_KEY);export const Badge=()=>null;",
    "src/view.stories.tsx":"import {Panel,Badge} from './view';"+setup+"export const On={render:()=> <Panel/>,parameters:{appCore:{enabledFlags:['panel']}}};"+off};
  assert.equal(findings(checkStoryStateCoverage,[changed(f,null,texts[f])],repo({},texts)).some(x=>x.rule==="flag-story-arms"),!expected);
});
for (const scope of ["local","module"]) for (const subject of ["key","callee"]) for (const selected of [true,false]) test("executed flag binding "+scope+" "+subject+" "+selected,()=>{
  const f="src/flags.ts", start=selected?"other":subject==="key"?"PANEL_FLAG_KEY":"useGate", final=selected?(subject==="key"?"PANEL_FLAG_KEY":"useGate"):"other";
  const assignment="let live="+start+"; live="+final+";";
  const body="return "+(subject==="key"?"useGate(live)":"live(PANEL_FLAG_KEY)");
  const texts={[f]:"export const PANEL_FLAG_KEY='panel';","src/view.tsx":"import {PANEL_FLAG_KEY} from './flags';import {useFeatureFlagEnabled as useGate} from 'posthog-js/react';"+(scope==="module"?assignment:"")+"export function Panel(){"+(scope==="local"?assignment:"")+body+"}",
    "src/view.stories.tsx":"import {Panel} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}}"};
  assert.equal(findings(checkStoryStateCoverage,[changed(f,null,texts[f])],repo({},texts)).some(x=>x.rule==="flag-story-arms"),selected);
});

test("conditional and deferred consumers still require registered coverage",()=>{
  const flag="src/flags.ts",owner="src/view.tsx";
  for (const body of ["if(loaded)useFeatureFlagGate(PANEL_FLAG_KEY);return null",
    "return loaded && useFeatureFlagGate(PANEL_FLAG_KEY)",
    "const handler=()=>useFeatureFlagGate(PANEL_FLAG_KEY);return <button onClick={handler}/>"]) {
    const texts={[flag]:"export const PANEL_FLAG_KEY='panel';",
      [owner]:"import {PANEL_FLAG_KEY} from './flags';export function View(){"+body+"}"};
    assert.ok(findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts)).some(f=>f.rule==="flag-story-arms"),body);
  }
});

for(const [label,body,off,missing] of [
 ["deferred alias","{const key=PANEL_FLAG_KEY;const click=()=>useFeatureFlagGate(key);return <button onClick={click}/>}","",true],
 ["copied fields",null,"const base={render:()=> <Badge/>};export const Off={...base};base.render=()=> <Panel/>;",true],
 ["rebound reference",null,"export const Off={render:()=> <Badge/>};let other=Off;other={};other.render=()=> <Panel/>;",true],
 ["configured conjunction",null,"export const Off={args:{show:true},render:args=>args.show && <Panel/>};",false],
 ["configured negation",null,"export const Off={args:{show:false},render:args=>!args.show ? <Panel/> : <Badge/>};",false],
])test("registered coverage retains runtime bindings "+label,()=>{
 const flag="src/flag.ts",texts={[flag]:"export const PANEL_FLAG_KEY='panel';","src/view.tsx":"import {PANEL_FLAG_KEY} from './flag';export const Panel=()=>"+(body??"useFeatureFlagGate(PANEL_FLAG_KEY)")+";export const Badge=()=>null;","src/view.stories.tsx":"import {Panel,Badge} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+off};
 assert.equal(findings(checkStoryStateCoverage,[changed(flag,null,texts[flag])],repo({},texts)).some(f=>f.rule==="flag-story-arms"),missing);
});

for (const [label,handler,stories,missing] of [
  ["second captured key","const make=key=>()=>useFeatureFlagGate(key);const a=make('other'),b=make(PANEL_FLAG_KEY);return <button onBlur={a} onClick={b}/>","",true],
  ["named negative",null,"export const Off={args:{show:false},render:args=>{const hide=!args.show;return hide?<Panel/>:<Badge/>}}",false],
  ["replaced receiver",null,"export let Off={render:()=> <Panel/>};Off={render:()=> <Badge/>}",true],
  ["restored receiver",null,"export let Off={render:()=> <Badge/>};Off={render:()=> <Panel/>}",false],
  ["function annotations",null,"export function Off(){return <Panel/>} Off.parameters={appCore:{enabledFlags:['panel']}}",true],
  ["default boolean",null,"export const Off={render:({show=true})=>show?<Panel/>:<Badge/>}",false],
  ["explicit false",null,"export const Off={args:{show:false},render:({show=true})=>show?<Panel/>:<Badge/>}",true],
]) test("registered story activation "+label,()=>{
  const flag="src/flags.ts";
  const files={[flag]:"export const PANEL_FLAG_KEY='panel';","src/view.tsx":"import {PANEL_FLAG_KEY} from './flags';export function Panel(){"+(handler??"return useFeatureFlagGate(PANEL_FLAG_KEY)")+"};export const Badge=()=>null;"};
  if(stories) files["src/view.stories.tsx"]="import {Panel,Badge} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+stories;
  assert.equal(findings(checkStoryStateCoverage,[changed(flag,null,files[flag])],repo({},files)).some(entry=>entry.rule==="flag-story-arms"),missing);
});

for (const [label,selected,off,missing] of [
  ["conditional replacement","FlagView","export let Off={render:()=> <FlagView/>};if(true) Off={render:()=> <Badge/>}",true],
  ["skipped replacement","FlagView","export let Off={render:()=> <FlagView/>};if(false) Off={render:()=> <Badge/>}",false],
  ["uncertain replacement","FlagView","export let Off={render:()=> <FlagView/>};if(unresolved) Off={render:()=> <Badge/>}",true],
  ["reassigned component","Panel","export const Off={}",true],
  ["render method","FlagView","export const Off={render(){return <FlagView/>}}",false],
]) test("live module bindings "+label,()=>{
  const f="src/flag.ts",files={[f]:"export const PANEL_FLAG_KEY='panel';",
    "src/view.tsx":"import {PANEL_FLAG_KEY} from './flag';export const FlagView=()=>useFeatureFlagGate(PANEL_FLAG_KEY);export const Badge=()=>null;export let Panel=FlagView;Panel=Badge;",
    "src/view.stories.tsx":"import {FlagView,Badge,Panel} from './view';export default {component:"+selected+"};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+off};
  assert.equal(findings(checkStoryStateCoverage,[changed(f,null,files[f])],repo({},files)).some(v=>v.rule==="flag-story-arms"),missing);
});

test("history names follow the final story receiver",()=>{
  const h="catalog/release.ts",s="catalog/table.stories.tsx";
  for(const [name,missing] of [["Old",true],["Current",false]]){
    const files={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"catalog/package.json",historyFiles:[h]}}),
      "catalog/package.json":'{"version":"1.0.0"}',[h]:"const entry={version:'1.0.0',notes:['Composites/Table: new "+name+" story']};",
      [s]:"export default {title:'Composites/Table'};export let Example={name:'Old'};Example={name:'Current'}"};
    assert.equal(findings(checkStoryStateCoverage,[changed(h,null,files[h])],repo({},files)).some(v=>v.rule==="storybook-history-state"),missing);
  }
});

for(const [label,off,missing] of [
  ["closure replacement","let View=Panel;if(true) View=Badge;export const Off={render(){return <View/>}}",true],
  ["closure restoration","let View=Badge;if(true) View=Panel;export const Off={render(){return <View/>}}",false],
  ["nested receiver","export const Off={parameters:{appCore:{enabledFlags:[]}}};Off.parameters.appCore.enabledFlags=['panel']",true],
  ["nested receiver restored","export const Off={parameters:{appCore:{enabledFlags:['panel']}}};Off.parameters.appCore.enabledFlags=[]",false],
]) test("mounted story reads current fields "+label,()=>{
  const f="src/flag.ts",files={[f]:"export const PANEL_FLAG_KEY='panel';",
    "src/view.tsx":"import {PANEL_FLAG_KEY} from './flag';export const Panel=()=>useFeatureFlagGate(PANEL_FLAG_KEY);export const Badge=()=>null;",
    "src/view.stories.tsx":"import {Panel,Badge} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+off};
  assert.equal(findings(checkStoryStateCoverage,[changed(f,null,files[f])],repo({},files)).some(x=>x.rule==="flag-story-arms"),missing);
});

for(const [label,definition] of [
  ["object copy","export const Example={name:'Old'};Object.assign(Example,{name:'Current'})"],
  ["block scope","const label='Old';export let Example={name:label};{const label='Current';Example={name:label}}"],
]) test("history reads evaluated metadata "+label,()=>{
  const h="catalog/release.ts",s="catalog/table.stories.tsx";
  for(const [name,missing] of [["Old",true],["Current",false]]){
    const files={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"catalog/package.json",historyFiles:[h]}}),
      "catalog/package.json":'{"version":"1.0.0"}',[h]:"const entry={version:'1.0.0',notes:['Composites/Table: new "+name+" story']};",
      [s]:"export default {title:'Composites/Table'};"+definition};
    assert.equal(findings(checkStoryStateCoverage,[changed(h,null,files[h])],repo({},files)).some(v=>v.rule==="storybook-history-state"),missing);
  }
});

for(const [label,off,missing] of [
  ["method lexical scope","const View=Panel;export let Off={render(){return <View/>}};if(true){const View=Badge;Off={render(){return <View/>}}}",true],
  ["closure lexical scope","const Target=Panel;let View;if(true){const Target=Badge;View=()=> <Target/>}export const Off={render:()=> <View/>}",true],
]) test("story activation keeps lexical module scope "+label,()=>{
  const f="src/flag.ts",files={[f]:"export const PANEL_FLAG_KEY='panel';",
    "src/view.tsx":"import {PANEL_FLAG_KEY} from './flag';export const Panel=()=>useFeatureFlagGate(PANEL_FLAG_KEY);export const Badge=()=>null;",
    "src/view.stories.tsx":"import {Panel,Badge} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+off};
  assert.equal(findings(checkStoryStateCoverage,[changed(f,null,files[f])],repo({},files)).some(x=>x.rule==="flag-story-arms"),missing);
});

for(const [label,definition,expected] of [
 ["snapshot restore","export const Example={name:'Current'};const saved={...Example};Example.name='Temporary';Object.assign(Example,saved)","Current"],
 ["initializer copy","export const Example={name:'Old'};const updated=Object.assign(Example,{name:'Current'})","Current"],
 ["module var","var label='Old';{var label='Current'}export const Example={name:label}","Current"],
]) test("history reads snapshot and execution order "+label,()=>{
  const h="catalog/release.ts",s="catalog/table.stories.tsx";
  const files={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"catalog/package.json",historyFiles:[h]}}),
    "catalog/package.json":'{"version":"1.0.0"}',[h]:"const entry={version:'1.0.0',notes:['Composites/Table: new "+expected+" story']};",
    [s]:"export default {title:'Composites/Table'};"+definition};
  assert.ok(!findings(checkStoryStateCoverage,[changed(h,null,files[h])],repo({},files)).some(v=>v.rule==="storybook-history-state"));
});

for (const [label,definition] of [
  ["transparent wrapper","export const Example={name:'Old'}; const result=(Object.assign(Example,{name:'Current'}))"],
  ["type wrapper","export const Example={name:'Old'}; const result=Object.assign(Example,{name:'Current'}) satisfies {name:string}"],
  ["nested argument","export const Example={name:'Old'}; const result=Object.assign({},Object.assign(Example,{name:'Current'}))"],
  ["assignment operand","export const Example={name:'Old'}; let result;result=Object.assign(Example,{name:'Current'})"],
  ["nested property assignment","export const Example={name:'Old'};const saved=(Example.name='Current')"],
  ["wrapped assignment statement","export const Example={name:'Old'};(Example.name='Current')"],
  ["assignment argument","export const Example={name:'Old'};let saved;Object.assign({},saved=Object.assign(Example,{name:'Current'}))"],
  ["method receiver","export const Example={name:'Old'};Object.assign(Example,{name:'Current'}).valueOf()"],
  ["conditional operand","export const Example={name:'Old'};true ? (Example.name='Current') : (Example.name='Wrong')"],
  ["short circuit operand","export const Example={name:'Old'};true && (Example.name='Current');false && (Example.name='Wrong')"],
  ["sequenced operands","export const Example={name:'Old'};(Example.name='Wrong',Example.name='Current')"],
  ["second declared export","export const First={},Example={name:'Current'}"],
  ["public alias","const Example={name:'Old'};const Defined={name:'Current'};export {Defined as Example}"],
  ["bare declaration","var label='Current';{var label;}export const Example={name:label}"],
]) test("registered story identity after evaluated operand "+label,()=>{
  const h="catalog/release.ts",s="catalog/table.stories.tsx";
  for(const [name,missing] of [["Old",true],["Current",false]]){
    const files={".vibe/storybook-rules.json":JSON.stringify({release:{versionFile:"catalog/package.json",historyFiles:[h]}}),
      "catalog/package.json":'{"version":"1.0.0"}',[h]:"const entry={version:'1.0.0',notes:['Composites/Table: new "+name+" story']};",
      [s]:"export default {title:'Composites/Table'};"+definition};
    assert.equal(findings(checkStoryStateCoverage,[changed(h,null,files[h])],repo({},files)).some(v=>v.rule==="storybook-history-state"),missing);
  }
});

for(const [label,story] of [
 ["helper closure",(a,b)=>"const View="+a+";export let Off={};{const View="+b+";const helper=()=> <View/>;Off={render:()=>helper()}}"],
 ["nested captured cell",(a,b)=>"export let Off={};{let View="+a+";const swap=()=>{View="+b+"};{Off={render:()=>{swap();return <View/>}}}}"],
 ["omitted argument",(a,b)=>"export const Off={render(){function show(View="+b+"){return <View/>}return show()}}"],
 ["explicit undefined argument",(a,b)=>"export const Off={render(){function show(View="+b+"){return <View/>}return show(undefined)}}"],
 ["supplied argument",(a,b)=>"export const Off={render(){function show(View="+a+"){return <View/>}return show("+b+")}}"],
 ["module var",(a,b)=>"var View="+a+";{var View="+b+"}export const Off={render:()=> <View/>}"],
 ["function var",(a,b)=>"export const Off={render(){var View="+a+";{var View="+b+"}return <View/>}}"],
]) test("registered render uses effective variable cells "+label,()=>{
  for(const [outer,inner,missing] of [["Panel","Badge",true],["Badge","Panel",false]]){
    const f="src/flag.ts", files={[f]:"export const PANEL_FLAG_KEY='panel';",
      "src/view.tsx":"import {PANEL_FLAG_KEY} from './flag';export const Panel=()=>useFeatureFlagGate(PANEL_FLAG_KEY);export const Badge=()=>null;",
      "src/view.stories.tsx":"import {Panel,Badge} from './view';export default {component:Panel};export const On={parameters:{appCore:{enabledFlags:['panel']}}};"+story(outer,inner)};
    assert.equal(findings(checkStoryStateCoverage,[changed(f,null,files[f])],repo({},files)).some(x=>x.rule==="flag-story-arms"),missing);
  }
});
