import assert from "node:assert/strict";
import test from "node:test";
import { unexplainedLockfileEntries } from "./lockfile-manifest.mjs";
import { INVENTORY, lockfile, lockfileWithPnpmDocument, runNode, setup, storybookManifest, SYMPHONY_PATH_POLICY, write } from "./lockfile-manifest-test-fixture.mjs";

test("AC-002: reachable package metadata rejects unsupported YAML references", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, resolution] of [["alias", "*unknown"], ["inline-alias", "{integrity: *unknown}"]]) {
    const f = setup(t, `lock-package-${slug}`, {
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
    resolution: ${resolution}
snapshots:
  wrapper@1.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/wrapper@1.0.0"]);
  }
});

test("AC-002: reachable metadata rejects malformed or wrong node shapes", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, field, entry] of [
    ["resolution-sequence", "resolution: [evil]", "packages/wrapper@1.0.0"],
    ["resolution-tagged", "resolution: !<tag:yaml.org,2002:seq> [evil]", "packages/wrapper@1.0.0"],
    ["resolution-open", "resolution: {integrity: sha512-x", "packages/wrapper@1.0.0"],
    ["resolution-quote", "resolution: {integrity: 'unterminated}", "packages/wrapper@1.0.0"],
    ["resolution-comment", "resolution: {integrity: sha512-x # comment}", "packages/wrapper@1.0.0"],
    ["unknown-field", "unexpected: value", "packages/wrapper@1.0.0"],
  ]) {
    const f = setup(t, `lock-metadata-${slug}`, {
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
    ${field}
snapshots:
  wrapper@1.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, [entry]);
  }

  const f = setup(t, "lock-metadata-snapshot-sequence", {
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
    transitivePeerDependencies: [oops
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["snapshots/wrapper@1.0.0"]);
});

test("AC-001: canonical pnpm package and snapshot metadata remains attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-canonical-metadata", {
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
    engines: {node: '>=18'}
    hasBin: true
    cpu: [arm64]
    os:
      - linux
    bundledDependencies: [child]
    peerDependencies:
      zod: ^4.0.0
    peerDependenciesMeta:
      zod:
        optional: true
    deprecated: 'use another package'
    version: 1.0.0
snapshots:
  wrapper@1.0.0:
    optional: false
    transitivePeerDependencies:
      - zod
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-001: comments after complete flow metadata remain attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const manifest = [{ file: "apps/storybook/package.json", before: JSON.stringify({ dependencies: {} }),
    after: JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }) }];
  const after = `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      wrapper:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  wrapper@1.0.0:
    resolution: {integrity: sha512-wrapper} # complete flow map
    cpu: [x64] # complete flow list
snapshots:
  wrapper@1.0.0: {}
`;
  assert.deepEqual(unexplainedLockfileEntries({ before: base, after, manifests: manifest }), []);
});

test("AC-001: pnpm registry revision metadata remains attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, resolution] of [
    ["block", "resolution:\n      integrity: sha512-wrapper\n      revision: 1"],
    ["inline", "resolution: {integrity: sha512-wrapper, revision: 0}"],
  ]) {
    const f = setup(t, `lock-revision-${slug}`, {
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
    ${resolution}
snapshots:
  wrapper@1.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
    assert.deepEqual(result.json.unexplainedLockfileEntries, []);
  }
});

test("AC-002: inline metadata maps enforce field-specific value shapes", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, metadata] of [
    ["peer-key", "peerDependenciesMeta: {zod: {evil: true}}"],
    ["peer-value", "peerDependenciesMeta: {zod: {optional: invalid}}"],
    ["integrity", "resolution: {integrity: true}"],
    ["revision-boolean", "resolution: {integrity: sha512-wrapper, revision: true}"],
    ["revision-sequence", "resolution: {integrity: sha512-wrapper, revision: [evil]}"],
    ["engines", "engines: {node: 42}"],
  ]) {
    const f = setup(t, `lock-inline-metadata-${slug}`, {
      "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
    });
    write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }));
    const packageBody = metadata.startsWith("resolution:") ? metadata : `resolution: {integrity: sha512-wrapper}\n    ${metadata}`;
    write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      wrapper:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  wrapper@1.0.0:
    ${packageBody}
snapshots:
  wrapper@1.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/wrapper@1.0.0"]);
  }
});

test("AC-002: inline metadata maps reject duplicate keys", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, metadata] of [
    ["resolution", "resolution: {integrity: sha512-good, integrity: sha512-forged}"],
    ["peer-meta", "peerDependenciesMeta: {zod: {optional: true, optional: false}}"],
  ]) {
    const f = setup(t, `lock-duplicate-inline-${slug}`, {
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
    ${metadata}
snapshots:
  wrapper@1.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/wrapper@1.0.0"]);
  }
});

