import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { runDiffRules, storyId } from "./diff-rules.mjs";
import { frozenInputs } from "./frozen-render.mjs";
import { isFrozenStory, run } from "./diff-rules-test-fixture.mjs";
import { PROVIDER_BINDING } from "../../vibe/scripts/test-fixtures.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

test("component styles stay in their story closure while preview styles reach every frozen story (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const componentCss = "packages/design-system/components/first.css";
  const previewCss = "apps/storybook/.storybook/preview.css";
  const base = {
    [first]: "import { First } from \"@repo/design-system/components/first\";\nexport default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    "packages/design-system/components/first.tsx": "import \"./first.css\";\nexport const First = 1;\n",
    [componentCss]: ".first { color: red; }\n",
    "apps/storybook/.storybook/preview.tsx": "import \"./shared\";\n",
    "apps/storybook/.storybook/shared.ts": "import \"./preview.css\";\n",
    [previewCss]: ":root { color: red; }\n",
    "packages/design-system/components/unrelated.css": ".unrelated { color: red; }\n",
  };
  const frozen = (file, value) => run(t, { base, head: { [file]: value } }).blocking.filter((finding) => finding.rule === "frozen-render");
  const component = frozen(componentCss, ".first { color: blue; }\n");
  assert.equal(component.length, 1);
  assert.match(component[0].problem, /1 frozen v1\.0 story files/);
  assert.match(component[0].problem, /first\.stories\.tsx/);
  assert.doesNotMatch(component[0].problem, /second\.stories\.tsx/);
  const preview = frozen(previewCss, ":root { color: blue; }\n");
  assert.equal(preview.length, 1);
  assert.match(preview[0].problem, /2 frozen v1\.0 story files/);
  assert.match(preview[0].problem, /first\.stories\.tsx.*second\.stories\.tsx/);
  assert.deepEqual(frozen("packages/design-system/components/unrelated.css", ".unrelated { color: blue; }\n"), []);
});

test("extensionless preview imports resolve CSS separately before and after .ts/.tsx swaps (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const preview = "apps/storybook/.storybook/preview.tsx";
  const oldCss = "apps/storybook/.storybook/old.css";
  const newCss = "apps/storybook/.storybook/new.css";
  const stories = {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    [preview]: 'import "./shared";\n',
  };
  for (const [baseExtension, headExtension] of [["ts", "tsx"], ["tsx", "ts"]]) {
    const oldModule = `apps/storybook/.storybook/shared.${baseExtension}`;
    const newModule = `apps/storybook/.storybook/shared.${headExtension}`;
    const reverse = baseExtension === "tsx";
    const base = {
      ...stories,
      [oldModule]: 'import "./old.css";\n',
      [oldCss]: ".old { color: red; }\n",
      ...(reverse ? { [newCss]: ".new { color: red; }\n" } : {}),
    };
    const head = {
      [oldModule]: null,
      [newModule]: 'import "./new.css";\n',
      ...(reverse ? { [oldCss]: null } : { [newCss]: ".new { color: blue; }\n" }),
    };
    const result = run(t, { base, head, commit: true });
    const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
    assert.ok(finding, `${baseExtension} → ${headExtension}`);
    assert.match(finding.problem, /2 frozen v1\.0 story files/);
    assert.match(finding.problem, /first\.stories\.tsx.*second\.stories\.tsx/);
    const controlHead = reverse ? { ...head, [oldCss]: base[oldCss] }
      : { ...head, [newCss]: ".new { color: green; }\n" };
    const control = run(t, { base, head: controlHead, commit: true });
    for (const story of [first, second]) {
      assert.notEqual(frozenInputs(result.checkout, result.baseSha, [story]),
        frozenInputs(control.checkout, control.baseSha, [story]), `${baseExtension} → ${headExtension}: ${story} digest`);
    }
    if (reverse) {
      assert.equal(control.blocking.some((entry) => entry.rule === "frozen-render"), false,
        "retaining the old CSS leaves the module swap outside story closures");
    }
  }
});

