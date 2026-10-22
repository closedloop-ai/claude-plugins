import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkStorybookRules, readStorybookRules, STORYBOOK_RULES_FILE, storybookRuleTests } from "./storybook-rules.mjs";

// The example declaration is the one symphony-alpha uses, so the fixtures below
// are the shapes its merged pull requests produced (#8953, #8959, #8960, #8962, #8963).
const EXAMPLE = readFileSync(new URL("../references/storybook-rules.example.json", import.meta.url), "utf8");
const VERSION_FILE = "apps/storybook/package.json";
const HISTORY = "apps/storybook/stories/start-here-version-history.stories.tsx";

const story = ({ title, tags = ["stable"], component = "Thing", extra = "", exports = ["Default"] }) => [
  "const meta = {",
  `  title: "${title}",`,
  `  tags: ${JSON.stringify(tags)},`,
  ...(component ? [`  component: ${component},`] : []),
  extra,
  "};",
  "export default meta;",
  ...exports.map((name) => `export const ${name}: Story = {};`),
].join("\n");
const pkg = (version) => JSON.stringify({ name: "storybook", version });
const history = (...versions) => `const RELEASES = [\n${versions.map((version) => `  { version: "${version}" },`).join("\n")}\n];\n`;

/** Each file as fully added, removed or modified, with every head line counted as added. */
function diff(base, head) {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((file) => base[file] !== head[file]);
  return paths.map((file) => {
    const status = !(file in base) ? "A" : !(file in head) ? "D" : "M";
    const before = (base[file] ?? "").split("\n");
    const after = (head[file] ?? "").split("\n");
    return {
      path: file,
      oldPath: status === "A" ? null : file,
      status,
      added: status === "D" ? [] : after.map((text, index) => ({ line: index + 1, text })).filter((entry) => !before.includes(entry.text)),
      removed: before.map((text, index) => ({ line: index + 1, text })).filter((entry) => status === "D" || !after.includes(entry.text)),
    };
  });
}

function run({ base = {}, head = {}, config = EXAMPLE, changeLog = "" }) {
  const withConfig = config === null ? head : { [STORYBOOK_RULES_FILE]: config, ...head };
  const baseFiles = { ...(config === null ? {} : { [STORYBOOK_RULES_FILE]: config }), ...base };
  const files = diff(baseFiles, withConfig);
  const repo = {
    head: (file) => withConfig[file] ?? null,
    base: (file) => baseFiles[file] ?? null,
    headFiles: Object.keys(withConfig),
    baseFiles: new Set(Object.keys(baseFiles)),
  };
  const findings = [];
  const logged = (prefix, file) => changeLog.split("\n").some((line) => line.includes(prefix) && (file === undefined || line.includes(file)));
  checkStorybookRules(files, repo, logged, (rule, file, line, problem, fix) => findings.push({ rule, file, line, problem, fix }));
  return { findings, rules: findings.map((finding) => finding.rule), tests: storybookRuleTests(files, repo.head).map((entry) => entry.path) };
}

const released = (version, extra = {}) => ({ [VERSION_FILE]: pkg(version), [HISTORY]: history(version, "4.0.0"), ...extra });

test("(a) new stories with no bump, and a release record that reuses a version, block (#8953)", () => {
  const entry = "apps/storybook/stories/grid-interaction-contract.stories.tsx";
  const base = { [VERSION_FILE]: pkg("4.0.1"), [HISTORY]: history("4.0.1", "4.0.0") };
  const result = run({ base, head: { ...base, [HISTORY]: history("4.0.1", "4.0.1", "4.0.0"), [entry]: story({ title: "Primitives/Data Display/Grid Interaction Contract", extra: "  argTypes: {}," }) } });
  assert.deepEqual(result.rules, ["storybook-release", "storybook-release"]);
  assert.match(result.findings[0].problem, /adds the entries Primitives\/Data Display\/Grid Interaction Contract with no release \(version stays 4\.0\.1\)/);
  assert.match(result.findings[1].problem, /reuses 4\.0\.1/);
  const fixed = run({ base, head: { ...released("4.1.0"), [HISTORY]: history("4.1.0", "4.0.1", "4.0.0"), [entry]: story({ title: "Primitives/Data Display/Grid Interaction Contract", extra: "  argTypes: {}," }) } });
  assert.deepEqual(fixed.rules, []);
});

