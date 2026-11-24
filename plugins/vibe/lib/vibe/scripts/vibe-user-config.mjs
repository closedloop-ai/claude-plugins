import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquire, release } from "./e2e-lock.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

/** The existing private per-person Vibe configuration. */
export function vibeUserConfigFile(home = os.homedir()) {
  return path.join(home, ".codex", "vibe", "config.json");
}

/** Read only this person's configuration, including any independently owned preferences. */
export function readVibeUserConfig(home = os.homedir()) {
  const file = vibeUserConfigFile(home);
  if (!existsSync(file)) return {};
  const value = regularJson(file);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vibe user config must be a JSON object");
  return value;
}

/** Merge a single owned preference without losing simultaneous writes by another Vibe command. */
export async function updateVibeUserConfig(home, change) {
  const file = vibeUserConfigFile(home);
  const lock = path.join(path.dirname(file), "locks", "user-config");
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, token: randomUUID(), purpose: "vibe-user-config" };
  const held = await acquire(lock, owner, { waitSeconds: 3, pollMs: 20 });
  if (!held.acquired) throw new Error("Vibe user config is busy. Retry the same operation.");
  try {
    const current = readVibeUserConfig(home);
    const { config, result } = change(current);
    if (config !== current) writeAtomic(file, config);
    return result;
  } finally { release(lock, owner); }
}
