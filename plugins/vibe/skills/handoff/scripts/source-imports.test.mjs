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

test("Sass @import reads every list item, including bare indented URLs, without promoting CSS media imports", () => {
  const scss = "apps/storybook/.storybook/preview.scss";
  const sass = "apps/storybook/.storybook/preview.sass";
  assert.deepEqual(importSpecifiers(scss, [
    '@import "first", "second";',
    '@import url("local.css") screen;',
    '@import "layout" screen;',
    '@import url(remote);',
    '@import "https://example.com/font.css";',
    '// @import "commented";',
    '.example::before { content: "@import \\"quoted\\""; }',
  ].join("\n")), ["first", "second", "local.css", "https://example.com/font.css"]);
  assert.deepEqual(importSpecifiers(sass, '@import first, second\n// @import missing\n@import "third", fourth'),
    ["first", "second", "third", "fourth"]);
  assert.deepEqual(importSpecifiers(scss, '@import "first", /* between items */ "second";\n@use "third";'),
    ["first", "second", "third"]);
  assert.deepEqual(importSpecifiers(scss, '@import "first", // between items\n "second";\n@use "third";'),
    ["first", "second", "third"]);
  assert.deepEqual(importSpecifiers(sass, '@import first, second // after the list\n@use "third"'),
    ["first", "second", "third"]);
  const files = new Set([
    "apps/storybook/.storybook/_first.scss",
    "apps/storybook/.storybook/_second.scss",
    "apps/storybook/.storybook/local.css",
    "apps/storybook/.storybook/_local.css",
  ]);
  assert.equal(resolveImport(scss, "first", files), "apps/storybook/.storybook/_first.scss");
  assert.equal(resolveImport(scss, "second", files), "apps/storybook/.storybook/_second.scss");
  assert.equal(resolveImport(scss, "local.css", files), "apps/storybook/.storybook/local.css");
  assert.equal(resolveImport(scss, "https://example.com/font.css", files), undefined);
});
