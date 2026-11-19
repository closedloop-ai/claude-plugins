#!/usr/bin/env node
// vibe-core's SessionStart hook (hooks.json): vibe-runtime.mjs hands the event to the vibe this session uses.
import { runEvent } from "./vibe-runtime.mjs";

await runEvent("SessionStart");
