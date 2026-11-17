// Test support for hook entry points that act only in a chat that activated vibe (activation.mjs).
// A test that runs a hook script as a child process gets a private HOME whose hook record says the
// chat loaded vibe:vibe, and adds that chat's session id to each payload that names none.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordHookSkill } from "./hook-session-scope.mjs";

export const ACTIVATED_SESSION = "vibe-activated-chat";

// The ClosedLoop provider beside vibe-core in this repository.
const PROVIDER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vibe-closedloop-provider");

/**
 * `{ home, env, payload }` for a chat that activated vibe; the home is removed after test `t`. With `provider`, the
 * chat's startup record also binds the ClosedLoop provider, as a start in the repository it serves does.
 */
export function activatedChat(t, env = process.env, { provider = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "vibe-activated-chat-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  recordHookSkill(ACTIVATED_SESSION, "vibe:vibe", home);
  if (provider) {
    const records = path.join(home, ".codex", "vibe", "plugin-version");
    mkdirSync(records, { recursive: true });
    writeFileSync(path.join(records, `${ACTIVATED_SESSION}.json`), JSON.stringify({ conversation: ACTIVATED_SESSION, status: "current",
      provider: { state: "bound", name: "vibe-closedloop-provider", root: PROVIDER_ROOT, capabilities: ["tickets", "plans", "graph", "memory", "recipes"] } }));
  }
  return {
    home,
    env: { ...env, HOME: home },
    payload: (event) => (event?.session_id ? event : { session_id: ACTIVATED_SESSION, ...event }),
  };
}
