/**
 * FEA-1762: Pure, network-free inline-image body transformer.
 *
 * Finds `![...](attachment://{{path}})` placeholders in a markdown body and
 * either substitutes them from a pre-built map (produced by the orchestrator
 * from MCP upload results) or strips them entirely.
 *
 * Usage:
 *   node apply-inline-images.mjs \
 *     --body <in.md> --out <out.md> \
 *     (--map <map.json> | --strip) \
 *     [--shots-root <dir>]
 *
 * Exit codes:
 *   0  success (always writes --out)
 *   1  bad arguments or unreadable input
 *
 * Prints one-line JSON: { substituted, stripped: [paths], mode }
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runWhenMain } from "./cli.js";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The placeholder regex: matches `![alt](attachment://{{path}})` */
const PLACEHOLDER_RE = /!\[[^\]]*\]\(attachment:\/\/\{\{([^}]+)\}\}\)/g;

/** Extract unique placeholder paths from a markdown body. */
export function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  while ((match = re.exec(body)) !== null) {
    const path = match[1];
    if (path !== undefined && !seen.has(path)) {
      seen.add(path);
      results.push(path);
    }
  }
  return results;
}

/** Map from placeholder path to attachment id — substitute all occurrences. */
export function substitute(body: string, map: Map<string, string>): string {
  return body.replace(PLACEHOLDER_RE, (full, path: string) => {
    const attachmentId = map.get(path);
    return attachmentId !== undefined
      ? full.replace(`{{${path}}}`, attachmentId)
      : full;
  });
}

/**
 * Remove every image line whose placeholder path is in `failedPaths`.
 * Matches lines of the form `![...](attachment://{{path}})` with optional
 * leading spaces, followed by an optional trailing newline.
 */
export function stripFailed(body: string, failedPaths: string[]): string {
  if (failedPaths.length === 0) return body;
  const pathSet = new Set(failedPaths);
  return body
    .split("\n")
    .filter((line) => {
      const match = /!\[[^\]]*\]\(attachment:\/\/\{\{([^}]+)\}\}\)/.exec(line);
      if (!match) return true;
      return !pathSet.has(match[1] ?? "");
    })
    .join("\n");
}

/**
 * Check that a placeholder path is safely contained within shotsRoot.
 *
 * Rules (Codex P2):
 * - Absolute paths are always rejected.
 * - Paths containing ".." segments are always rejected (even without a root).
 * - When shotsRoot is provided: the resolved path must be inside shotsRoot
 *   (realpath-style normalization; no symlink traversal — we use resolve/normalize).
 *
 * Returns true when the path is safe to use, false when it must be stripped.
 */
export function containsPath(placeholderPath: string, shotsRoot?: string): boolean {
  // Reject absolute paths unconditionally.
  if (isAbsolute(placeholderPath)) return false;

  // Reject paths with ".." segments unconditionally.
  const normalized = normalize(placeholderPath);
  if (normalized.startsWith("..") || normalized.includes("/..") || normalized.includes("\\..")) {
    return false;
  }

  // When no shotsRoot is given, the only invariants are the two above.
  if (!shotsRoot) return true;

  // Resolve inside shotsRoot and verify containment.
  const resolvedRoot = resolve(shotsRoot);
  const resolvedTarget = resolve(join(resolvedRoot, placeholderPath));

  // The resolved target must start with resolvedRoot + sep (or equal it).
  return resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + "/") ||
    resolvedTarget.startsWith(resolvedRoot + "\\");
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

interface ApplyResult {
  substituted: number;
  stripped: string[];
  mode: "map" | "strip";
}

// ---------------------------------------------------------------------------
// Core transform logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Apply image substitutions or strip all placeholders.
 *
 * @param body       - Raw markdown body with `attachment://{{path}}` placeholders.
 * @param mode       - "map" to substitute from attachmentMap; "strip" to remove all.
 * @param attachmentMap - Path -> attachment UUID map (used only in "map" mode).
 * @param shotsRoot  - When provided, every placeholder path is containment-checked.
 * @returns          - Transformed body and a result summary.
 */