test("(a) a removed story needs a major, a new entry a minor, a story on an existing entry a patch (#8963)", () => {
  const file = "packages/app/documents/components/table/documents-view.stories.tsx";
  const title = "Composites/Shared/Artifact List/Documents View";
  const before = { ...released("4.0.1"), [HISTORY]: history("4.0.1"), [file]: story({ title, extra: "  argTypes: {},", exports: ["Default", "Narrow"] }) };
  const removal = { ...before, [VERSION_FILE]: pkg("4.0.2"), [HISTORY]: history("4.0.2", "4.0.1"), [file]: story({ title, extra: "  argTypes: {},", exports: ["Default"] }) };
  const patch = run({ base: before, head: removal });
  assert.deepEqual(patch.rules, ["storybook-release"]);
  assert.match(patch.findings[0].problem, /removes or renames .*Documents View › Narrow, which needs a major release, but 4\.0\.1 -> 4\.0\.2 is a patch/);
  assert.deepEqual(run({ base: before, head: { ...removal, [VERSION_FILE]: pkg("5.0.0"), [HISTORY]: history("5.0.0", "4.0.1") } }).rules, []);
  const added = { ...before, [VERSION_FILE]: pkg("4.0.2"), [HISTORY]: history("4.0.2", "4.0.1"), [file]: story({ title, extra: "  argTypes: {},", exports: ["Default", "Narrow", "Dark"] }) };
  assert.deepEqual(run({ base: before, head: added }).rules, []);
  const promoted = { ...added, [file]: story({ title, tags: ["preview"], extra: "  argTypes: {},", exports: ["Default", "Narrow"] }) };
  assert.match(run({ base: before, head: promoted, config: JSON.stringify({ release: JSON.parse(EXAMPLE).release }) }).findings[0].problem, /changes a lifecycle tag, which needs a minor release/);
  assert.match(run({ base: before, head: { ...added, [HISTORY]: history("4.0.1") } }).findings[0].problem, /0 entries for 4\.0\.2/);
  assert.deepEqual(run({ base: before, head: removal, changeLog: "Storybook release ruling: operator, 2026-10-21, keep the patch" }).rules, []);
});

test("(b) new stories under a frozen root block; a touched frozen story with the same exports does not (#8959)", () => {
  const file = "apps/storybook/stories/inline-scalar-cell.stories.tsx";
  const title = "Composites v1.0/Data Display/Inline Scalar Cell";
  const base = { ...released("3.2.8"), [file]: story({ title, tags: ["deprecated"], extra: "  argTypes: {}," }) };
  const grown = run({ base, head: { ...released("3.2.9"), [HISTORY]: history("3.2.9", "3.2.8"), [file]: story({ title, tags: ["deprecated"], extra: "  argTypes: {},", exports: ["Default", "Empty", "ReadOnly"] }) } });
  assert.deepEqual(grown.rules, ["frozen-story-added"]);
  assert.match(grown.findings[0].problem, /adds Empty, ReadOnly under the frozen Composites v1\.0/);
  assert.deepEqual(run({ base, head: { ...base, [file]: `${base[file]}\n// a comment` } }).rules, []);
});

test("(c) an edit handler wired to a no-op blocks; a non-edit handler and Desktop Shell stories do not (#8960)", () => {
  const file = "packages/app/documents/components/table/documents-view.stories.tsx";
  const title = "Composites/Shared/Artifact List/Documents View";
  const base = { ...released("4.0.1"), [file]: story({ title, extra: "  argTypes: {}," }) };
  const edit = run({ base, head: { ...base, [file]: `${base[file]}\nexport const Editing: Story = { args: { editHandlers: { onUpdatePriority: () => undefined } } };`, [VERSION_FILE]: pkg("4.0.2"), [HISTORY]: history("4.0.2", "4.0.1") } });
  assert.deepEqual(edit.rules, ["story-no-op-handler"]);
  const other = run({ base, head: { ...base, [file]: `${base[file]}\n// <List onRetry={() => undefined} onOpenArtifact={() => undefined} />` } });
  assert.deepEqual(other.rules, []);
  const frozen = "apps/storybook/stories/inline-scalar-cell.stories.tsx";
  const restored = story({ title: "Composites v1.0/Data Display/Inline Scalar Cell", tags: ["deprecated"], extra: "  args: { onCommit: () => undefined }," });
  const edited = restored.replace("onCommit: () => undefined", "onCommit: fn()");
  assert.deepEqual(run({ base: { [frozen]: edited }, head: { [frozen]: restored } }).rules, [], "a frozen file restored to its earlier bytes keeps its no-op handlers (#9102)");
  const desktop = "apps/desktop/src/renderer/components/shell.stories.tsx";
  assert.deepEqual(run({ base: { [desktop]: "x" }, head: { [desktop]: "x\nconst onToggleSidebar = () => undefined;" } }).rules, []);
});

