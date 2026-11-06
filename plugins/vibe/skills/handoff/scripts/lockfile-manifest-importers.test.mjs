import assert from "node:assert/strict";
import test from "node:test";
import { unexplainedLockfileEntries } from "./lockfile-manifest.mjs";
import { INVENTORY, lockfile, lockfileWithPnpmDocument, runNode, setup, storybookManifest, SYMPHONY_PATH_POLICY, write } from "./lockfile-manifest-test-fixture.mjs";

test("AC-001: dependency names inherited from Object.prototype remain attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-constructor-dependency", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { constructor: "^0.0.6" } }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      constructor:
        specifier: ^0.0.6
        version: 0.0.6
packages:
  constructor@0.0.6:
    resolution: {integrity: sha512-constructor}
snapshots:
  constructor@0.0.6: {}
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-002: malformed manifest dependency fields grant no lockfile permission", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-scalar-manifest-dependencies", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: "x" }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      '0':
        specifier: x
        version: 1.0.0
packages:
  0@1.0.0: {}
snapshots:
  0@1.0.0: {}
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/0", "packages/0@1.0.0", "snapshots/0@1.0.0"]);
});

test("AC-002: an explicit null dependency field cannot explain a removal", (t) => {
  const before = `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  foo@1.0.0: {}
snapshots:
  foo@1.0.0: {}
`;
  const after = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const result = unexplainedLockfileEntries({ before, after, manifests: [{
    file: "apps/storybook/package.json",
    before: JSON.stringify({ dependencies: { foo: "^1.0.0" } }),
    after: JSON.stringify({ dependencies: null }),
  }] });
  assert.deepEqual(result, ["importers/apps/storybook/dependencies/foo", "packages/foo@1.0.0", "snapshots/foo@1.0.0"]);
});

test("AC-001/AC-003: admitted Storybook dependency and its pnpm importer delta pass in any declared repository", (t) => {
  for (const repoName of ["symphony-alpha", "another-declared-repo"]) {
    const fixture = setup(t, `lock-query-${repoName}`, {
      "apps/storybook/package.json": storybookManifest(false),
      "pnpm-lock.yaml": lockfileWithPnpmDocument(),
    }, { repoName });
    write(fixture.worktree, "apps/storybook/package.json", storybookManifest(true));
    write(fixture.worktree, "pnpm-lock.yaml", lockfileWithPnpmDocument({ query: true }));
    const result = runNode(INVENTORY, ["--worktree", fixture.worktree, "--phase", "pull-request"], fixture.home);
    assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
    assert.deepEqual(result.json.outsideAllowed, []);
    assert.deepEqual(result.json.unexplainedLockfileEntries, []);
  }
});

test("AC-001: resolved package and snapshot additions reachable from an admitted dependency pass", (t) => {
  const f = setup(t, "lock-resolved", { "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile() });
  write(f.worktree, "apps/storybook/package.json", storybookManifest(true));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true, resolved: true }));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-001: admitted dependency bump and removal explain their old and new resolved entries", (t) => {
  const bump = setup(t, "lock-bump", {
    "apps/storybook/package.json": storybookManifest(true),
    "pnpm-lock.yaml": lockfile({ query: true, resolved: true }),
  });
  write(bump.worktree, "apps/storybook/package.json", storybookManifest(true, "^5.91.0"));
  write(bump.worktree, "pnpm-lock.yaml", lockfile({ query: true, resolved: true })
    .replaceAll("^5.90.20", "^5.91.0").replaceAll("5.90.21", "5.91.1"));
  const bumped = runNode(INVENTORY, ["--worktree", bump.worktree, "--phase", "pull-request"], bump.home);
  assert.equal(bumped.json.blocking.forbiddenPaths, true, JSON.stringify(bumped.json.unexplainedLockfileEntries));

  const removal = setup(t, "lock-remove", {
    "apps/storybook/package.json": storybookManifest(true),
    "pnpm-lock.yaml": lockfile({ query: true, resolved: true }),
  });
  write(removal.worktree, "apps/storybook/package.json", storybookManifest(false));
  write(removal.worktree, "pnpm-lock.yaml", lockfile());
  const removed = runNode(INVENTORY, ["--worktree", removal.worktree, "--phase", "pull-request"], removal.home);
  assert.equal(removed.json.blocking.forbiddenPaths, true, JSON.stringify(removed.json.unexplainedLockfileEntries));
});

