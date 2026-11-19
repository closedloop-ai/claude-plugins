#!/usr/bin/env node
// This command lives in vibe's lib/ folder; its skill path keeps working through this wrapper.
import { runVibeCoreMain } from "../../../shared/vibe-core.mjs";

await runVibeCoreMain("lib/codex-fleet-monitor/scripts/work-dir.mjs");
