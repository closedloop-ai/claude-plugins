#!/usr/bin/env node
// The vibe plugin's only PreCompact hook. In a fleet-orchestrator chat it prints
// instructions for Claude Code's compaction summary (context-guard.mjs
// compactionInstructions); Claude Code uses a PreCompact hook's stdout that way
// when it exits 0. Elsewhere it prints nothing, and it never blocks compaction.
//
// Usage (hook): reads the PreCompact JSON on stdin; prints the instructions or nothing.

import { compactionInstructions } from "./context-guard.mjs";
import { isMain, runHookScript } from "./hook-dispatch.mjs";

if (isMain(import.meta.url)) runHookScript("pre-compact", (event) => compactionInstructions(event));