export function applyInlineImages(
  body: string,
  mode: "map" | "strip",
  attachmentMap: Map<string, string>,
  shotsRoot?: string,
): { body: string; result: ApplyResult } {
  const paths = extractPlaceholders(body);

  if (paths.length === 0 || mode === "strip") {
    // Strip all placeholders.
    const stripped = paths.filter(() => true);
    const strippedBody = stripFailed(body, paths);
    return {
      body: strippedBody,
      result: { substituted: 0, stripped, mode },
    };
  }

  // Map mode: separate safe paths from unsafe / containment-violating ones.
  const safePaths: string[] = [];
  const unsafePaths: string[] = [];

  for (const p of paths) {
    if (!containsPath(p, shotsRoot)) {
      unsafePaths.push(p);
    } else {
      safePaths.push(p);
    }
  }

  // Among safe paths, separate those in the map from those missing.
  const substitutedPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const p of safePaths) {
    if (attachmentMap.has(p)) {
      substitutedPaths.push(p);
    } else {
      missingPaths.push(p);
    }
  }

  // Build a substitution map containing only safe paths that have a UUID.
  const safeMap = new Map<string, string>();
  for (const p of substitutedPaths) {
    const uuid = attachmentMap.get(p);
    if (uuid !== undefined) safeMap.set(p, uuid);
  }

  let outBody = substitute(body, safeMap);

  // Strip all problematic lines (missing from map + containment violations).
  const toStrip = [...missingPaths, ...unsafePaths];
  outBody = stripFailed(outBody, toStrip);

  return {
    body: outBody,
    result: {
      substituted: substitutedPaths.length,
      stripped: toStrip,
      mode,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "body":       { type: "string" },
      "out":        { type: "string" },
      "map":        { type: "string" },
      "strip":      { type: "boolean", default: false },
      "shots-root": { type: "string" },
    },
  });

  const bodyPath = values["body"];
  if (!bodyPath) {
    console.error("error: --body is required");
    return 1;
  }

  const outPath = values["out"];
  if (!outPath) {
    console.error("error: --out is required");
    return 1;
  }

  const mapPath  = values["map"];
  const stripAll = values["strip"] ?? false;

  if (!mapPath && !stripAll) {
    console.error("error: either --map <map.json> or --strip is required");
    return 1;
  }

  if (mapPath && stripAll) {
    console.error("error: --map and --strip are mutually exclusive");
    return 1;
  }

  let body: string;
  try {
    body = readFileSync(bodyPath, "utf-8");
  } catch (err) {
    console.error(
      `error reading body file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const attachmentMap = new Map<string, string>();
  if (mapPath) {
    let raw: string;
    try {
      raw = readFileSync(mapPath, "utf-8");
    } catch (err) {
      console.error(
        `error reading map file: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        `error parsing map JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("error: map file must be a JSON object");
      return 1;
    }

    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") {
        console.error(`error: map value for key "${k}" must be a string`);
        return 1;
      }
      attachmentMap.set(k, v);
    }
  }

  // Resolve shotsRoot to an absolute path when provided.
  const shotsRootRaw = values["shots-root"];
  let shotsRoot: string | undefined;
  if (shotsRootRaw) {
    try {
      // Use realpathSync to canonicalize; fall back to resolve for non-existent dirs.
      shotsRoot = realpathSync(shotsRootRaw);
    } catch {
      shotsRoot = resolve(shotsRootRaw);
    }
  }

  const mode: "map" | "strip" = stripAll ? "strip" : "map";
  const { body: outBody, result } = applyInlineImages(body, mode, attachmentMap, shotsRoot);

  // Always write --out (Codex finding: no exit-3 path that skips the write).
  writeFileSync(outPath, outBody, "utf-8");

  console.log(JSON.stringify(result));
  return 0;
}

runWhenMain(import.meta.url, main);
