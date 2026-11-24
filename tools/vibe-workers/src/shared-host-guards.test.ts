import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSharedHostGuards, fleetSlotRoot, sharedHostGuardProblem } from "./shared-host-guards.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("AC-13 shared-host guards", () => {
  it("AC-13 refuses a Claude launch on a shared fleet host whose settings turn vibe's guards off, and allows it elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "guards-"));
    roots.push(root);
    const home = join(root, "home");
    const worktree = join(root, "wt");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(worktree, ".claude"), { recursive: true });
    const env = { XDG_STATE_HOME: join(home, ".local", "state") };
    const launch = () => checkSharedHostGuards(worktree, { env, home });
    writeFileSync(join(worktree, ".claude", "settings.local.json"), JSON.stringify({ disableAllHooks: true }));
    expect(launch).not.toThrow();
    mkdirSync(fleetSlotRoot(env, home), { recursive: true });
    expect(launch).toThrow(/settings\.local\.json sets disableAllHooks, so vibe's guards would not run on this shared fleet host/);
    writeFileSync(join(worktree, ".claude", "settings.local.json"), "{}");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": false } }));
    expect(launch).toThrow(/disables vibe@closedloop-ai, which carries vibe's guards/);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vibe@closedloop-ai": true, "other@market": false } }));
    expect(launch).not.toThrow();
  });
  it("AC-13 marks a shared fleet host by the fleet slot-lock root and reads only real off switches", () => {
    expect(fleetSlotRoot({ SLOT_LOCK_DIR: "/locks" }, "/h")).toBe("/locks");
    expect(fleetSlotRoot({}, "/h")).toBe("/h/.local/state/fleet-orchestrator/locks");
    const off = [{ file: "s.json", value: { enabledPlugins: { "vibe-core@market": false } } }];
    expect(sharedHostGuardProblem(off, false)).toBeNull();
    expect(sharedHostGuardProblem(off, true)).toMatch(/disables vibe-core@market/);
    expect(sharedHostGuardProblem([{ file: "s.json", value: { disableAllHooks: false } }], true)).toBeNull();
    const both = (generic: boolean, closedloop: boolean) => [{ file: "s.json", value: { enabledPlugins: { "vibe-generic@m": generic, "vibe@m": closedloop } } }];
    expect(sharedHostGuardProblem(both(false, true), true)).toBeNull();
    expect(sharedHostGuardProblem(both(false, false), true)).toMatch(/disables vibe-generic@m/);
    const later = [{ file: "user.json", value: { enabledPlugins: { "vibe@m": false } } }, { file: "local.json", value: { enabledPlugins: { "vibe@m": true } } }];
    expect(sharedHostGuardProblem(later, true)).toBeNull();
  });
});