test("a recorded frozen line goes stale when CSS behind a story .ts/.tsx swap changes (ISS-13752)", (t) => {
  const story = "apps/storybook/stories/one.stories.tsx";
  const oldCss = "apps/storybook/stories/old.css";
  const newCss = "apps/storybook/stories/new.css";
  for (const [baseExtension, headExtension] of [["ts", "tsx"], ["tsx", "ts"]]) {
    const oldModule = `apps/storybook/stories/shared.${baseExtension}`;
    const newModule = `apps/storybook/stories/shared.${headExtension}`;
    const base = {
      [story]: 'import "./shared";\nexport default { title: "Composites v1.0/One" };\nexport const Default = {};\n',
      [oldModule]: 'import "./old.css";\n',
      [oldCss]: ".old { color: red; }\n",
    };
    const result = run(t, { base, head: {
      [oldModule]: null,
      [newModule]: 'import "./new.css";\n',
      [newCss]: ".new { color: red; }\n",
    }, commit: true });
    const inputs = frozenInputs(result.checkout, result.baseSha, [story]);
    const line = `Frozen render unchanged: all 1 story files (1 stories): frozen-render.mjs --base ${result.baseSha} --story-file ${story}: 1 identical, 0 unstable on base, 0 same failure, 0 blocking; states ${storyId("Composites v1.0/One", "Default")}; inputs ${inputs}; out/results.json\n`;
    writeFileSync(path.join(result.checkout, ".git", "vibe-changes.md"), line);
    const findings = () => runDiffRules({ worktree: result.checkout, base: result.baseSha, isFrozenStory, binding: PROVIDER_BINDING }).blocking.filter((entry) => entry.rule === "frozen-render");
    assert.deepEqual(findings(), [], `${baseExtension} → ${headExtension}: original line is current`);
    const changedCss = baseExtension === "ts" ? newCss : oldCss;
    writeFileSync(path.join(result.checkout, changedCss), ".changed { color: blue; }\n");
    assert.notEqual(frozenInputs(result.checkout, result.baseSha, [story]), inputs, `${baseExtension} → ${headExtension}: digest moves`);
    assert.equal(findings().length, 1, `${baseExtension} → ${headExtension}: stale line is refused`);
  }
});

test("head .ts shadows an unchanged .tsx in frozen selection and makes a recorded line stale (ISS-13752)", (t) => {
  const story = "apps/storybook/stories/one.stories.tsx";
  const headCss = "apps/storybook/stories/head.css";
  const result = run(t, { base: {
    [story]: 'import "./shared";\nexport default { title: "Composites v1.0/One" };\nexport const Default = {};\n',
    "apps/storybook/stories/shared.tsx": 'import "./base.css";\n',
    "apps/storybook/stories/base.css": ".base { color: red; }\n",
  }, head: {
    "apps/storybook/stories/shared.ts": 'import "./head.css";\n',
    [headCss]: ".head { color: red; }\n",
  }, commit: true });
  const findings = () => runDiffRules({ worktree: result.checkout, base: result.baseSha, isFrozenStory, binding: PROVIDER_BINDING })
    .blocking.filter((entry) => entry.rule === "frozen-render");
  assert.equal(findings().length, 1, "head-only .ts and CSS must select the frozen story");
  const inputs = frozenInputs(result.checkout, result.baseSha, [story]);
  const line = `Frozen render unchanged: all 1 story files (1 stories): frozen-render.mjs --base ${result.baseSha} --story-file ${story}: 1 identical, 0 unstable on base, 0 same failure, 0 blocking; states ${storyId("Composites v1.0/One", "Default")}; inputs ${inputs}; out/results.json\n`;
  writeFileSync(path.join(result.checkout, ".git", "vibe-changes.md"), line);
  assert.deepEqual(findings(), [], "the exact current line is accepted");
  writeFileSync(path.join(result.checkout, headCss), ".head { color: blue; }\n");
  assert.notEqual(frozenInputs(result.checkout, result.baseSha, [story]), inputs, "head-only CSS changes the digest");
  assert.equal(findings().length, 1, "the line is stale after head-only CSS changes");
});