test("(d) hand-rolled table rows and raw renderCell fields block; the canonical cells do not (#8953, #8962)", () => {
  const file = "apps/storybook/stories/grid-interaction-contract.stories.tsx";
  const base = { [file]: story({ title: "Primitives/Data Display/Grid Interaction Contract", extra: "  argTypes: {}," }) };
  const rolled = run({ base, head: { [file]: `${base[file]}\nconst Wide = () => <table className="w-full" role="grid"><tr><td>{row.name}</td></tr></table>;\nconst Narrow = () => <GridTableV2 renderCell={(_c, row) => row.name} />;` } });
  assert.deepEqual(rolled.rules, ["story-hand-rolled-cell", "story-hand-rolled-cell"]);
  assert.match(rolled.findings[0].problem, /hand-rolls a table row or cell/);
  const canonical = run({ base, head: { [file]: `${base[file]}\nconst Narrow = () => <GridTableV2 renderCell={(_c, row) => <TableTextCell value={row.name} />} />;\nconst found = row.closest('[role="row"]');` } });
  assert.deepEqual(canonical.rules, []);
});

test("(e) a new or touched story naming a component needs a controls decision whatever the allowlist says (#8959)", () => {
  const file = "packages/app/agents/components/sessions/session-inline-rename.stories.tsx";
  const title = "Composites/Artifacts/Sessions/Sessions List/Session Inline Rename";
  const base = { [file]: story({ title }) };
  const touched = run({ base, head: { [file]: `${base[file]}\nconst helper = 1;` } });
  assert.deepEqual(touched.rules, ["story-controls-decision"]);
  assert.match(touched.findings[0].problem, /no controls decision/);
  assert.match(touched.findings[0].fix, /an entry in scripts\/lint\/source-gate-allowlist\.json does not count/);
  assert.deepEqual(run({ base, head: { [file]: `// No controls: a composed fixture.\n${base[file]}` } }).rules, []);
  assert.deepEqual(run({ base, head: { [file]: story({ title, extra: "  argTypes: { state: { control: \"select\", options: [\"a\"] } }," }) } }).rules, []);
  const frozen = "apps/storybook/stories/old.stories.tsx";
  assert.deepEqual(run({ base: { [frozen]: story({ title: "Composites v1.0/Old", tags: ["deprecated"] }) }, head: { [frozen]: `${story({ title: "Composites v1.0/Old", tags: ["deprecated"] })}\n// touched` } }).rules, []);
  assert.deepEqual(run({ base: { [file]: story({ title, component: null }) }, head: { [file]: `${story({ title, component: null })}\nconst x = 1;` } }).rules, []);
});

test("(f) a lifecycle tag outside the roots it is declared for blocks (#8953)", () => {
  const file = "apps/storybook/stories/grid-row-drag-handle.stories.tsx";
  const base = { [file]: story({ title: "Primitives/Data Display/Grid Row Drag Handle", extra: "  argTypes: {}," }) };
  const preview = run({ base, head: { [file]: story({ title: "Primitives/Data Display/Grid Row Drag Handle", tags: ["preview"], extra: "  argTypes: {}," }) }, config: JSON.stringify({ tagRoots: { preview: "(?:^|/)Labs(?:/|$)" } }) });
  assert.deepEqual(preview.rules, ["story-tag-root"]);
  const storyTag = run({ base, head: { [file]: `${base[file]}\nexport const Composed: Story = { tags: ["!stable", "preview"] };` }, config: JSON.stringify({ tagRoots: { preview: "(?:^|/)Labs(?:/|$)" } }) });
  assert.deepEqual(storyTag.rules, ["story-tag-root"]);
  const labs = "packages/app/agents/components/workspace/agent-detail.stories.tsx";
  assert.deepEqual(run({ base: { [labs]: "" }, head: { [labs]: story({ title: "Surfaces/Labs/Agents/Agent Detail", tags: ["preview"], extra: "  argTypes: {}," }) }, config: JSON.stringify({ tagRoots: { preview: "(?:^|/)Labs(?:/|$)" } }) }).rules, []);
});

test("(g) a control's computed options block; a literal list does not (#8953)", () => {
  const file = "apps/storybook/stories/grid-interaction-contract.stories.tsx";
  const config = JSON.stringify({ literalOptions: true });
  const base = { [file]: story({ title: "Primitives/Data Display/Grid Interaction Contract", extra: "  argTypes: {}," }) };
  const computed = (value) => run({ base, head: { [file]: base[file].replace("  argTypes: {},", `  argTypes: {\n    state: {\n      control: "select",\n      options: ${value},\n    },\n  },`) }, config });
  assert.deepEqual(computed("POINTER_CONTRACT_STATES").rules, ["story-computed-options"]);
  assert.deepEqual(computed("Object.values(ArtifactBoardMutationState)").rules, ["story-computed-options"]);
  assert.deepEqual(computed("[...STATES]").rules, ["story-computed-options"]);
  assert.deepEqual(computed('["idle", "hover"]').rules, []);
  assert.deepEqual(computed('[\n        "idle",\n      ]').rules, []);
  const prop = run({ base, head: { [file]: `${base[file]}\nexport const WithOptions: Story = { args: { options: fixtureOptions } };` }, config });
  assert.deepEqual(prop.rules, []);
  assert.deepEqual(computed('{ control: false }').rules, []);
});

