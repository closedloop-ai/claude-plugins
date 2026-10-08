import { parseArgs } from "node:util";
import { z } from "zod";
import { runFromCanonicalEntry } from "./cli.js";
import { readInput } from "./contracts.js";
import { changeWriter, readWriterSummary, registerWriter, takeWriterInput } from "./ledger.js";
import { acquireNativeRecord, releaseNativeRecord } from "./native-record.js";
export { readWriterSummary } from "./ledger.js";

export async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const action = z.enum(["register", "status", "enqueue", "claim", "take-input", "finish", "acquire-record", "release-record"]).parse(positionals[0]);
  if (positionals.length !== 1) throw new Error("Only the action belongs in argv; send private input on stdin");
  const input = await readInput();
  let result;
  if (action === "register") result = registerWriter(input);
  else if (action === "acquire-record") result = acquireNativeRecord(input);
  else if (action === "release-record") result = releaseNativeRecord(input);
  else if (action === "take-input") result = takeWriterInput(input);
  else if (action === "status") result = readWriterSummary(z.object({ worktree: z.string() }).strict().parse(input).worktree) ?? null;
  else {
    const changed = changeWriter(action, input);
    result = { ...changed, ...(changed.turn ? {
      turn: { id: changed.turn.id, lease: changed.turn.lease, status: changed.turn.status },
    } : {}) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}
runFromCanonicalEntry(import.meta.url, main);
