import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { syncFixture } from "./main-sync-test-fixtures.js";
import { fixture } from "./test-fixtures.js";

const directories: string[] = [];
const fixtures: ReturnType<typeof fixture>[] = [];
const traceEvent = z.object({ event: z.string(), argv: z.array(z.string()).optional() });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const value of fixtures.splice(0)) value.cleanup();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("disposable Git fixture lifetime", () => {
  it.each([["session", fixture], ["session and bare origin", syncFixture]] as const)(
    "%s finishes automatic maintenance before cleanup even when the host enables detachment", (_name, createFixture) => {
      const directory = mkdtempSync(join(tmpdir(), "vibe-fixture-maintenance-"));
      directories.push(directory);
      const globalConfig = join(directory, "gitconfig");
      const trace = join(directory, "git-trace.jsonl");
      writeFileSync(globalConfig, "[gc]\n\tautoDetach = true\n");
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_TRACE2_EVENT", trace);
      expect(execFileSync("git", ["config", "--global", "--get", "gc.autoDetach"],
        { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim()).toBe("true");

      const value = createFixture();
      fixtures.push(value);
      const events = readFileSync(trace, "utf8").trim().split("\n")
        .map(line => traceEvent.parse(JSON.parse(line)));
      const maintenance = events.filter(event => event.event === "child_start"
        && event.argv?.[0] === "git" && event.argv[1] === "maintenance");
      expect(maintenance.length).toBeGreaterThan(0);
      for (const event of maintenance) expect(event.argv).toContain("--no-detach");

      value.cleanup();
      fixtures.pop();
      expect(existsSync(value.base)).toBe(false);
    });
});
