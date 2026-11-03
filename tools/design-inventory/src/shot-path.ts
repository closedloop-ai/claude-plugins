/**
 * Normalize screenshot paths for `attachment://{{path}}` image placeholders.
 *
 * capture-design-shots patches finding.screenshot / theme.screenshot with
 * whatever path form it was given, and orchestrators commonly pass an ABSOLUTE
 * --shots-dir, so absolute screenshot paths are the common case in findings
 * documents. apply-inline-images' containsPath REJECTS absolute placeholder
 * paths (and any path with ".." segments) in map mode, so a placeholder built
 * from a raw absolute path would always be stripped and the image would never
 * reach the document.
 *
 * normalizeShotPath converts a screenshot path into a placeholder-safe relative
 * path, deterministically:
 *
 * - relative without ".." -> unchanged.
 * - absolute under shotsRoot -> relativized to shotsRoot.
 * - absolute elsewhere (or relative with "..") -> the path tail starting at the
 *   last "shots" segment (e.g. ".../workdir/shots/CHG-x.png" -> "shots/CHG-x.png").
 * - no "shots" segment to fall back to -> null; the caller omits the
 *   placeholder entirely (a missing image beats a guaranteed-stripped line).
 *
 * Every non-null result satisfies apply-inline-images' containsPath
 * (non-absolute, no ".." segments).
 */

import { isAbsolute, relative, resolve } from "node:path";

/** Split on / and \ so Windows-style separators are handled uniformly. */
function pathSegments(p: string): string[] {
  return p.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/** The path tail starting at the last "shots" segment, or null when absent. */
function shotsTail(p: string): string | null {
  const parts = pathSegments(p);
  const idx = parts.lastIndexOf("shots");
  if (idx < 0) return null;
  return parts.slice(idx).join("/");
}

/**
 * Normalize a screenshot path into a placeholder-safe relative path, or null
 * when no safe form exists (caller must omit the placeholder).
 */
export function normalizeShotPath(shotPath: string, shotsRoot?: string): string | null {
  if (!isAbsolute(shotPath)) {
    if (!pathSegments(shotPath).includes("..")) return shotPath;
    return shotsTail(shotPath);
  }
  if (shotsRoot) {
    const rel = relative(resolve(shotsRoot), resolve(shotPath));
    if (rel !== "" && !isAbsolute(rel) && !pathSegments(rel).includes("..")) {
      return rel.split("\\").join("/");
    }
  }
  return shotsTail(shotPath);
}
