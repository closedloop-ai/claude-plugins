import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runFromCanonicalEntry } from "./cli.js";
import { readInput } from "./contracts.js";
import { changeWriter, dropPendingWriter, migrateWriter, readWriterSummary, recordedWriterRoot, registerWriter, takeWriterInput } from "./ledger.js";
import { acquireNativeRecord, releaseNativeRecord, verifyStrandedRecordGrant } from "./native-record.js";
import { installedPluginRoot, resolveAgentRoot } from "./plugin-root.js";
import { asksForUsage, writerStateUsage } from "./usage.js";
import { WorkerRefusal } from "./worker-refusal.js";
export { readWriterSummary } from "./ledger.js";

export async function main(argv: string[]): Promise<number> {
  if (asksForUsage(argv)) {
    process.stdout.write(`${writerStateUsage()}\n`);
    return 0;
  }
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const action = z.enum(["register", "migrate", "status", "enqueue", "start", "claim", "drop-pending", "take-input", "finish", "acquire-record", "release-record"]).parse(positionals[0]);
  if (positionals.length !== 1) throw new Error("Only the action belongs in argv; send private input on stdin");
  const input = await readInput();
  let result;
  try {
    if (action === "register") result = registerWriter(withInstalledRoot(input));
    else if (action === "migrate") {
      result = migrateWriter(input, resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."), verifyStrandedRecordGrant);
    }
    else if (action === "acquire-record") result = acquireNativeRecord(withInstalledRoot(input));
    else if (action === "release-record") result = releaseNativeRecord(input);
    else if (action === "take-input") result = takeWriterInput(input);
    else if (action === "status") result = readWriterSummary(z.object({ worktree: z.string() }).strict().parse(input).worktree) ?? null;
    else {
      if (action === "drop-pending") result = dropPendingWriter(input);
      else {
        const changed = changeWriter(action, input);
        result = { ...changed, ...(changed.turn ? {
          turn: { id: changed.turn.id, lease: changed.turn.lease, status: changed.turn.status },
        } : {}) };
      }
    }
  } catch (error) {
    if (!(error instanceof WorkerRefusal)) throw error;
    process.stdout.write(`${JSON.stringify({ status: "BLOCKED", code: error.code, summary: error.summary })}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
runFromCanonicalEntry(import.meta.url, main);

/** Registrations and grants bind this command's installed plugin root, or the writer's recorded root, unless a valid current one is named. */
function withInstalledRoot(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { agentRoot: supplied, agentName, worktree } = input as { agentRoot?: unknown; agentName?: unknown; worktree?: unknown };
  if (supplied !== undefined && typeof supplied !== "string") return input;
  const recorded = agentName === "vibe-change-worker" && typeof worktree === "string" ? recordedWriterRoot(worktree) : undefined;
  return { ...input, agentRoot: resolveAgentRoot(supplied, installedPluginRoot(import.meta.url), recorded) };
}
