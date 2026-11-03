import { defineConfig } from "vitest/config";

// Most tests here start git, the bundled CLIs and fake claude processes one after
// another. Vitest's default of one worker per core but one ran 17 files at once on an
// 18-core Mac; they competed for process start-up, the slowest tests ran 3 to 5 times
// longer than alone and crossed their timeouts. Three workers ran the full suite in the
// same wall time (555 s against 554 s) with every test within 1.4 times its time alone
// (ISS-13171). src/test-budget.test.ts keeps this cap and lets a per-test timeout only shrink.
export const MAX_WORKERS = 3;

export default defineConfig({ test: { maxWorkers: MAX_WORKERS } });
