/**
 * What plugins/vibe-core may hold. Codex fingerprints every file in a plugin (codex-plugin-fingerprint.ts) and
 * asks every Codex user to approve its hooks again whenever that changes, so vibe-core holds only the hook loader
 * and the frozen stubs at the paths of the modules that moved to vibe. vibe-core-bundle.test.ts checks the bundle
 * against this list, the loader's import closure, its line budget and the pinned fingerprint in
 * vibe-core-bundle.json.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const VIBE_CORE_DIR = join(REPO_ROOT, "plugins", "vibe-core");
export const BUNDLE_PIN_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "vibe-core-bundle.json");

/** The hook entry modules hooks/hooks.json runs, one per event. */
export const ENTRY_FILES = Object.freeze([
  "hooks/post-tool-use.mjs",
  "hooks/pre-compact.mjs",
  "hooks/pre-tool-use.mjs",
  "hooks/session-start.mjs",
  "hooks/user-prompt-submit.mjs",
]);

/** The files vibe-core ships besides the stubs. */
export const THIN_FILES = Object.freeze([
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "README.md",
  "hooks/hooks.json",
  ...ENTRY_FILES,
  "hooks/vibe-runtime.mjs",
  "shared/plugin-roots.mjs",
  "shared/vibe-install.mjs",
]);

/** The only module allowed one dynamic import with a computed specifier: the import of vibe's hooks/runtime.mjs. */
export const LOADER_FILE = "hooks/vibe-runtime.mjs";

/** The thin set's line budget. */
export const THIN_LINE_BUDGET = 900;

/**
 * The stubs a pre-slim launcher runs as a hook command that blocks on failure: they exit 0 instead of 1, since nothing
 * is refused while vibe's guards cannot load. Every other stub is byte-identical.
 */
export const HOOK_COMMAND_STUBS = Object.freeze(["hooks/protected-write-guard.mjs"]);

/**
 * The modules that moved from vibe-core to vibe (test support included, test files not), each kept here as a stub
 * (byte-identical, except that HOOK_COMMAND_STUBS differ in their header comment and exit code) that tells a vibe
 * older than this vibe-core how to update it: such a vibe imports these paths from vibe-core, and its headless
 * writer launcher runs hooks/protected-write-guard.mjs as a hook command.
 */
export const STUB_FILES = Object.freeze([
  ...[
    "activation-test-support", "activation", "agent-guard", "app-binary-guard", "away-protocol", "command-calls",
    "command-segments", "context-guard", "delivery-placement-guard", "fleet-resume", "foreground-guard",
    "hook-dispatch", "hook-session-scope", "kill-guard", "merge-guard", "pause-guard", "plugin-version-guard",
    "pr-create-guard", "program-change", "protected-write-guard", "question-guard", "shell-safety-guard",
    "skill-transcript", "unit-status-guard",
  ].map((name) => `hooks/${name}.mjs`),
  ...[
    "liveness", "work-dir",
  ].map((name) => `lib/codex-fleet-monitor/scripts/${name}.mjs`),
  ...[
    "chat-binding", "cloud-placement", "delivery-placement", "fleet-handoff", "fleet-home", "fleet-migrate",
    "helpers", "scratch-cleanup", "skill-freshness",
  ].map((name) => `lib/fleet-orchestrator/scripts/${name}.mjs`),
  ...[
    "codex-review-runtime", "decision-table-gate", "gate-override", "handoff-evidence", "handoff-gate-check",
    "mcp-tool-names", "review-premises", "review-receipts", "ticket-names", "unit-review-record",
  ].map((name) => `lib/handoff/scripts/${name}.mjs`),
  ...[
    "cloud-environment", "cloud-import", "cloud-receipts", "cloud-repository", "cloud-routines", "cloud-worker",
    "docker-disk-admission", "e2e-lock", "github-remote", "harness-identity", "image-head", "loaded-skill",
    "owned-builder", "owned-cleanup", "owned-docker", "owned-state", "plugin-script-references", "provider-brief",
    "provider", "repository-commands", "required-visual-qa", "review-models", "sandbox-refusal",
    "session-artifact-paths", "session-record", "startup-record", "test-state-isolation", "tested-head",
    "upstream-branch", "worker-scope", "workflow-lane-definitions",
  ].map((name) => `lib/vibe/scripts/${name}.mjs`),
  ...[
    "process-identity",
  ].map((name) => `shared/${name}.mjs`),
].sort());

interface BundlePin {
  version: string;
  fingerprint: string;
}

export function readBundlePin(): BundlePin {
  return JSON.parse(readFileSync(BUNDLE_PIN_FILE, "utf8")) as BundlePin;
}

export function bundleVersion(): string {
  return (JSON.parse(readFileSync(join(VIBE_CORE_DIR, ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
}

export function toBundlePath(file: string): string {
  return relative(VIBE_CORE_DIR, file).split("\\").join("/");
}