test("(g) only a list control's options under argTypes count, never a prop named options or an args value (#9102)", () => {
  const file = "apps/storybook/stories/composites-v2/v2-inline-select-cell.stories.tsx";
  const config = JSON.stringify({ literalOptions: true });
  const meta = (valueOptions) => [
    "// No controls: n/a",
    "const meta = {",
    "  title: \"Composites/Shared/Artifact List/Inline Select Cell\",",
    "  component: InlineSelectCell,",
    "  argTypes: {",
    "    label: { control: \"text\", options: LABELS },",
    "    value: {",
    "      control: \"select\",",
    `      options: ${valueOptions},`,
    "    },",
    "    options: { control: false },",
    "    readOnly: { control: { type: \"radio\" }, options: READ_ONLY },",
    "  },",
    "  args: {",
    "    value: \"urgent\",",
    "    options: PRIORITIES,",
    "    filter: { control: \"select\", options: FILTERS },",
    "  },",
    "};",
  ].join("\n");
  const real = run({ base: { [file]: "" }, head: { [file]: meta("[...PRIORITIES.map((option) => option.value)]") }, config });
  assert.deepEqual(real.findings.map((finding) => [finding.rule, finding.line]), [["story-computed-options", 9], ["story-computed-options", 12]]);
  const fixed = run({ base: { [file]: "" }, head: { [file]: meta('["urgent", "high"]').replace("options: READ_ONLY", 'options: ["yes", "no"]') }, config });
  assert.deepEqual(fixed.rules, []);
});

test("(h) a story-local copy of a component the diff deletes blocks (#8962)", () => {
  const gone = "packages/design-system/components/ui/grid-table-v2-card-list.tsx";
  const copy = "apps/storybook/stories/support/frozen-grid-table-v2-card-list.tsx";
  const renamedCopy = "apps/storybook/stories/support/card-list-fixture.tsx";
  const base = { [gone]: "export function GridTableV2CardList() { return null; }\n" };
  const kept = run({ base, head: { [copy]: "export function FrozenCardList() { return null; }\n" } });
  assert.deepEqual(kept.rules, ["story-local-copy"]);
  assert.match(kept.findings[0].problem, /story-local copy of the deleted packages\/design-system\/components\/ui\/grid-table-v2-card-list\.tsx/);
  assert.deepEqual(run({ base, head: { [renamedCopy]: "function GridTableV2CardList() { return null; }\n" } }).rules, ["story-local-copy"]);
  assert.deepEqual(run({ base, head: { [renamedCopy]: "export const rows = [];\n" } }).rules, []);
  assert.deepEqual(run({ base, head: { [copy]: "x\n" }, changeLog: `Story copy: ${copy}: operator ruling, 2026-10-21` }).rules, []);
});

test("the repo's Storybook checks are required when a story or a listed path changes", () => {
  const checks = JSON.parse(EXAMPLE).checks.map((check) => check.command);
  const file = "apps/storybook/stories/a.stories.tsx";
  assert.deepEqual(run({ base: { [file]: "" }, head: { [file]: "// No controls: x" } }).tests, checks);
  assert.deepEqual(run({ base: { "packages/design-system/components/ui/chip.tsx": "a" }, head: { "packages/design-system/components/ui/chip.tsx": "b" } }).tests, checks.slice(0, 2));
  assert.deepEqual(run({ base: { "apps/app/page.tsx": "a" }, head: { "apps/app/page.tsx": "b" } }).tests, []);
});

test("no declaration runs nothing; a broken one blocks instead of silently running nothing", () => {
  const file = "apps/storybook/stories/a.stories.tsx";
  assert.deepEqual(run({ base: { [file]: "" }, head: { [file]: story({ title: "Composites v1.0/A", tags: ["deprecated"], exports: ["New"] }) }, config: null }), { findings: [], rules: [], tests: [] });
  assert.deepEqual(run({ base: { [file]: "" }, head: { [file]: "x" }, config: "{nope" }).rules, ["storybook-rules"]);
  assert.match(readStorybookRules(() => JSON.stringify({ noOpHandler: { pattern: "(" } })).problem, /cannot be used/);
});
