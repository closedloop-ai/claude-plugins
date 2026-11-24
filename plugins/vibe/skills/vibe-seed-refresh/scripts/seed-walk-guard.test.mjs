import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { checkSeedWalkScope, verifySeedWalkWorktree } from "./seed-walk-guard.mjs";

const MAIN = "9".repeat(40);
const MERGE = "4".repeat(40);
const OLD_ROUTE = "/[orgSlug]/diagnostics";
const PAGE = "apps/app/app/(authenticated)" + OLD_ROUTE + "/page.tsx";
const EXCEPTIONS = "packages/control/src/vibe-walk/route-exceptions.ts";
const WALK_TEST = "packages/control/src/vibe-walk/plan.test.ts";
const MAP = ".claude/skills/control/FEATURE_MAP.md";
const REPO = "closedloop-ai/symphony-alpha";
const OLD_ROW = '  "/[orgSlug]/diagnostics": {\n    treatment: RouteExceptionTreatment.AllowEmpty,\n    reason: "web host is empty",\n  },\n';
const BEFORE = "export const ROUTE_EXCEPTIONS = {\n" + OLD_ROW + '  "/[orgSlug]/stable": { treatment: X },\n};\n';
const CORRECTED = BEFORE.replace(OLD_ROW, "");
const OLD_TEST = 'test("plans a Diagnostics target", () => {\n  expect(targets).toContain("/[orgSlug]/diagnostics");\n});\n';
const CORRECTED_TEST = 'test("plans a Diagnostics target", () => {\n});\n';
const NOT_FOUND = 'import { notFound } from "next/navigation";\nexport default function DiagnosticsPage() { return notFound(); }';
const SCREEN_MAP = "# Screen map\n<!-- control:generated id=shell-route:diagnostics -->\n Desktop only\n<!-- /control:generated -->\n retired web URL (`web-page:/[orgSlug]/diagnostics`)\n";
const PR = { merged: true, merged_at: "2026-10-29T10:28:37Z", user: { type: "User", login: "mikeangstadt" },
  base: { ref: "main", repo: { full_name: REPO } }, merge_commit_sha: MERGE };
const EVIDENCE = { main: MAIN, route: OLD_ROUTE, source: { kind: "merged-pr", number: 9191 } };

function context(overrides = {}) {
  return {
    files: [EXCEPTIONS], captured: MAIN, advertised: MAIN, repo: REPO, evidence: EVIDENCE,
    read: (ref, file) => ({
      [MAIN + ":" + PAGE]: NOT_FOUND,
      [MERGE + ":" + PAGE]: NOT_FOUND,
      [MERGE + "^:" + PAGE]: "export default function DiagnosticsPage() { return <Diagnostics />; }",
      [MAIN + ":" + EXCEPTIONS]: BEFORE,
      [MAIN + ":" + WALK_TEST]: OLD_TEST,
      [MAIN + ":" + MAP]: SCREEN_MAP,
    })[ref + ":" + file] ?? null,
    candidate: (file) => file === EXCEPTIONS ? CORRECTED : CORRECTED_TEST,
    pull: () => PR,
    ancestor: (a, b) => a === MERGE && b === MAIN,
    ...overrides,
  };
}

test("ISS-14476 seed refresh retires the obsolete AllowEmpty route under the merged human PR and generated map", () => {
  const pr = checkSeedWalkScope(context({ files: [EXCEPTIONS, WALK_TEST] }));
  assert.deepEqual(pr, { status: "CONTINUE", route: OLD_ROUTE, source: { url: "https://github.com/" + REPO + "/pull/9191",
    author: "mikeangstadt", mergedAt: PR.merged_at, main: MAIN } });
  const map = checkSeedWalkScope(context({ evidence: { ...EVIDENCE, source: { kind: "feature-map" } } }));
  assert.equal(map.status, "CONTINUE");
  assert.match(map.source.url, /FEATURE_MAP\.md$/);
});

test("ISS-14476 seed walk fails closed on missing, unmerged, nonhuman, stale or unrelated authority", () => {
  for (const invalid of [
    { evidence: null },
    { pull: () => ({ ...PR, merged: false }) },
    { pull: () => ({ ...PR, user: { login: "workflow-agent", type: "User" } }) },
    { pull: () => ({ ...PR, user: { login: "github-actions[bot]", type: "Bot" } }) },
    { ancestor: () => false },
    { read: (ref, file) => ref === MERGE ? null : context().read(ref, file) },
  ]) assert.equal(checkSeedWalkScope(context(invalid)).status, "NEEDS_PERSON");
  assert.match(checkSeedWalkScope(context({ advertised: "a".repeat(40) })).reason, /refresh exact current/);
  assert.match(checkSeedWalkScope(context({ evidence: { ...EVIDENCE, route: "/[orgSlug]/other" } })).reason, /does not prove a 404/);
});

test("ISS-14476 seed scope permits only the exact route-owned correction through the effective index", (t) => {
  const f = makeHome("vibe-seed-walk-guard-");
  t.after(f.cleanup);
  const gitDir = path.join(f.root, "gitdir");
  mkdirSync(gitDir);
  writeFileSync(path.join(gitDir, "vibe-seed-walk-proof.json"), JSON.stringify(EVIDENCE));
  let staged = CORRECTED;
  let files = [EXCEPTIONS, "apps/api/scripts/vibe-seed/stages/example.ts"];
  const open = (worktree, argv) => {
    const [command, value, item] = argv;
    if (command === "rev-parse") return value === "--absolute-git-dir" ? gitDir : MAIN;
    if (command === "remote") return "git@github.com:" + REPO + ".git";
    if (command === "ls-remote") return MAIN + "\trefs/heads/main\n";
    if (command === "diff") {
      assert.equal(value, "--cached");
      assert.equal(item, "--name-only");
      return files.join("\0");
    }
    if (command === "merge-base") return "";
    if (command === "show") {
      if (value === ":" + EXCEPTIONS) return staged;
      const [ref, file] = value.split(":");
      const found = context().read(ref, file);
      if (found !== null) return found;
    }
    throw new Error("fixture object absent");
  };
  const guarded = () => verifySeedWalkWorktree(f.root, { staged: true, git: open, pull: () => PR });
  assert.equal(guarded().status, "CONTINUE");
  staged = CORRECTED.replace("treatment: X", "treatment: Y");
  assert.match(guarded().reason, /exceed the verified/);
  staged = "";
  assert.match(guarded().reason, /exceed the verified/);
  files = [EXCEPTIONS, PAGE];
  assert.match(guarded().reason, /cannot edit product/);
  files = [MAP];
  assert.match(guarded().reason, /FEATURE_MAP/);
  files = ["docs/unrelated.md"];
  assert.match(guarded().reason, /unrelated/);
});
