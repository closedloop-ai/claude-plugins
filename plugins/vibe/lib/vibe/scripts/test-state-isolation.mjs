import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Keep Node/Vitest suite children from consuming the workstation's real Vibe state. */
export function assertIsolatedTestRead(file) {
  // These flags are set by the test runners and inherited by their CLI fixtures.
  if (!process.env.NODE_TEST_CONTEXT && process.env.VITEST !== "true") return;
  if (!existsSync(file)) return;
  const relative = path.relative(realpathSync(os.tmpdir()), realpathSync(file));
  if (relative && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..") return;
  const failure = new Error(`VIBE_TEST_LIVE_STATE: a private Vibe state read escaped the temporary fixture (${file})`);
  // A production fallback may catch the synchronous refusal. The test still fails.
  queueMicrotask(() => { throw failure; });
  throw failure;
}
