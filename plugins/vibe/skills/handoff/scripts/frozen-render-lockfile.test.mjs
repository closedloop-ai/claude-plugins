import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { frozenGlobalInputAffectsRender, frozenInputs } from "./frozen-render.mjs";
import { lockfileChangesImporterResolution } from "./lockfile-manifest.mjs";
import { run } from "./diff-rules-test-fixture.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// The render manifests come from the provider this repository ships, so these run bound to it.
bindProviderInProcess(after);

const ROOTS = ["apps/storybook", "packages/design-system", "packages/app"];
const LOCKFILE = "pnpm-lock.yaml";

// The shape pnpm 11 writes: an environment document, then the workspace document. apps/storybook links to the
// design system, which links to analytics; apps/api is reachable from none of the render manifests' importers.
const ENVIRONMENT = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

packages:

  pnpm@12.14.0:
    resolution: {integrity: sha512-pnpm}

snapshots:

  pnpm@12.14.0: {}
`;

function workspace({ storybookDnd = "6.3.1(react@19.2.9)", tslib = "2.8.1", reactIntegrity = "sha512-react", apiZod = "4.3.6",
  analyticsLinks = "", storybookSpecifier = "^6.3.1", analyticsDate = "4.1.0" } = {}) {
  return `---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  apps/api:
    dependencies:
      zod:
        specifier: ^4.3.0
        version: ${apiZod}

  apps/storybook:
    dependencies:
      '@dnd-kit/core':
        specifier: ${storybookSpecifier}
        version: ${storybookDnd}
      '@repo/design-system':
        specifier: workspace:*
        version: link:../../packages/design-system
      tw3:
        specifier: npm:tailwindcss@3.4.17
        version: tailwindcss@3.4.17

  packages/analytics:
    dependencies:
      date-fns:
        specifier: ^4.1.0
        version: ${analyticsDate}${analyticsLinks}

  packages/design-system:
    dependencies:
      '@repo/analytics':
        specifier: workspace:*
        version: link:../analytics
      react:
        specifier: ^19.2.0
        version: 19.2.9

packages:

  '@dnd-kit/core@6.3.1':
    resolution: {integrity: sha512-dnd}

  '@dnd-kit/core@6.3.2':
    resolution: {integrity: sha512-dnd2}

  date-fns@4.1.0:
    resolution: {integrity: sha512-date}

  date-fns@4.2.0:
    resolution: {integrity: sha512-date2}

  react@19.2.9:
    resolution: {integrity: ${reactIntegrity}}

  tailwindcss@3.4.17:
    resolution: {integrity: sha512-tw}

  tslib@2.8.1:
    resolution: {integrity: sha512-tslib}

  tslib@2.8.2:
    resolution: {integrity: sha512-tslib2}

  zod@4.3.6:
    resolution: {integrity: sha512-zod}

  zod@4.3.7:
    resolution: {integrity: sha512-zod2}

snapshots:

  '@dnd-kit/core@6.3.1(react@19.2.9)':
    dependencies:
      react: 19.2.9
      tslib: ${tslib}

  '@dnd-kit/core@6.3.2(react@19.2.9)':
    dependencies:
      react: 19.2.9
      tslib: ${tslib}

  date-fns@4.1.0: {}

  date-fns@4.2.0: {}

  react@19.2.9: {}

  tailwindcss@3.4.17: {}

  tslib@2.8.1: {}

  tslib@2.8.2: {}

  zod@4.3.6: {}

  zod@4.3.7: {}