test("preview CSS @import url reaches every frozen story and both input digests (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const nested = "apps/storybook/.storybook/nested.css";
  const original = ".nested { color: red; }\n";
  const base = {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    "apps/storybook/.storybook/preview.tsx": 'import "./preview.css";\n',
    "apps/storybook/.storybook/preview.css": '@import url("nested.css") screen;\n',
    [nested]: original,
  };
  const result = run(t, { base, head: { [nested]: ".nested { color: blue; }\n" } });
  const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
  assert.ok(finding);
  assert.match(finding.problem, /2 frozen v1\.0 story files/);
  for (const story of [first, second]) {
    const changed = frozenInputs(result.checkout, result.baseSha, [story]);
    writeFileSync(path.join(result.checkout, nested), original);
    assert.notEqual(changed, frozenInputs(result.checkout, result.baseSha, [story]));
    writeFileSync(path.join(result.checkout, nested), ".nested { color: blue; }\n");
  }
});

test("commented preview imports leave unrelated CSS out of selection and digest (ISS-13752)", (t) => {
  const story = "apps/storybook/stories/first.stories.tsx";
  const unused = "apps/storybook/.storybook/unused.css";
  const original = ".unused { color: red; }\n";
  const result = run(t, { base: {
    [story]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    "apps/storybook/.storybook/preview.tsx": [
      '// import "./unused.css";',
      'const example = \'import "./unused.css"\';',
    ].join("\n"),
    [unused]: original,
  }, head: { [unused]: ".unused { color: blue; }\n" } });
  assert.equal(result.blocking.some((entry) => entry.rule === "frozen-render"), false);
  const unchanged = frozenInputs(result.checkout, result.baseSha, [story]);
  writeFileSync(path.join(result.checkout, unused), original);
  assert.equal(frozenInputs(result.checkout, result.baseSha, [story]), unchanged);
});

test("untracked Storybook globals select every frozen story and enter the input digest (ISS-13752)", (t) => {
  const stories = {
    "apps/storybook/stories/first.stories.tsx": "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    "apps/storybook/stories/second.stories.tsx": "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
  };
  for (const file of ["apps/storybook/public/logo.svg", "apps/storybook/.storybook/preview-head.html"]) {
    const result = run(t, { base: stories, head: { [file]: `<data>${file}</data>\n` } });
    const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
    assert.ok(finding, file);
    assert.match(finding.problem, /2 frozen v1\.0 story files/, file);
    const story = Object.keys(stories)[0];
    const changed = frozenInputs(result.checkout, result.baseSha, [story]);
    rmSync(path.join(result.checkout, file));
    assert.notEqual(changed, frozenInputs(result.checkout, result.baseSha, [story]), file);
  }
});

test("a preview-only helper reaches an untracked stylesheet for selection and digest (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const helper = "apps/storybook/.storybook/helper.ts";
  const fresh = "apps/storybook/.storybook/fresh.css";
  const result = run(t, { base: {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    "apps/storybook/.storybook/preview.tsx": 'import "./helper";\n',
    [helper]: "export const ready = true;\n",
  }, head: {
    [helper]: 'import "./fresh.css";\nexport const ready = true;\n',
    [fresh]: ".fresh { color: blue; }\n",
  } });
  const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
  assert.ok(finding);
  assert.match(finding.problem, /2 frozen v1\.0 story files/);
  const changed = frozenInputs(result.checkout, result.baseSha, [first]);
  rmSync(path.join(result.checkout, fresh));
  assert.notEqual(changed, frozenInputs(result.checkout, result.baseSha, [first]));
});

test("transitive Sass @use and @forward imports reach every frozen story and digest (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const palette = "apps/storybook/.storybook/_palette.scss";
  const index = "apps/storybook/.storybook/sets/_index.scss";
  const original = ".theme { color: red; }\n";
  const result = run(t, { base: {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    "apps/storybook/.storybook/preview.tsx": 'import "./preview.scss";\n',
    "apps/storybook/.storybook/preview.scss": '@use "palette";\n',
    [palette]: '@forward "sets";\n',
    [index]: original,
  }, head: { [index]: ".theme { color: blue; }\n" } });
  const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
  assert.ok(finding);
  assert.match(finding.problem, /2 frozen v1\.0 story files/);
  for (const story of [first, second]) {
    const changed = frozenInputs(result.checkout, result.baseSha, [story]);
    writeFileSync(path.join(result.checkout, index), original);
    assert.notEqual(changed, frozenInputs(result.checkout, result.baseSha, [story]));
    writeFileSync(path.join(result.checkout, index), ".theme { color: blue; }\n");
  }
});

