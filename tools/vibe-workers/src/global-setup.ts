import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { ensureGitCommits } from "../../shared/git-commit-fixture.mjs";
import { PINNED_RELEASE_SHAS, REPO_ROOT } from "./pinned-releases.js";

/**
 * Fetches the pinned release commits once, before any test starts and outside every test and
 * hook timeout. A depth-one CI checkout lacks them; fetching inside a `beforeAll` made that
 * hook's 10 s timeout depend on how fast GitHub served the fetch (ISS-13662).
 */
export default function setup() {
  ensureGitCommits(REPO_ROOT, PINNED_RELEASE_SHAS);
  return bindProviderForRun();
}

/**
 * Runs every test, and every process a test starts, as a chat the ClosedLoop provider is bound to (the repository
 * these suites model): a startup record for one run-scoped chat id, removed when the run ends.
 */
function bindProviderForRun() {
  const chat = `vitest-vibe-workers-${process.pid}`;
  const records = join(os.homedir(), ".codex", "vibe", "plugin-version");
  const file = join(records, `${chat}.json`);
  mkdirSync(records, { recursive: true });
  writeFileSync(file, JSON.stringify({ conversation: chat, status: "current", provider: { state: "bound",
    name: "vibe-closedloop-provider", root: resolve(import.meta.dirname, "../../../plugins/vibe-closedloop-provider"),
    capabilities: ["tickets", "plans", "graph", "memory", "recipes"] } }));
  process.env.CLAUDE_CODE_SESSION_ID = chat;
  process.env.CODEX_THREAD_ID = "";
  return () => rmSync(file, { force: true });
}
