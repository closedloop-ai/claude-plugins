import { writeFileSync } from "node:fs";
import { runBoundedDetailed } from "../../vibe/scripts/run-bounded.mjs";
import { readProcessStart } from "../../../shared/process-identity.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

/** Write capture timing only after slot admission and cleanup of the command group. */
export async function captureCommand(timing, pidFile, command, args) {
  if (!timing || !command) throw new Error("capture-command needs a timing file and command");
  const started = Date.now();
  if (pidFile) {
    const startedAt = readProcessStart(process.pid);
    if (!startedAt) throw new Error("cannot record the capture supervisor's process identity");
    writeFileSync(pidFile, `${process.pid}\n${startedAt}\n`, { mode: 0o600 });
  }
  try {
    return (await runBoundedDetailed(command, args, { seconds: null, drainGroup: true })).code;
  } finally {
    writeFileSync(timing, `${Math.floor((Date.now() - started) / 1000)}\n`, { mode: 0o600 });
  }
}

if (isEntryPoint(import.meta.url)) {
  const [timing, pidFile, command, ...args] = process.argv.slice(2);
  try { process.exitCode = await captureCommand(timing, pidFile, command, args); }
  catch (error) { process.stderr.write(`capture-command: ${error.message}\n`); process.exitCode = 2; }
}
