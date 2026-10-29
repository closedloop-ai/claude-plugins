import * as ts from "typescript";

export const BUNDLED_TYPESCRIPT_VERSION = ts.version;

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

/**
 * Parses one JavaScript or TypeScript file with the compiler bundled into the
 * vibe plugin and prints its AST without comments. A null result is a proof
 * failure, never evidence that an edit is comment-only.
 */
export function commentlessAst(file: string, source: string): string | null {
  const extension = Object.keys(SCRIPT_KINDS).find((candidate) => file.toLowerCase().endsWith(candidate));
  if (!extension) return null;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension]);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  return ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(tree);
}