test("the second Sass @import item reaches preview selection and both digests (ISS-13752)", (t) => {
  const firstStory = "apps/storybook/stories/first.stories.tsx";
  const secondStory = "apps/storybook/stories/second.stories.tsx";
  const stories = {
    [firstStory]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [secondStory]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
  };
  for (const extension of ["scss", "sass"]) {
    const preview = `apps/storybook/.storybook/preview.${extension}`;
    const first = `apps/storybook/.storybook/_first.${extension}`;
    const second = `apps/storybook/.storybook/_second.${extension}`;
    const original = extension === "sass" ? ".second\n  color: red\n" : ".second { color: red; }\n";
    const changedText = extension === "sass" ? ".second\n  color: blue\n" : ".second { color: blue; }\n";
    const result = run(t, { base: {
      ...stories,
      "apps/storybook/.storybook/preview.tsx": `import "./preview.${extension}";\n`,
      [preview]: extension === "sass" ? "@import first, second\n" : '@import "first", "second";\n',
      [first]: extension === "sass" ? ".first\n  color: red\n" : ".first { color: red; }\n",
      [second]: original,
    }, head: { [second]: changedText } });
    const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
    assert.ok(finding, extension);
    assert.match(finding.problem, /2 frozen v1\.0 story files/, extension);
    for (const story of [firstStory, secondStory]) {
      const changed = frozenInputs(result.checkout, result.baseSha, [story]);
      writeFileSync(path.join(result.checkout, second), original);
      assert.notEqual(changed, frozenInputs(result.checkout, result.baseSha, [story]), `${extension}: ${story}`);
      writeFileSync(path.join(result.checkout, second), changedText);
    }
  }
});

test("a Sass media import does not promote an unrelated partial to preview-global (ISS-13752)", (t) => {
  const story = "apps/storybook/stories/one.stories.tsx";
  const partial = "apps/storybook/.storybook/_layout.scss";
  const original = ".layout { color: red; }\n";
  const result = run(t, { base: {
    [story]: "export default { title: \"Composites v1.0/One\" };\nexport const Default = {};\n",
    "apps/storybook/.storybook/preview.tsx": 'import "./preview.scss";\n',
    "apps/storybook/.storybook/preview.scss": '@import "layout" screen;\n',
    [partial]: original,
  }, head: { [partial]: ".layout { color: blue; }\n" } });
  assert.equal(result.blocking.some((entry) => entry.rule === "frozen-render"), false);
  const digest = frozenInputs(result.checkout, result.baseSha, [story]);
  writeFileSync(path.join(result.checkout, partial), original);
  assert.equal(frozenInputs(result.checkout, result.baseSha, [story]), digest);
});

test("each explicit global input and a lockfile-only diff select every frozen story (ISS-13752)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const globalFiles = [
    "apps/storybook/.storybook/preview-head.html",
    "apps/storybook/.storybook/main.ts",
    "apps/storybook/public/fonts/ui.woff2",
    "apps/storybook/package.json",
    "packages/design-system/package.json",
    "packages/app/package.json",
    "pnpm-lock.yaml",
    "packages/design-system/styles/theme.css",
    "packages/design-system/tokens/colors.json",
    "tailwind.config.ts",
  ];
  const base = {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    ...Object.fromEntries(globalFiles.map((file) => [file, `original ${file}\n`])),
    "packages/other/package.json": "original other\n",
  };
  for (const file of globalFiles) {
    const result = run(t, { base, head: { [file]: `changed ${file}\n` } });
    const finding = result.blocking.find((entry) => entry.rule === "frozen-render");
    assert.ok(finding, file);
    assert.match(finding.problem, /2 frozen v1\.0 story files/, file);
    assert.match(finding.problem, /first\.stories\.tsx.*second\.stories\.tsx/, file);
  }
  const unrelated = run(t, { base, head: { "packages/other/package.json": "changed other\n" } });
  assert.equal(unrelated.blocking.some((entry) => entry.rule === "frozen-render"), false);
});
