// This module moved to vibe. A vibe older than this vibe-core still loads it from here, so it says how to fix that.
import { writeSync } from "node:fs";

writeSync(2, "vibe-core is newer than your vibe. To fix: run `claude plugin update vibe@closedloop-ai` then start a new Claude Code session, or run `codex plugin add vibe@closedloop-ai` then quit and reopen the Codex app.\n");
process.exit(1);
