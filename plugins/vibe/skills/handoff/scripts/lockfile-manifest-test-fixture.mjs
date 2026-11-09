import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCheckout, makeHome, runNode, SYMPHONY_PATH_POLICY } from "../../vibe/scripts/test-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INVENTORY = path.join(HERE, "handoff-inventory.mjs");
const SESSIONS = path.join(HERE, "..", "..", "vibe", "scripts", "vibe-sessions.mjs");
const ALLOWLIST = "scripts/lint/source-gate-allowlist.json";
const FOCUS_RING = { rule: "no-hand-rolled-focus-ring", file: "packages/app/a.tsx", fingerprint: "packages/app/a.tsx", count: 1, reason: "seeded" };
const HEX = { rule: "no-hex-color-in-jsx-styling", file: "apps/app/b.tsx", fingerprint: "apps/app/b.tsx", count: 3, reason: "seeded" };
const allowlist = (entries) =>
  `${JSON.stringify({ registeredRules: ["no-hand-rolled-focus-ring", "no-hex-color-in-jsx-styling"], entries }, null, 2)}\n`;

export function setup(t, slug, extraFiles = {}, { repoName = "symphony-alpha", remoteUrl, declared = true } = {}) {
  const fixture = makeHome("handoff-inventory-lockfile-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "Documents", "Closedloop.ai - Active Work", repoName);
  const { origin } = makeCheckout({
    root: fixture.root,
    home: fixture.home,
    checkout,
    files: {
      "scripts/loops-setup.sh": "echo old\n",
      ".github/workflows/ci.yml": "on: push\n",
      "apps/app/page.tsx": "export const page = 1;\n",
      [ALLOWLIST]: allowlist([FOCUS_RING, HEX]),
      ...(declared ? { "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY } : {}),
      ...extraFiles,
    },
    ...(remoteUrl ? { remoteUrl } : {}),
  });
  const created = runNode(
    SESSIONS,
    ["new", "--repo", checkout, "--slug", slug, "--summary", slug, "--mode", "seeded", "--operator-id", "user-operator", "--operator-email", "operator@example.com"],
    fixture.home,
  );
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, checkout, origin, worktree: created.json.session.worktree };
}

export function write(worktree, target, content) {
  const absolute = path.join(worktree, target);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

export { runNode, SYMPHONY_PATH_POLICY };
export const storybookManifest = (query, version = "^5.90.20") => `${JSON.stringify({ name: "storybook", dependencies: { react: "^19.0.0", ...(query ? { "@tanstack/react-query": version } : {}) } }, null, 2)}\n`;
export const lockfile = ({ query = false, other = false, resolved = false, rogue = false } = {}) => `lockfileVersion: '9.0'

importers:

  apps/storybook:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.0.0
${query ? `      '@tanstack/react-query':
        specifier: ^5.90.20
        version: 5.90.21(react@19.0.0)
` : ""}${other ? `  apps/unrelated:
    dependencies:
      rogue:
        specifier: ^1.0.0
        version: 1.0.0
` : ""}${rogue ? `  packages/rogue:
    dependencies:
      rogue:
        specifier: ^1.0.0
        version: 1.0.0
` : ""}packages:

  react@19.0.0:
    resolution: {integrity: sha512-react}
${resolved ? `  '@tanstack/react-query@5.90.21':
    resolution: {integrity: sha512-query}

  '@tanstack/query-core@5.90.21':
    resolution: {integrity: sha512-core}
` : ""}snapshots:

  react@19.0.0: {}
${resolved ? `  '@tanstack/react-query@5.90.21(react@19.0.0)':
    dependencies:
      '@tanstack/query-core': 5.90.21
      react: 19.0.0

  '@tanstack/query-core@5.90.21': {}
` : ""}`;
export const lockfileWithPnpmDocument = (options) => `---
lockfileVersion: '9.0'

importers:
  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

---
${lockfile(options)}`;