test("AC-001: pnpm platform variation resolutions remain attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-resolution-variants", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { node: "runtime:22" } }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      node:
        specifier: runtime:22
        version: 22.0.0
packages:
  node@22.0.0:
    resolution:
      type: variations
      variants:
        - resolution:
            type: binary
            url: https://example.invalid/node.tar.gz
            integrity: sha512-node
            bin: node
            archive: tarball
          targets:
            - os: linux
              cpu: x64
              libc: musl
              libcVersion: '1.2'
              osVersion: '6.0'
              napi: 8
              nodeAbi: node-115
            - wasm32: true
            - any: true
snapshots:
  node@22.0.0: {}
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-002: variation resolutions require platform resolution objects", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, variants] of [
    ["boolean", "variants: true"], ["number", "variants: 42"],
    ["mapping", "variants: {bogus: true}"], ["scalar-list", "variants: [x64]"],
    ["block-scalar", "variants:\n        - bogus"],
  ]) {
    const f = setup(t, `lock-variants-${slug}`, {
      "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
    });
    write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { node: "runtime:22" } }));
    write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      node:
        specifier: runtime:22
        version: 22.0.0
packages:
  node@22.0.0:
    resolution:
      type: variations
      ${variants}
snapshots:
  node@22.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/node@22.0.0"]);
  }
});

test("AC-002: platform variation targets enforce their field shapes", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  for (const [slug, target] of [
    ["any-extra", "any: true\n              os: linux"],
    ["wasm-os", "wasm32: true\n              os: linux\n              cpu: x64"],
    ["missing-cpu", "os: linux"],
    ["napi-overflow", "os: linux\n              cpu: x64\n              napi: 4294967296"],
    ["bad-abi", "os: linux\n              cpu: x64\n              nodeAbi: other-1"],
    ["unknown", "os: linux\n              cpu: x64\n              unexpected: value"],
  ]) {
    const f = setup(t, `lock-target-${slug}`, {
      "apps/storybook/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": base,
    });
    write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { node: "runtime:22" } }));
    write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      node:
        specifier: runtime:22
        version: 22.0.0
packages:
  node@22.0.0:
    resolution:
      type: variations
      variants:
        - resolution:
            type: binary
            url: https://example.invalid/node.tar.gz
            integrity: sha512-node
            bin: node
            archive: tarball
          targets:
            - ${target}
snapshots:
  node@22.0.0: {}
`);
    const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
    assert.equal(result.json.blocking.forbiddenPaths, false);
    assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/node@22.0.0"]);
  }
});

test("AC-001/AC-002: resolution revisions are bounded and gitHosted is boolean", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const manifest = [{ file: "apps/storybook/package.json", before: JSON.stringify({ dependencies: {} }),
    after: JSON.stringify({ dependencies: { foo: "^1.0.0" } }) }];
  const lock = (resolution) => `lockfileVersion: '9.0'
importers:
  apps/storybook:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  foo@1.0.0:
    resolution: ${resolution}
snapshots:
  foo@1.0.0: {}
`;
  assert.deepEqual(unexplainedLockfileEntries({ before: base, after: lock("{integrity: sha512-x, revision: 9007199254740991}"), manifests: manifest }), []);
  assert.deepEqual(unexplainedLockfileEntries({ before: base, after: lock("{integrity: sha512-x, revision: 9007199254740992}"), manifests: manifest }), ["packages/foo@1.0.0"]);
  assert.deepEqual(unexplainedLockfileEntries({ before: base, after: lock("{integrity: sha512-x, gitHosted: true}"), manifests: manifest }), []);
  assert.deepEqual(unexplainedLockfileEntries({ before: base, after: lock("{integrity: sha512-x, gitHosted: value}"), manifests: manifest }), ["packages/foo@1.0.0"]);
});

test("AC-001: git-hosted tarball resolutions remain attributable", (t) => {
  const base = "lockfileVersion: '9.0'\nimporters:\n  apps/storybook: {}\npackages: {}\nsnapshots: {}\n";
  const f = setup(t, "lock-git-hosted", {
    "apps/storybook/package.json": JSON.stringify({ devDependencies: {} }), "pnpm-lock.yaml": base,
  });
  const url = "https://codeload.github.com/avajs/test/tar.gz/abcdef";
  const version = `${url}(@ava/typescript@7.0.0)(supports-color@10.2.2)`;
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ devDependencies: { "@ava/test": "github:avajs/test" } }));
  write(f.worktree, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  apps/storybook:
    devDependencies:
      '@ava/test':
        specifier: github:avajs/test
        version: ${version}
packages:
  '@ava/test@${url}':
    resolution: {gitHosted: true, integrity: sha512-test, tarball: ${url}}
snapshots:
  '@ava/test@${version}': {}
`);
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
  assert.deepEqual(result.json.unexplainedLockfileEntries, []);
});

