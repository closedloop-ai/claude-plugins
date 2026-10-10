import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MainSyncError } from "./main-sync-contracts.js";
import { reportOutputs } from "./main-sync-input-catalog.js";
import { committedInputReferences } from "./main-sync-private-inputs.js";
import type { CheckCommand } from "./main-sync-lanes.js";

const REPLAY = /(?:^|[\s=])--(?:merge-reports|last-failed)(?:\b|=)|(?:^|[\s/])assert-e2e-results(?:\.mjs)?\b/;
const SELECTED_SCRIPTS = new Set(["test", "test:affected", "typecheck:affected", "test:lint", "test:skills", "test:renderer",
  "typecheck", "check:source-gates", "verify", "test:lanes", "validate:catalog"]);
const packageScripts = z.object({ scripts: z.record(z.string()).optional() }).passthrough();
let verified: { root: string; head: string } | undefined;

/** Retained artifacts are output-only only for the fixed non-replay readers; their bodies never prove coverage. */
export function verifyRetainedReportInputs(root: string, head: string) {
  if (verified?.root === root && verified.head === head) return;
  if (committedInputReferences(root, (file, value) => {
    const target = relative(root, resolve(dirname(join(root, file)), value));
    return reportOutputs.has(target) || reportOutputs.has(value);
  })) throw new MainSyncError("A committed reader consumes retained report evidence; no output-only admission", "NEEDS_CHANGE");
  for (const file of git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean)) {
    if (file !== "package.json" && !file.endsWith("/package.json")) continue;
    const scripts = packageScripts.parse(JSON.parse(readFileSync(join(root, file), "utf8"))).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (SELECTED_SCRIPTS.has(name) && REPLAY.test(command)) {
        throw new MainSyncError(`Selected validation script reads retained replay/report inputs: ${file}:${name}`, "NEEDS_CHANGE");
      }
    }
  }
  verified = { root, head };
}

/** Actual structured recipe argv is checked again; caller text cannot authorize replay or retained-result verdicts. */
export function verifyReportRecipe(commands: readonly CheckCommand[]) {
  for (const command of commands) {
    if (REPLAY.test(command.argv.join(" "))) throw new MainSyncError("Selected recipe consumes retained report/replay inputs without current owned output isolation", "NEEDS_CHANGE");
  }
}
