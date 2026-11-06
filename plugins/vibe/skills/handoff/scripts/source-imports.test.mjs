import assert from "node:assert/strict";
import test from "node:test";
import { importSpecifiers, resolveImport } from "./source-imports.mjs";

test("executable JavaScript imports exclude comments and quoted examples", () => {
  const source = [
    'import "./side.css";',
    'import { value } from "./value";',
    'export { value } from "./other";',
    'const lazy = import("./lazy");',
    'const example = \'import "./unused.css"\';',
    'const multiline = `example\nimport "./also-unused.css"`;',
    'const interpolation = `${import("./inside")}`;',
    'const pattern = /import "\\.\\/regex-unused\\.css"/;',
    '// import "./commented.css";',
    '/* import "./blocked.css"; */',
  ].join("\n");
  assert.deepEqual(importSpecifiers("apps/storybook/.storybook/preview.tsx", source),
    ["./side.css", "./value", "./other", "./lazy", "./inside"]);
});

test("CSS imports include quoted and url forms without reading comments or declaration strings", () => {
  const source = [
    '@import url("nested.css") screen;',
    "@import url('../other.css') layer(ui);",
    "@import url(plain.css);",
    '@import "./quoted.css";',
    '/* @import url("./commented.css"); */',
    '.example::before { content: "@import url(\\"./unused.css\\")"; }',
  ].join("\n");
  assert.deepEqual(importSpecifiers("apps/storybook/.storybook/preview.css", source),
    ["nested.css", "../other.css", "plain.css", "./quoted.css"]);
  const files = new Set(["apps/storybook/.storybook/nested.css", "apps/storybook/other.css", "apps/storybook/.storybook/plain.css", "apps/storybook/.storybook/quoted.css"]);
  assert.equal(resolveImport("apps/storybook/.storybook/preview.css", "nested.css", files), "apps/storybook/.storybook/nested.css");
  assert.equal(resolveImport("apps/storybook/.storybook/preview.css", "nested.css?version=1", files), "apps/storybook/.storybook/nested.css");
  assert.equal(resolveImport("apps/storybook/.storybook/preview.css", "../other.css", files), "apps/storybook/other.css");
  assert.equal(resolveImport("apps/storybook/.storybook/preview.css", "plain.css", files), "apps/storybook/.storybook/plain.css");
  assert.equal(resolveImport("apps/storybook/.storybook/preview.css", "https://example.com/nested.css", files), undefined);
});

test("Sass @use and @forward resolve local partials and directory indexes without reading comments", () => {
  const from = "apps/storybook/.storybook/preview.scss";
  assert.deepEqual(importSpecifiers(from, [
    '@use "palette" as colors;',
    '@forward "themes" show theme;',
    '// @use "unused";',
    '/* @forward "blocked"; */',
    '.example::before { content: "@use \\"text\\""; }',
  ].join("\n")), ["palette", "themes"]);
  assert.deepEqual(importSpecifiers("apps/storybook/.storybook/preview.sass", '@use "palette"\n// @forward "unused"\n@forward "themes"'),
    ["palette", "themes"]);
  const files = new Set([
    "apps/storybook/.storybook/_palette.scss",
    "apps/storybook/.storybook/themes/_index.scss",
    "apps/storybook/.storybook/explicit.sass",
  ]);
  assert.equal(resolveImport(from, "palette", files), "apps/storybook/.storybook/_palette.scss");
  assert.equal(resolveImport(from, "themes", files), "apps/storybook/.storybook/themes/_index.scss");
  assert.equal(resolveImport(from, "explicit.sass", files), "apps/storybook/.storybook/explicit.sass");
  assert.equal(resolveImport(from, "sass:color", files), undefined);
  assert.throws(() => resolveImport(from, "palette", new Set([...files, "apps/storybook/.storybook/palette.scss"])), /ambiguous Sass module/);
});
