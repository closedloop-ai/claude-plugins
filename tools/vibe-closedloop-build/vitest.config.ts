import { defineConfig } from "vitest/config";

// Each full build copies plugins/vibe; a long timeout covers a loaded machine.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
