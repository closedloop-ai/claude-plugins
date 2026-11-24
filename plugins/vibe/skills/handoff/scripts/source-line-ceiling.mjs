import { isGeneratedFile } from "./generated-files.mjs";

export const LINE_CEILING = 1000;
const COUNTED_SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;

/** Count actual source lines, including a final unterminated line and excluding an empty trailing segment. */
export function sourceLineCount(text) {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Enforce non-growth on above-base legacy files and the unchanged ceiling on all other source. */
export function lineCeilingFailure(before, after) {
  if (after <= LINE_CEILING || (before > LINE_CEILING && after <= before)) return null;
  return before > LINE_CEILING
    ? `file grew from ${before} to ${after} lines above the ${LINE_CEILING}-line ceiling`
    : `file is ${after} lines, over the ${LINE_CEILING}-line ceiling (base ${before})`;
}

/** Share exact captured base and current line classification with writer and handoff inventory. */
export function checkSourceLineCeiling(files, repo, add) {
  for (const file of files.filter(({ path, status }) => status !== "D" && COUNTED_SOURCE.test(path))) {
    if (isGeneratedFile(repo, file.path)) continue;
    const current = repo.head(file.path);
    if (current === undefined || current === null) continue;
    const before = sourceLineCount(repo.base(file.oldPath ?? file.path));
    const after = sourceLineCount(current);
    const failure = lineCeilingFailure(before, after);
    if (failure) add("source-line-ceiling", file.path, file.added?.[0]?.line ?? 1, failure, "keep this source within the ceiling or split by responsibility");
  }
}
