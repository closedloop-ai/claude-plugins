// This module moved to vibe. A vibe older than this vibe-core runs it from here as its headless writer's
// protected-write hook, registered to block on failure, so it says how to fix that and exits 0: nothing is
// refused while vibe's guards cannot load.
import { writeSync } from "node:fs";

writeSync(2, "vibe-core is newer than your vibe. To fix: run `claude plugin update vibe@closedloop-ai` then start a new Claude Code session, or run `codex plugin add vibe@closedloop-ai` then quit and reopen the Codex app.\n");
process.exit(0);
