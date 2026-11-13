import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Most tests here start git, the bundled CLIs and fake claude processes one after
// another. Vitest's default of one worker per core but one ran 17 files at once on an
// 18-core Mac; they competed for process start-up, the slowest tests ran 3 to 5 times
// longer than alone and crossed their timeouts. Three workers ran the full suite in the
// same wall time (555 s against 554 s) with every test within 1.4 times its time alone
// (ISS-13171). src/test-budget.test.ts keeps this cap and lets a per-test timeout only shrink.
export const MAX_WORKERS = 3;

// A path that never exists, so no test launches a worker on the models this machine's person chose (ISS-14109).
export const NO_MODEL_OVERRIDES = fileURLToPath(new URL("./no-model-overrides/models.json", import.meta.url));

// Pinned release commits are fetched once here, never inside a timed test or hook (ISS-13662).
export default defineConfig({ test: { maxWorkers: MAX_WORKERS, globalSetup: ["./src/global-setup.ts"],
  env: { VIBE_MODELS_FILE: NO_MODEL_OVERRIDES } } });
