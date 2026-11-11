// The deterministic steps of a vibe and fleet walk in a repository with no provider: a personal GitHub repository
// with npm, Playwright and an AGENTS.md naming `npm test` and `npm run dev`, no tracker, graph, seed, Storybook or
// Desktop, with the provider absent or present and disabled. Each step either runs here against that repository or
// names the test, in the suite that runs it, that proves it; the ledger of steps that still block a generic session
// must be empty.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { repositoryAreas } from "./area-paths.mjs";
import { localPlanPaths } from "./local-plans.mjs";
import { providerOffer, statusBlock } from "./plugin-version.mjs";
import { createSetupCtl } from "./setup-ctl.mjs";
import { workItem } from "./tracker-key.mjs";
import { CLASSES, classify } from "./vibe-triage.mjs";
import { DEFAULT_PATH_POLICY } from "../../handoff/scripts/path-classifier.mjs";

const { providerCandidate } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { cloudRules } = await vibeCore("lib/vibe/scripts/cloud-worker.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS = path.resolve(HERE, "../../../..");
const PROVIDER_WORDS = /closedloop|symphony|\b(?:ISS|PRD|PLN|FEA)-\d/i;

/** The walk's repository: a git checkout whose session record pins no provider. */
function personalRepository(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "vibe-generic-walk-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "vibe/dark-mode");
  writeFileSync(path.join(root, "AGENTS.md"), "Run the tests with `npm test`. Start the app with `npm run dev`.\n");
  writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "settings.js"), "export const settings = {};\n");
  git("add", ".");
  git("-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-qm", "base");
  writeFileSync(path.join(git("rev-parse", "--absolute-git-dir"), "vibe-session.json"),
    JSON.stringify({ branch: "vibe/dark-mode", slug: "dark-mode", provider: { state: "none" } }));
  return { root, git };
}

/** Steps another suite runs end to end, by file and test name; the ledger checks each still exists. */
const COVERED_ELSEWHERE = [
  ["D1 preflight passes any checkout", "plugins/vibe/skills/vibe/scripts/vibe-preflight.test.mjs",
    "the checkout this command runs in is used, spaces and all, whatever its remote, and remembered"],
  ["D2 repository resolution order", "plugins/vibe/skills/vibe/scripts/vibe-preflight.test.mjs",
    "--repo wins over the working folder and remembers the main checkout of a worktree"],
  ["D6 workers launch with no graph capability", "tools/vibe-workers/src/claude-worker.test.ts",
    "requires the parent's graph tools only with a graph bound"],
  ["D7 session record with no tracker, operator from GitHub", "plugins/vibe/skills/vibe/scripts/vibe-sessions.test.mjs",
    "with no provider bound a session has no hosted environment or tracker"],
  ["D8 the checkout never shows a session worktree", "plugins/vibe/skills/vibe/scripts/vibe-sessions.test.mjs",
    "a repository that does not ignore session worktrees excludes them locally"],
  ["D10 no hosted environment is requested without a recipe", "plugins/vibe/skills/vibe/scripts/env-ctl.test.mjs",
    "with no environment recipe, requests are refused before any gh call"],
  ["D14 a commit takes the subject it is given", "plugins/vibe/skills/vibe/scripts/commit-worktree.test.mjs",
    "refuses a missing, multi-line, or over-long subject and commits nothing"],
  ["D15 lanes from the AGENTS.md test command", "plugins/vibe/skills/handoff/scripts/ci-job-shape.test.mjs",
    "with no declaration a lane command is the AGENTS.md test command"],
  ["D15 the built-in path default", "plugins/vibe/skills/handoff/scripts/handoff-inventory.test.mjs",
    "with no target declaration the built-in default admits every path"],
  ["D18 the PR override takes any reference", "plugins/vibe-core/hooks/pr-create-guard.test.mjs",
    "the override names its ticket the way the session's tracker does"],
  ["D21 no status sweep without a tracker", "plugins/vibe/skills/fleet-orchestrator/scripts/board.test.mjs",
    "with no tracker bound a watched program needs only its green-watch owner"],
  ["D23 hooks stay silent in a plain chat", "plugins/vibe-core/hooks/activation.test.mjs",
    "a chat that never activated vibe gets no output, no write and no gh call"],
  ["main sync runs the AGENTS.md test command", "tools/vibe-workers/src/main-sync-recipe.test.ts",
    "without a provider recipe has no generated inputs"],
];

