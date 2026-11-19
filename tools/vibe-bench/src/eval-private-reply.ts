import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalCaseResult, EvalRuntimeRecord } from "./eval-collector.ts";
import type { PrivateReplyCategory } from "./private-artifact.ts";

/** One case whose reply was withheld as private; carries the category, never the text. */
export interface PrivateReplyRejection {
  caseId: string;
  category: PrivateReplyCategory;
}

const MAX_CASE_INPUT_BYTES = 1_000_000;

/** Everything the model was given for one case: its prompt and fixtures, never its graders. */
export function evalCaseInputText(vibeDir: string, caseId: string): string {
  const root = join(vibeDir, "evals", caseId);
  const parts: string[] = [];
  let size = 0;
  const walk = (dir: string): void => {
    // Names in one directory are unique, so the default string sort is a total order.
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isDirectory()) {
        if (dir !== root || name !== "graders") walk(path);
      } else if (entry.isFile() && size < MAX_CASE_INPUT_BYTES) {
        const text = readFileSync(path).toString("utf8");
        size += text.length;
        parts.push(text);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return parts.join("\n");
}

/** The grader name a withheld reply leaves on its case. */
export function privateReplyGrader(category: PrivateReplyCategory): string {
  return `private-reply:${category}`;
}

/** Fail only the rejected cases of one runtime record; every other case keeps its result. */
export function failPrivateReplyCases(record: EvalRuntimeRecord,
  rejected: readonly PrivateReplyRejection[]): EvalRuntimeRecord {
  if (!rejected.length || !record.result) return record;
  const byCase = new Map(rejected.map((item) => [item.caseId, item.category]));
  const cases = record.result.cases.map((item): EvalCaseResult => {
    const category = byCase.get(item.id);
    if (!category) return item;
    return { ...item, passed: false,
      failedGraders: [...new Set([...item.failedGraders, privateReplyGrader(category)])].sort() };
  });
  const passed = cases.filter((item) => item.passed).length;
  const unavailable = cases.filter((item) => item.unavailableReason !== undefined).length;
  const result = { ...record.result, cases, passed, failed: cases.length - passed - unavailable };
  return { ...record, exitCode: result.failed === 0 ? 0 : 1, result };
}