test("AC-002/AC-003: mixed unrelated importer and resolved entry block with exact entry names", (t) => {
  const f = setup(t, "lock-mixed", { "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile() });
  write(f.worktree, "apps/storybook/package.json", storybookManifest(true));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true, other: true, resolved: true }).replace(
    "  react@19.0.0: {}\n", "  react@19.0.0: {}\n\n  unrelated@2.0.0: {}\n"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, [
    "importers/apps/unrelated", "importers/apps/unrelated/dependencies/rogue", "snapshots/unrelated@2.0.0",
  ]);
  assert.deepEqual(result.json.outsideAllowed, [{ path: "pnpm-lock.yaml", status: "M" }]);
});

test("AC-002/AC-003: a lockfile-only importer edit blocks and names the dependency", (t) => {
  const f = setup(t, "lock-only", { "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile() });
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true }));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/@tanstack/react-query"]);
});

test("AC-002: adding or removing an empty importer without a manifest edit names the importer", (t) => {
  const empty = "lockfileVersion: '9.0'\nimporters: {}\n";
  const withImporter = "lockfileVersion: '9.0'\nimporters:\n  apps/unrelated: {}\n";
  for (const [slug, before, after] of [
    ["lock-empty-added", empty, withImporter],
    ["lock-empty-removed", withImporter, empty],
  ]) {
    const f = setup(t, slug, { "pnpm-lock.yaml": before });
    write(f.worktree, "pnpm-lock.yaml", after);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/unrelated"]);
    assert.deepEqual(result.json.outsideAllowed, [{ path: "pnpm-lock.yaml", status: "M" }]);
  }
});

test("AC-002: an explained dependency plus an empty unrelated importer still blocks", (t) => {
  const f = setup(t, "lock-query-empty-other", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "apps/storybook/package.json", storybookManifest(true));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true }).replace(
    "\npackages:\n", "\n  apps/unrelated: {}\n\npackages:\n"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/unrelated"]);
});

test("AC-002: adding or removing an empty dependency category names the category", (t) => {
  const empty = "lockfileVersion: '9.0'\nimporters:\n  apps/example: {}\n";
  const withCategory = "lockfileVersion: '9.0'\nimporters:\n  apps/example:\n    dependencies: {}\n";
  for (const [slug, before, after] of [
    ["lock-empty-category-added", empty, withCategory],
    ["lock-empty-category-removed", withCategory, empty],
  ]) {
    const f = setup(t, slug, { "pnpm-lock.yaml": before });
    write(f.worktree, "pnpm-lock.yaml", after);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/example/dependencies"]);
  }
});

test("AC-002: an explained dependency cannot admit an unrelated empty-category transition", (t) => {
  const base = lockfile().replace("\npackages:\n", "\n  apps/example: {}\n\npackages:\n");
  const f = setup(t, "lock-query-empty-category", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", storybookManifest(true));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true }).replace(
    "\npackages:\n", "\n  apps/example:\n    dependencies: {}\n\npackages:\n"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/example/dependencies"]);
});

test("AC-002: unknown inline importer and section header values fail closed", (t) => {
  const cases = [
    ["lock-importer-inline", "lockfileVersion: '9.0'\nimporters:\n  apps/example: {}\n",
      "lockfileVersion: '9.0'\nimporters:\n  apps/example: {unexpected: true}\n", "importers/apps/example"],
    ["lock-section-inline", "lockfileVersion: '9.0'\nimporters: {}\n",
      "lockfileVersion: '9.0'\nimporters: {unexpected: true}\n", "importers"],
  ];
  for (const [slug, before, after, entry] of cases) {
    const f = setup(t, slug, { "pnpm-lock.yaml": before });
    write(f.worktree, "pnpm-lock.yaml", after);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, [entry]);
  }
});

