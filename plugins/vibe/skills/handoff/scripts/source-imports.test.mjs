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