test("the generic walk's deterministic steps leave an empty blocker ledger", async (t) => {
  const { root } = personalRepository(t);
  const ledger = [];
  const step = async (name, probe) => {
    try {
      const blocker = await probe();
      if (blocker) ledger.push(`${name}: ${blocker}`);
    } catch (error) {
      ledger.push(`${name}: ${error.message}`);
    }
  };

  await step("D4 versions and connections", () => {
    const candidate = providerCandidate({ cwd: root, providers: [] });
    if (candidate.state !== "none") return `a provider is a candidate: ${JSON.stringify(candidate)}`;
    const block = statusBlock({ harnesses: [] }, {}, candidate.connections ?? {});
    return PROVIDER_WORDS.test(block) ? `the setup check names a provider: ${block}` : null;
  });
  await step("D4 a disabled provider binds nothing and is never offered", () => {
    const disabled = { name: "vibe-closedloop-provider", root: "/nowhere", version: "1.0.0", enabled: false, contract: {} };
    const candidate = providerCandidate({ cwd: root, providers: [disabled] });
    if (candidate.state !== "none") return `a disabled provider is a candidate: ${JSON.stringify(candidate)}`;
    return providerOffer(candidate, null) ? "a disabled provider is offered for install" : null;
  });
  await step("D4 install offer stays an offer", () => {
    const offer = providerOffer({ state: "none", reason: "no provider is installed" }, null);
    return offer?.connection ? null : "no install offer for a machine with no provider";
  });
  await step("D9 bootstrap from the lockfile", async () => {
    const ran = [];
    const setup = createSetupCtl({ recipe: () => null, exists: (file) => file === path.join(root, "package-lock.json"),
      run: (command, args) => { ran.push([command, ...args].join(" ")); return { status: 0, stdout: "", stderr: "" }; } });
    const result = await setup.bootstrap({ worktree: root });
    return result.status === "OK" && result.command === "npm ci" ? null : `bootstrap ${JSON.stringify(result)}`;
  });
  await step("D11 triage never picks a lighter class from an unknown layout", () => {
    const manifest = classify({ paths: ["src/settings.js"], areas: repositoryAreas(null) });
    return manifest.class === CLASSES.Unknown ? null : `class ${manifest.class}`;
  });
  await step("D12 plans stay in the private git directory", () => {
    const paths = localPlanPaths(root, { requestId: "first", binding: null });
    return !paths.inWorktree && !paths.plan.startsWith(`${root}${path.sep}src`) && paths.root.includes(`${path.sep}.git${path.sep}`)
      ? null : `plans at ${paths.root}`;
  });
  await step("D15 handoff paths without a declaration", () =>
    DEFAULT_PATH_POLICY.allowedPrefixes.includes("") ? null : "the default path policy classifies nothing");
  await step("D20 fleet units are local work ids", () => {
    const item = workItem(root);
    return item.test("#12") && !item.test("ISS-12") ? null : `work item ${item}`;
  });
  await step("D22 cloud dispatch attaches no connector", () => {
    const rules = cloudRules(null);
    return rules.connectors.size === 0 && rules.graphTools === null ? null : "the cloud dispatch expects a provider";
  });
  for (const [name, file, testName] of COVERED_ELSEWHERE) {
    await step(name, () => {
      const text = readFileSync(path.join(PLUGINS, "..", file), "utf8");
      return !testName || text.includes(testName) ? null : `${file} no longer holds "${testName}"`;
    });
  }
  assert.deepEqual(ledger, []);
});