test("AC-002: inline empty mapping headers with nested children fail closed", (t) => {
  const valid = lockfile({ query: true, resolved: true });
  const cases = [
    ["section-importers", valid.replace("importers:\n", "importers: {}\n"), "importers"],
    ["entry-importer", valid.replace("  apps/storybook:\n", "  apps/storybook: {}\n"), "importers/apps/storybook"],
    ["entry-category", valid.replace("    dependencies:\n", "    dependencies: {}\n"), "importers/apps/storybook/dependencies"],
    ["section-packages", valid.replace("packages:\n", "packages: {}\n"), "packages"],
    [
      "entry-snapshot",
      valid.replace(
        "  '@tanstack/react-query@5.90.21(react@19.0.0)':\n",
        "  '@tanstack/react-query@5.90.21(react@19.0.0)': {}\n",
      ),
      "snapshots/@tanstack/react-query@5.90.21(react@19.0.0)",
    ],
  ];
  for (const [slug, changed, entry] of cases) {
    const f = setup(t, `lock-empty-header-${slug}`, {
      "apps/storybook/package.json": storybookManifest(false),
      "pnpm-lock.yaml": lockfile(),
    });
    write(f.worktree, "apps/storybook/package.json", storybookManifest(true));
    write(f.worktree, "pnpm-lock.yaml", changed);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, [entry]);
  }
});

