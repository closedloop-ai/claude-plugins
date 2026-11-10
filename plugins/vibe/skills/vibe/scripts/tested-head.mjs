#!/usr/bin/env node
// This command moved to vibe-core; its vibe path keeps working through this wrapper.
import { runVibeCoreMain } from "../../../shared/vibe-core.mjs";

await runVibeCoreMain("lib/vibe/scripts/tested-head.mjs");
