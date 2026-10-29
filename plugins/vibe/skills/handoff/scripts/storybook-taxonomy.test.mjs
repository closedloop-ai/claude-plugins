import assert from "node:assert/strict";
import test from "node:test";
import { storyExportNames } from "./storybook-taxonomy.mjs";

// ISS-13317: ISS-13167's run listed a story `branch-files-changed-panel--truthful` that does not exist; it came from
// `export const truthful` inside a diff fixture string in branch-files-changed-panel.stories.tsx.
test("story names come from real top-level exports, never from text inside strings, templates or comments", () => {
  const source = [
    "const PATTERN = /[\"'`]export const InRegex/;",
    "const fixture = { oldContent: \"export const truthful = false;\\n\", newContent: 'export const Single = 1;' };",
    "const template = `",
    "export const InTemplate = 1;",
    "${`export const Nested = ${fixture.oldContent}`}",
    "export { InTemplateList };",
    "`;",
    "// export const InLineComment = 1;",
    "/* export const InBlockComment = 1; */",
    "export default { title: \"Composites v1.0/Panel\" };",
    "export const LoadedCollapsed = { args: { text: `export const AlsoNot = ${1}` } };",
    "const ratio = 4 / 2; export const AfterDivision = {};",
    "export const Loading = {};",
    "const Hidden = {};",
    "export { Hidden as Renamed };",
  ].join("\n");
  assert.deepEqual(storyExportNames(source), ["AfterDivision", "LoadedCollapsed", "Loading", "Renamed"]);
});
