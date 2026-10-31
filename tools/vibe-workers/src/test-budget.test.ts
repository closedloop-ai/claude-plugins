import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config, { MAX_WORKERS } from "../vitest.config.js";

const SOURCE = dirname(fileURLToPath(import.meta.url));
// Both ways a vitest test takes its own timeout: the trailing argument (`}, 30000);`) and an
// options object (`it("name", { timeout: 30000 }, ...)`). A spawn's own `timeout:` option is
// a child-process bound, not a test timeout, and is not counted.
const TEST_TIMEOUT = /\}, (\d[\d_]{3,})\);?\s*$|\b(?:it|test)(?:\.\w+)*\([^\n]*?\{\s*timeout:\s*(\d[\d_]*)/gm;
const SUITE_TIMEOUT = /\bvi\.setConfig\(\s*\{[^}]*testTimeout/;
// The explicit per-test timeouts after the worker cap, by value (ISS-13171). A timed-out
// test is fixed at its cause; a timeout may be lowered or dropped, never added or raised.
const TIMEOUT_CEILING: Record<number, number> = { 10000: 18, 15000: 10, 20000: 24, 25000: 3, 30000: 100, 60000: 19, 120000: 4 };

/** Every value in `counts`, largest first. */
function descending(counts: Record<number, number>) {
  return Object.entries(counts).flatMap(([value, count]) => Array<number>(count).fill(Number(value))).sort((a, b) => b - a);
}

/** Every test file but this one, whose comments show the patterns it counts. */
function testFiles() {
  return readdirSync(SOURCE).filter((name) => name.endsWith(".test.ts") && name !== "test-budget.test.ts");
}

function explicitTimeouts() {
  const counts: Record<number, number> = {};
  for (const file of testFiles()) {
    for (const match of readFileSync(join(SOURCE, file), "utf8").matchAll(TEST_TIMEOUT)) {
      const value = Number((match[1] ?? match[2])!.replaceAll("_", ""));
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
    const raised = testFiles().filter((name) => SUITE_TIMEOUT.test(readFileSync(join(SOURCE, name), "utf8")));
    expect(raised).toEqual([]);
  });
  it("never adds or raises a per-test timeout", () => {
    // Largest first, each timeout may be at most the ceiling's timeout at the same rank, so
    // lowering one passes and adding or raising one fails.
    const ceiling = descending(TIMEOUT_CEILING);
    const grown = descending(explicitTimeouts()).filter((value, rank) => value > (ceiling[rank] ?? 0))
      .map((value) => `${value} ms is above the ceiling at its rank`);
    expect(grown).toEqual([]);
  });
});