test("AC-002: a resolved edge change cannot explain unrelated same-key metadata", (t) => {
  const before = `lockfileVersion: '9.0'
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
      child: 1.0.0
`;
  const f = setup(t, "lock-edge-metadata", {
    "apps/storybook/package.json": JSON.stringify({ dependencies: { wrapper: "^1.0.0" } }),
    "pnpm-lock.yaml": before,
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { wrapper: "^1.0.1" } }));
  write(f.worktree, "pnpm-lock.yaml", before.replace("specifier: ^1.0.0", "specifier: ^1.0.1")
    .replace("child: 1.0.0", "child: 2.0.0\n    optional: true"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["snapshots/wrapper@1.0.0"]);
  write(f.worktree, "pnpm-lock.yaml", before.replace("specifier: ^1.0.0", "specifier: ^1.0.1")
    .replace("child: 1.0.0", "child: 2.0.0"));
  const edgeOnly = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(edgeOnly.json.blocking.forbiddenPaths, true, JSON.stringify(edgeOnly.json.unexplainedLockfileEntries));
});

test("AC-002: a reachable same-key package and snapshot metadata mutation is unexplained", (t) => {
  const f = setup(t, "lock-reachable-integrity", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "apps/storybook/package.json", JSON.stringify({ dependencies: { react: "^19.0.1" } }));
  write(f.worktree, "pnpm-lock.yaml", lockfile()
    .replace("specifier: ^19.0.0", "specifier: ^19.0.1")
    .replace("sha512-react", "sha512-tampered")
    .replace("  react@19.0.0: {}", "  react@19.0.0:\n    optional: true"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["packages/react@19.0.0", "snapshots/react@19.0.0"]);
});

test("AC-002: a lockfile-only version change names the importer and resolved entries", (t) => {
  const f = setup(t, "lock-version-only", {
    "apps/storybook/package.json": storybookManifest(false), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "pnpm-lock.yaml", lockfile().replaceAll("19.0.0", "19.1.0"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, [
    "importers/apps/storybook/dependencies/react", "packages/react@19.0.0", "packages/react@19.1.0",
    "snapshots/react@19.0.0", "snapshots/react@19.1.0",
  ]);
});

test("AC-002: an unadmitted manifest cannot explain a lockfile importer edit", (t) => {
  const f = setup(t, "lock-forbidden-manifest", {
    "packages/rogue/package.json": JSON.stringify({ dependencies: {} }), "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "packages/rogue/package.json", JSON.stringify({ dependencies: { rogue: "^1.0.0" } }));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ rogue: true }));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, [
    "importers/packages/rogue", "importers/packages/rogue/dependencies/rogue",
  ]);
});

test("AC-002: an explicit lockfile path allowance still requires matching manifest dependencies", (t) => {
  const policy = JSON.parse(SYMPHONY_PATH_POLICY);
  policy.allowedFiles.push("pnpm-lock.yaml");
  const f = setup(t, "lock-explicit-path", {
    "vibe-handoff-paths.json": JSON.stringify(policy),
    "apps/storybook/package.json": storybookManifest(false),
    "pnpm-lock.yaml": lockfile(),
  });
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true }));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, false);
  assert.deepEqual(result.json.unexplainedLockfileEntries, ["importers/apps/storybook/dependencies/@tanstack/react-query"]);
});

test("AC-004: a declared root package.json can explain the root importer", (t) => {
  const policy = JSON.parse(SYMPHONY_PATH_POLICY);
  policy.allowedFiles.push("package.json");
  const base = lockfile().replace("  apps/storybook:", "  .:");
  const f = setup(t, "lock-root-manifest", {
    "vibe-handoff-paths.json": JSON.stringify(policy),
    "package.json": storybookManifest(false), "pnpm-lock.yaml": base,
  }, { repoName: "custom-pnpm-repo" });
  write(f.worktree, "package.json", storybookManifest(true));
  write(f.worktree, "pnpm-lock.yaml", lockfile({ query: true }).replace("  apps/storybook:", "  .:"));
  const result = runNode(INVENTORY, ["--worktree", f.worktree, "--phase", "pull-request"], f.home);
  assert.equal(result.json.blocking.forbiddenPaths, true, JSON.stringify(result.json.unexplainedLockfileEntries));
});
