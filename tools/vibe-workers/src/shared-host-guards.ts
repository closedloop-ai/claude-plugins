import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { LaunchPrecheckError } from "./claude-preflight.js";

/**
 * The fleet slot-lock root. slot-lock.sh writes it on every host that runs fleet slots, so its presence marks a shared
 * fleet host; a scratch or container host has none.
 */
export function fleetSlotRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.SLOT_LOCK_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "fleet-orchestrator", "locks");
}

/**
 * Why a Claude session on a shared fleet host would run with vibe's guards missing or turned off, or null. `settings`
 * is in Claude's precedence order (user, project, local), so a later file's plugin switch wins. vibe-core ships the
 * guard hooks, so turning it off removes them; a vibe plugin turned off matters only when no vibe plugin stays on.
 */
export function sharedHostGuardProblem(settings: ReadonlyArray<{ file: string; value: unknown }>, shared: boolean): string | null {
  if (!shared) return null;
  const switches = new Map<string, { on: unknown; file: string }>();
  for (const { file, value } of settings) {
    const parsed = z.record(z.unknown()).safeParse(value);
    if (!parsed.success) continue;
    const record = parsed.data;
    if (record.disableAllHooks === true) {
      return `${file} sets disableAllHooks, so vibe's guards would not run on this shared fleet host; remove it before launching`;
    }
    const enabled = record.enabledPlugins;
    if (enabled && typeof enabled === "object") for (const [id, on] of Object.entries(enabled)) switches.set(id, { on, file });
  }
  const named = (names: string[]) => [...switches].filter(([id]) => names.includes(id.split("@")[0] ?? ""));
  const core = named(["vibe-core"]).find(([, state]) => state.on === false);
  const vibes = named(["vibe", "vibe-generic"]);
  const off = core ?? (vibes.length && vibes.every(([, state]) => state.on === false) ? vibes[0] : undefined);
  return off ? `${off[1].file} disables ${off[0]}, which carries vibe's guards on this shared fleet host; enable it before launching` : null;
}

/** Refuse a launch whose user or project Claude settings turn vibe's guards off on a shared fleet host. */
export function checkSharedHostGuards(worktree: string, { env = process.env, home = homedir() } = {}): void {
  const files = [join(home, ".claude", "settings.json"), join(worktree, ".claude", "settings.json"), join(worktree, ".claude", "settings.local.json")];
  const settings = files.filter((file) => existsSync(file)).map((file) => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      return { file, value };
    } catch { return { file, value: null }; }
  });
  const problem = sharedHostGuardProblem(settings, existsSync(fleetSlotRoot(env, home)));
  if (problem) throw new LaunchPrecheckError("GUARDS_DISABLED", problem);
}
