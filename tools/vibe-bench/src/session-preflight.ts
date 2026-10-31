import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Local-only session fixture written through the pinned plugin's own helper. */
export async function writeBenchmarkSessionRecord(
  vibeDir: string,
  checkout: string,
  branch: string,
  mode: "seeded",
  baseCommit: string,
): Promise<void> {
  if (!/^benchmark\/[a-z0-9-]+$/.test(branch) || !/^[a-f0-9]{40}$/.test(baseCommit)) {
    throw new Error("benchmark-session-input-invalid");
  }
  const helper = await import(pathToFileURL(join(vibeDir,
    "skills/vibe/scripts/session-record.mjs")).href) as {
      readSessionRecord(path: string): unknown;
      writeSessionRecord(path: string, record: unknown): void;
  };
  if (helper.readSessionRecord(checkout)) throw new Error("benchmark-session-already-exists");
  const now = new Date().toISOString();
  // This mirrors the canonical session fields while intentionally omitting a
  // live operator, ticket, Vercel destination and Desktop session. The fake
  // checkout and local stack supply only the boundary this benchmark needs.
  const record = {
    slug: branch.slice("benchmark/".length), branch,
    summary: "ISS-13401 local Projects search benchmark",
    ticket: null, status: "active", mode, operator: null,
    liveTicket: null, livePlan: null, livePlanStatus: null,
    baseCommit, createdAt: now, lastActiveAt: now,
    vercel: null, flagSnapshot: null, clerkOrgId: null,
    desktopAuthSavedAt: null, codexSessions: { orchestrators: [], subagents: [] },
    claudeSessions: { orchestrators: [] }, stack: null, localFixes: [],
    benchmarkFixture: true,
  };
  helper.writeSessionRecord(checkout, record);
  const observed = helper.readSessionRecord(checkout) as { benchmarkFixture?: boolean; baseCommit?: string } | null;
  if (!observed?.benchmarkFixture || observed.baseCommit !== baseCommit) {
    throw new Error("benchmark-session-record-mismatch");
  }
}

/** Real plugin version check, charged to each measured Claude conversation. */
export function checkVibeVersion(
  vibeDir: string,
  checkout: string,
  runDir: string,
  sessionId: string,
  claudeExecutable: string,
): { status: "current" | "unknown" | "outdated"; choice: "proceed" | null } {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId)) throw new Error("benchmark-session-id-invalid");
  // The plugin's CLI main guard compares import.meta.url with argv[1]. macOS
  // resolves /tmp to /private/tmp for imports, so pass the physical path.
  const script = realpathSync(join(vibeDir, "skills/vibe/scripts/plugin-version.mjs"));
  const state = join(runDir, "plugin-version.json");
  const args = [script, "check", "--runtime", "claude", "--conversation", sessionId,
    "--state", state, "--claude", claudeExecutable,
    "--closedloop", "not-connected", "--graph", "not-connected"];
  const output = execFileSync(process.execPath, args, {
    cwd: checkout, encoding: "utf8", timeout: 90_000,
  });
  const checked = JSON.parse(output) as { status?: string; conversation?: string; recordError?: string };
  if (checked.conversation !== sessionId || checked.recordError ||
      !["current", "unknown", "outdated"].includes(checked.status ?? "")) {
    throw new Error("benchmark-plugin-version-check-invalid");
  }
  let choice: "proceed" | null = null;
  if (checked.status === "outdated") {
    // The operator explicitly pinned this run to an exact main snapshot.
    // Record that opening-message choice; never update installed plugins.
    const chosen = JSON.parse(execFileSync(process.execPath, [script, "choose", "--choice", "proceed",
      "--by", "opening-message", "--conversation", sessionId, "--state", state], {
      cwd: checkout, encoding: "utf8", timeout: 15_000,
    })) as { choice?: { choice?: string }; ok?: boolean };
    if (chosen.ok !== true || chosen.choice?.choice !== "proceed") {
      throw new Error("benchmark-plugin-version-choice-invalid");
    }
    choice = "proceed";
  }
  const saved = JSON.parse(readFileSync(state, "utf8")) as {
    conversation?: string; status?: string; choice?: { choice?: string };
  };
  if (saved.conversation !== sessionId || saved.status !== checked.status ||
      (checked.status === "outdated" && saved.choice?.choice !== "proceed")) {
    throw new Error("benchmark-plugin-version-record-invalid");
  }
  return { status: checked.status as "current" | "unknown" | "outdated", choice };
}