test("AC-001: a new importer with a matching admitted manifest dependency passes", (t) => {
  const f = setup(t, "lock-new-importer", {
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters: {}\n",
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
  write(f.worktree, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  apps/storybook:\n    dependencies:\n      react:\n        specifier: ^19.0.0\n        version: 19.0.0\n");
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
});

test("AC-001: an admitted npm alias reaches its target package and snapshot", (t) => {
  const f = setup(t, "lock-npm-alias", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({
    dependencies: { react: "^19.0.0", "posthog-js-shipped": "npm:posthog-js@1.359.1" },
  }));
  const updated = lockfile()
    .replace("      react:\n", `      posthog-js-shipped:
        specifier: npm:posthog-js@1.359.1
        version: posthog-js@1.359.1
      react:
`)
    .replace("\nsnapshots:\n", `
  posthog-js@1.359.1:
    resolution: {integrity: sha512-posthog}

snapshots:
`)
    .replace("  react@19.0.0: {}\n", "  react@19.0.0: {}\n\n  posthog-js@1.359.1: {}\n");
  write(f.worktree, "pnpm-lock.yaml", updated);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-001: transitive npm aliases resolve through dependencies and optionalDependencies", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-transitive-alias", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      wrapper:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  wrapper@1.0.0:
    resolution: {integrity: sha512-wrapper}
  string-width@4.2.3:
    resolution: {integrity: sha512-width}
  strip-ansi@6.0.1:
    resolution: {integrity: sha512-strip}
snapshots:
  wrapper@1.0.0:
    dependencies:
      string-width-cjs: string-width@4.2.3
    optionalDependencies:
      strip-ansi-cjs: strip-ansi@6.0.1
  string-width@4.2.3: {}
  strip-ansi@6.0.1: {}
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-002: malformed or extra importer dependency fields name the exact entry", (t) => {
  const manifest = JSON.stringify({ dependencies: { react: "^19.0.0", foo: "^1.0.0" } });
  for (const [slug, fields] of [
    ["lock-version-map", "        version: {}\n"],
    ["lock-extra-dep-field", "        version: 1.0.0\n        unexpected: arbitrary\n"],
  ]) {
    const f = setup(t, slug, { "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile() });
    write(f.worktree, "apps/storybook/package.json", manifest);
    write(f.worktree, "pnpm-lock.yaml", lockfile().replace("      react:\n", `      foo:
        specifier: ^1.0.0
${fields}      react:
`));
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/foo"]);
  }
});

test("AC-002: YAML non-string importer versions name the dependency entry", (t) => {
  const manifest = JSON.stringify({ dependencies: { react: "^19.0.0", foo: "^1.0.0" } });
  for (const [slug, version] of [
    ["true", "true"], ["null", "null"], ["tilde", "~"], ["integer", "42"],
    ["zero", "0"], ["exponent", "1e3"], ["nan", ".nan"], ["hex", "0x2a"],
  ]) {
    const f = setup(t, `lock-version-${slug}`, {
      "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
    });
    write(f.worktree, "apps/storybook/package.json", manifest);
    write(f.worktree, "pnpm-lock.yaml", lockfile().replace("      react:\n", `      foo:
        specifier: ^1.0.0
        version: ${version}
      react:
`));
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/foo"]);
  }
});

test("AC-002: YAML comments cannot disguise non-string importer versions", (t) => {
  const manifest = JSON.stringify({ dependencies: { react: "^19.0.0", foo: "^1.0.0" } });
  for (const [slug, version] of [["integer", "42"], ["boolean", "true"], ["nan", ".nan"]]) {
    const f = setup(t, `lock-commented-version-${slug}`, {
      "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
    });
    write(f.worktree, "apps/storybook/package.json", manifest);
    write(f.worktree, "pnpm-lock.yaml", lockfile().replace("      react:\n", `      foo:
        specifier: ^1.0.0
        version: ${version} # disguised scalar
      react:
`));
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/foo"]);
  }
});

test("AC-002: invalid plain importer scalars cannot grant permission", (t) => {
  const manifest = JSON.stringify({ dependencies: { react: "^19.0.0", foo: "^1.0.0" } });
  for (const [slug, version] of [["comment-only", "# empty"], ["mapping", "1.0.0: evil"]]) {
    const f = setup(t, `lock-invalid-plain-${slug}`, {
      "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
    });
    write(f.worktree, "apps/storybook/package.json", manifest);
    write(f.worktree, "pnpm-lock.yaml", lockfile().replace("      react:\n", `      foo:
        specifier: ^1.0.0
        version: ${version}
      react:
`));
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/foo"]);
  }
});

test("AC-002: unsupported importer category shapes return a named entry", (t) => {
  const f = setup(t, "lock-importer-sequence", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { react: "^19.0.0", foo: "^1.0.0" } }));
  write(f.worktree, "pnpm-lock.yaml", lockfile().replace("      react:\n", `      - foo
      react:
`));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies"]);
});

test("AC-002: reachable package and snapshot entries reject non-mapping bodies", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const valid = `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      wrapper:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  wrapper@1.0.0:
    resolution: {integrity: sha512-wrapper}
  string-width@4.2.3:
    resolution: {integrity: sha512-width}
snapshots:
  wrapper@1.0.0:
    dependencies:
      string-width-cjs: string-width@4.2.3
  string-width@4.2.3: {}
`;
  for (const [slug, changed, entry] of [
    ["package-scalar", valid.replace("  string-width@4.2.3:\n    resolution: {integrity: sha512-width}", "  string-width@4.2.3: true"), "packages/string-width@4.2.3"],
    ["snapshot-inline", valid.replace("  string-width@4.2.3: {}", "  string-width@4.2.3: {unexpected: true}"), "snapshots/string-width@4.2.3"],
  ]) {
    const f = setup(t, `lock-${slug}`, {
      "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
    });
    write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }));
    write(f.worktree, "pnpm-lock.yaml", changed);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, [entry]);
  }
});

test("AC-002: a reachable snapshot rejects unsupported dependency scalars", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-resolved-alias", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      wrapper:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  wrapper@1.0.0:
    resolution: {integrity: sha512-wrapper}
snapshots:
  wrapper@1.0.0:
    dependencies:
      child: *unknown
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["snapshots/wrapper@1.0.0"]);
});
