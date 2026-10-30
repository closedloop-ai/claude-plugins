import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BENCHMARK_TASK } from "../src/contract.ts";

/**
 * Hidden oracle for the deliberately regressed task. This file is never copied
 * into the disposable agent checkout or its fake remote.
 */
export function projectSearchOracle(agentCheckout: string): { pass: boolean; failures: string[] } {
  const source = readFileSync(join(agentCheckout, BENCHMARK_TASK.file), "utf8");
  const match = source.match(/export function matchesProjectSearch\([\s\S]*?\): boolean \{([\s\S]*?)\n\}/);
  if (!match) throw new Error("benchmark-oracle-target-missing");
  const body = match[1];
  const cases: Array<[string, string, boolean]> = [
    ["Northstar Project", "star", true],
    ["Northstar Project", " STAR ", true],
    ["Northstar Project", "missing", false],
    ["Northstar Project", "   ", true],
  ];
  const failures: string[] = [];
  for (const [name, search, expected] of cases) {
    const actual = runInNewContext(`(function(row, search) {${body}\n})({ name }, search)`, { name, search }, { timeout: 500 });
    if (actual !== expected) failures.push(`${name} / ${search}: expected ${expected}, got ${actual}`);
  }
  return { pass: failures.length === 0, failures };
}