`;
}

const lockfile = (options) => ENVIRONMENT + workspace(options);
const changes = (options) => lockfileChangesImporterResolution(lockfile(), lockfile(options), ROOTS);
const ANALYTICS_DESIGN_SYSTEM_LINK = `
      '@repo/design-system':
        specifier: workspace:*
        version: link:../design-system`;

test("a lockfile edit that only rewrites specifiers or adds a workspace link changes no Storybook resolution (ISS-14395)", () => {
  assert.equal(changes({ storybookSpecifier: "^6.3.0" }), false);
  // ISS-13467's lockfile hunk: an importer Storybook reaches gains a link to a workspace package.
  assert.equal(changes({ analyticsLinks: ANALYTICS_DESIGN_SYSTEM_LINK }), false);
  assert.equal(changes({ apiZod: "4.3.7" }), false, "apps/api is not reachable from any render manifest's importer");
  const environmentOnly = lockfile().replace("specifier: 12.14.0\n        version: 12.14.0", "specifier: 12.15.0\n        version: 12.15.0");
  assert.notEqual(environmentOnly, lockfile());
  assert.equal(lockfileChangesImporterResolution(lockfile(), environmentOnly, ROOTS), false);
});

test("a resolved change Storybook can reach counts, directly, through a workspace link or transitively (ISS-14395)", () => {
  assert.equal(changes({ storybookDnd: "6.3.2(react@19.2.9)" }), true, "direct dependency of apps/storybook");
  assert.equal(changes({ analyticsDate: "4.2.0" }), true, "packages/analytics, reached through two workspace links");
  assert.equal(changes({ tslib: "2.8.2" }), true, "transitive snapshot dependency");
  assert.equal(changes({ reactIntegrity: "sha512-other" }), true, "same version, different package body");
  const aliased = lockfile().replace("tailwindcss@3.4.17:\n    resolution: {integrity: sha512-tw}", "tailwindcss@3.4.17:\n    resolution: {integrity: sha512-tw-other}");
  assert.equal(lockfileChangesImporterResolution(lockfile(), aliased, ROOTS), true, "npm alias resolves under its target name");
  const settings = lockfile().replace("autoInstallPeers: true", "autoInstallPeers: false");
  assert.equal(lockfileChangesImporterResolution(lockfile(), settings, ROOTS), true, "lockfile settings");
});

test("an unreadable, added, removed or reshaped lockfile counts as a change (ISS-14395)", () => {
  assert.equal(lockfileChangesImporterResolution(lockfile(), "original pnpm-lock.yaml\n", ROOTS), true);
  assert.equal(lockfileChangesImporterResolution(null, lockfile(), ROOTS), true);
  assert.equal(lockfileChangesImporterResolution(lockfile(), null, ROOTS), true);
  assert.equal(lockfileChangesImporterResolution(lockfile(), workspace(), ROOTS), true, "document count changed");
  assert.equal(lockfileChangesImporterResolution(lockfile(), lockfile(), []), true, "no importer to judge from");
  const tabbed = lockfile().replace("  apps/storybook:", "\tapps/storybook:");
  assert.equal(lockfileChangesImporterResolution(lockfile(), tabbed, ROOTS), true);
  const flow = lockfile().replace("version: link:../../packages/design-system", "version: {link: x}");
  assert.equal(lockfileChangesImporterResolution(lockfile(), flow, ROOTS), true);
});

test("the render-manifest rule judges pnpm-lock.yaml by Storybook resolution and keeps the version-only manifest rule (ISS-14395, ISS-14171)", () => {
  assert.equal(frozenGlobalInputAffectsRender(LOCKFILE, new Set(), lockfile(), lockfile({ analyticsLinks: ANALYTICS_DESIGN_SYSTEM_LINK })), false);
  assert.equal(frozenGlobalInputAffectsRender(LOCKFILE, new Set(), lockfile(), lockfile({ tslib: "2.8.2" })), true);
  assert.equal(frozenGlobalInputAffectsRender(LOCKFILE, new Set(), null, lockfile()), true);
});

test("a render manifest edit that only bumps its version or rewrites dependency specifiers changes no render; other fields do (ISS-14395, ISS-14171)", () => {
  const manifest = "apps/storybook/package.json";
  const text = (fields) => JSON.stringify({ name: "storybook", version: "1.0.0", dependencies: { "@dnd-kit/core": "^6.3.1" }, ...fields });
  const affects = (fields) => frozenGlobalInputAffectsRender(manifest, new Set(), text(), text(fields));
  assert.equal(affects({ version: "1.1.0" }), false);
  assert.equal(affects({ dependencies: { "@dnd-kit/core": "^6.3.0" } }), false);
  assert.equal(affects({ dependencies: { "@dnd-kit/core": "^6.3.1", "@repo/analytics": "workspace:*" }, devDependencies: { vitest: "^5.0.0" },
    optionalDependencies: {}, peerDependencies: { react: "^19" } }), false);
  assert.equal(affects({ sideEffects: false }), true);
  assert.equal(affects({ exports: { ".": "./index.ts" } }), true);
  assert.equal(frozenGlobalInputAffectsRender(manifest, new Set(), text(), "not json"), true);
});

test("a lockfile or manifest edit Storybook cannot see selects no frozen story and keeps the frozen inputs; a reachable bump selects all (ISS-14395)", (t) => {
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const base = {
    [first]: "export default { title: \"Composites v1.0/First\" };\nexport const Default = {};\n",
    [second]: "export default { title: \"Composites v1.0/Second\" };\nexport const Default = {};\n",
    [LOCKFILE]: lockfile(),
  };
  const linkOnly = run(t, { base, head: { [LOCKFILE]: lockfile({ analyticsLinks: ANALYTICS_DESIGN_SYSTEM_LINK, storybookSpecifier: "^6.3.0" }) } });
  assert.equal(linkOnly.blocking.some((finding) => finding.rule === "frozen-render"), false);
  const digest = frozenInputs(linkOnly.checkout, linkOnly.baseSha, [first]);
  writeFileSync(path.join(linkOnly.checkout, LOCKFILE), lockfile());
  assert.equal(frozenInputs(linkOnly.checkout, linkOnly.baseSha, [first]), digest);

  const manifest = "apps/storybook/package.json";
  const manifestBase = { ...base, [manifest]: JSON.stringify({ name: "storybook", version: "1.0.0", dependencies: { "@dnd-kit/core": "^6.3.1" } }) };
  const specifierOnly = run(t, { base: manifestBase, head: {
    [manifest]: JSON.stringify({ name: "storybook", version: "1.1.0", dependencies: { "@dnd-kit/core": "^6.3.0" } }),
    [LOCKFILE]: lockfile({ storybookSpecifier: "^6.3.0" }),
  } });
  assert.equal(specifierOnly.blocking.some((finding) => finding.rule === "frozen-render"), false);

  const bumped = run(t, { base, head: { [LOCKFILE]: lockfile({ tslib: "2.8.2" }) } });
  const finding = bumped.blocking.find((entry) => entry.rule === "frozen-render");
  assert.ok(finding);
  assert.match(finding.problem, /2 frozen v1\.0 story files/);
  const bumpedDigest = frozenInputs(bumped.checkout, bumped.baseSha, [first]);
  writeFileSync(path.join(bumped.checkout, LOCKFILE), lockfile());
  assert.notEqual(frozenInputs(bumped.checkout, bumped.baseSha, [first]), bumpedDigest);
});
