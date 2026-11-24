import { capturedJson } from "./captured-json.mjs";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const CLOUD_ACCOUNT_UNVERIFIED = "CLOUD_ACCOUNT_UNVERIFIED";
export const CLOUD_ACCOUNT_PIN_MISMATCH = "CLOUD_ACCOUNT_PIN_MISMATCH";
export const REPIN_CLAUDE_ENV = "Re-pin the environment for this account with cloud-worker.mjs pin, then run check.";

const pinError = (code, detail) => Object.assign(new Error(`${code}: ${detail} ${REPIN_CLAUDE_ENV}`), { code });

/** Identify the current Claude account without reading tokens or echoing login metadata. */
export function currentClaudeAccount({ home = os.homedir(), run = spawnSync, profile = readOAuthProfile } = {}) {
  const result = run("claude", ["auth", "status", "--json"], {
    cwd: home, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    if (result.status !== 0) throw new Error("status refused");
    const status = capturedJson(result.stdout);
    if (status.loggedIn !== true || status.authMethod !== "claude.ai" || !status.storedClaudeAiLogin) throw new Error("no active Claude login");
    if (UUID.test(status.accountUuid ?? "")) return status.accountUuid.toLowerCase();
    // Claude's CLI verifies the active login. Older versions keep the UUID only
    // in the same configuration's OAuth profile, so bind it to that live login.
    const config = status.configDirectory;
    if (!path.isAbsolute(config ?? "")) throw new Error("unknown config directory");
    const file = config === path.join(home, ".claude") ? path.join(home, ".claude.json") : path.join(config, ".claude.json");
    const account = profile(file);
    if (!UUID.test(account?.accountUuid ?? "") || !status.email || account.emailAddress?.toLowerCase() !== status.email.toLowerCase()) {
      throw new Error("unverified OAuth identity");
    }
    return account.accountUuid.toLowerCase();
  } catch {
    throw pinError(CLOUD_ACCOUNT_UNVERIFIED, "The active Claude login could not be verified against its account profile.");
  }
}

function readOAuthProfile(file) {
  if (!lstatSync(file).isFile()) return null;
  return JSON.parse(readFileSync(file, "utf8")).oauthAccount;
}

/** Refuse a changed account or environment before any provider action uses a stored pin. */
export function checkEnvironmentPin(environment, pin, accountUuid) {
  if (!UUID.test(accountUuid ?? "")) return pinError(CLOUD_ACCOUNT_UNVERIFIED, "The current Claude account UUID could not be verified.");
  if (pin && (pin.environmentId !== environment.id || pin.accountUuid !== accountUuid)) {
    return pinError(CLOUD_ACCOUNT_PIN_MISMATCH, "The current Claude account or environment differs from the recorded pin.");
  }
  return null;
}
