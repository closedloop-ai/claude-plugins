import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config, { MAX_WORKERS } from "../vitest.config.js";

const SOURCE = dirname(fileURLToPath(import.meta.url));
const TEST_TIMEOUT = /\}, (\d[\d_]{3,})\);?\s*$/gm;
// The explicit per-test timeouts on 2026-10-27, by value. A timed-out test is fixed at
// its cause (ISS-13171); these counts may only shrink.
const TIMEOUT_CEILING: Record<number, number> = { 1000: 3, 10000: 10, 20000: 23, 30000: 125, 60000: 28, 120000: 4 };

function explicitTimeouts() {
  const counts: Record<number, number> = {};
  for (const file of readdirSync(SOURCE).filter((name) => name.endsWith(".test.ts"))) {
    for (const match of readFileSync(join(SOURCE, file), "utf8").matchAll(TEST_TIMEOUT)) {
      const value = Number(match[1]!.replaceAll("_", ""));
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return counts;
}

describe("test budget", () => {
  it("caps the workers that run files at once, since these tests contend for process start-up", () => {
    expect(MAX_WORKERS).toBeLessThanOrEqual(3);
    expect(config.test?.maxWorkers).toBe(MAX_WORKERS);
    expect(config.test?.testTimeout).toBeUndefined();
  });
  it("never adds or raises a per-test timeout", () => {
    const grown = Object.entries(explicitTimeouts())
      .filter(([value, count]) => count > (TIMEOUT_CEILING[Number(value)] ?? 0))
      .map(([value, count]) => `${value} ms: ${count} tests, at most ${TIMEOUT_CEILING[Number(value)] ?? 0}`);
    expect(grown).toEqual([]);
  });
});
