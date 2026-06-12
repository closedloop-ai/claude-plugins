/**
 * Extract a Claude Design export zip into an analyzable workdir.
 *
 * Claude Design HTML exports are 5-7 MB unminified -- far too large to feed to
 * an LLM in one pass. This tool deterministically decomposes the export so the
 * design-inventory skill can analyze it screen by screen:
 *
 * 1. Unzips the export (zip-slip safe, with a total-size guard).
 * 2. Inventories every file (path, size, kind, line count) and tags each with
 *    a region so agents skip token-irrelevant content entirely.
 * 3. Detects typed design units (screens, regions, components).
 * 4. Extracts behavioral interaction signals per source file.
 * 5. Captures each source file's leading comment header (doc_headers).
 * 6. Detects designer-embedded spec overlays.
 * 7. Splits oversized source files into segments at top-level boundaries.
 * 8. Writes manifest.json describing all of the above.
 *
 * Usage:
 *     node design-export-extract.mjs <export.zip> [--workdir DIR]
 *         [--max-chunk-bytes N]
 *
 * Prints the manifest path on success. Exit codes: 0 ok, 1 usage/input error,
 * 2 unsafe or oversized archive.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import { runWhenMain } from "./cli.js";

export const MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024;
export const DEFAULT_MAX_CHUNK_BYTES = 200_000;

const TEXT_KINDS: Record<string, string> = {
  ".html": "html",
  ".htm": "html",
  ".js": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".css": "css",
  ".scss": "css",
  ".md": "md",
  ".txt": "txt",
  ".json": "json",
  ".svg": "svg",
};

const SIGNAL_PATTERNS: Record<string, RegExp> = {
  scroll: /onScroll|addEventListener\(\s*['"]scroll|scrollIntoView|scrollTo|scrollTop|overflow(?:-[xy])?\s*:\s*(?:auto|scroll)|overflow(?:-[xy])?-(?:auto|scroll)|scroll-smooth|snap-(?:x|y|start|center|end)|virtuali[sz]e/g,
  pointer_drag: /onPointerDown|onPointerMove|onPointerUp|setPointerCapture|releasePointerCapture|addEventListener\(\s*['"](?:pointer|mouse)move/g,
  hover: /onMouseEnter|onMouseLeave|onMouseOver|:hover|\bhover:/g,
  drag_drop: /\bdraggable\b|onDragStart|onDragOver|onDragEnd|onDrop\b|DndContext|useDrag\b|useDrop\b|useSortable|SortableContext/g,
  keyboard: /onKeyDown|onKeyUp|onKeyPress|addEventListener\(\s*['"]key|aria-keyshortcuts|useHotkeys/g,
  transition: /\btransition\b|transition-|@keyframes|animate-|framer-motion|\bmotion\./g,
  observer: /IntersectionObserver|ResizeObserver|MutationObserver/g,
  context_menu: /onContextMenu|ContextMenu/g,
  tooltip_popover: /\bTooltip\b|\bPopover\b|\bHoverCard\b/g,
};

const REGION_PREFIXES: Array<[string, string]> = [
  ["_ds/", "design_system"],
  ["screenshots/", "reference_images"],
  ["uploads/", "reference_images"],
  ["fonts/", "assets"],
  ["assets/", "assets"],
];

const SCRIPT_SRC = /<script\b[^>]*\bsrc=["']([^"']+\.(?:jsx|tsx|js))["']/g;
const SCREEN_NAME = /(?:Page|Screen|View|Detail|Trace|Dashboard|Wizard|Onboarding)(?:Quiet|Shared|V\d+)?$/;
const REGION_NAME = /(?:Sidebar|Topbar|Navbar|NavRail|Footer|StatusBar|TitleBar|AppShell|Chrome)$/;
const NON_COMPONENT_STEM = /(?:Data|Utils?|Helpers?|Config|Constants|Samples?)$/;
const PASCAL_STEM = /^[A-Z][A-Za-z0-9]*$/;
const ROUTE_JSX = /<Route\b[^>]*?\bpath=["']([^"']+)["']/g;
const ROUTE_OBJECT = /\bpath:\s*["']([^"']+)["']/g;
const ROUTER_MARKERS = /createBrowserRouter|createHashRouter|useRoutes|RouteObject/;
const SCREEN_DIR = /(?:^|\/)(?:pages|screens|views)\//i;
const HTML_TITLE = /<title[^>]*>([^<]+)<\/title>/i;
const COMPONENT_FILE = /\.(?:jsx?|tsx?)$/;
const OVERLAY_FILE_NAME = /(?:^|[-_./])(?:spec|notes?|annotations?|requirements)(?:[-_.s]|$)/i;
const OVERLAY_COMMENT = /\b(?:product spec|designer note|design note|do not implement|out of scope|not for build)\b/i;
const SPLIT_BOUNDARY = /^(?:export\s|function\s|async function\s|class\s|const\s+[A-Z]|\/\/\s*[-=]{3,}|\/\*|<script\b|<style\b|<section\b|<!DOCTYPE|<html\b)/;

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

export interface FileEntry {
  path: string;
  bytes: number;
  kind: string;
  region: string;
  lines: number | null;
}

export interface DesignUnit {
  id: string;
  name: string;
  evidence: string[];
  files: string[];
  type: string;
  primary: string;
}

export interface SegmentEntry {
  file: string;
  start_line: number;
  end_line: number;
  bytes: number;
}

export interface SplitEntry {
  path: string;
  segments: SegmentEntry[];
}

export interface Manifest {
  export_zip: string;
  extract_dir: string;
  max_chunk_bytes: number;
  totals: {
    files: number;
    bytes: number;
    text_files: number;
    by_region: Record<string, number>;
  };
  files: FileEntry[];
  units: DesignUnit[];
  screens: DesignUnit[];
  interaction_signals: Record<string, Record<string, number>>;
  doc_headers: Record<string, string>;
  spec_overlays: Array<{ path: string; line: number; kind: string; text: string }>;
  splits: SplitEntry[];
}

export function classifyRegion(rel: string): string {
  for (const [prefix, region] of REGION_PREFIXES) {
    if (rel.startsWith(prefix) || rel.includes(`/${prefix}`)) {
      return region;
    }
  }
  return "source";
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "screen";
}

/** Extract the archive, rejecting zip-slip paths and zip bombs. */
export function safeExtract(zipPath: string, extractDir: string): string[] {
  const zipData = readFileSync(zipPath);
  const entries = unzipSync(zipData);

  // Compute total uncompressed size
  let total = 0;
  for (const [, data] of Object.entries(entries)) {
    total += data.byteLength;
  }
  if (total > MAX_TOTAL_UNCOMPRESSED) {
    throw new UnsafeArchiveError(
      `archive expands to ${total} bytes (limit ${MAX_TOTAL_UNCOMPRESSED})`
    );
  }

  const extracted: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    // Skip directory entries
    if (name.endsWith("/")) continue;

    // Check for absolute paths or ".." parts
    if (name.startsWith("/") || name.startsWith("\\")) {
      throw new UnsafeArchiveError(`unsafe path in archive: ${name}`);
    }
    const parts = name.split("/");
    if (parts.includes("..")) {
      throw new UnsafeArchiveError(`unsafe path in archive: ${name}`);
    }

    const target = join(extractDir, ...parts);
    // Verify the resolved path is inside extract dir
    const resolvedTarget = target;
    const resolvedExtract = extractDir;
    // Simple prefix check (both are absolute after join)
    if (!resolvedTarget.startsWith(resolvedExtract + "/") && resolvedTarget !== resolvedExtract) {
      throw new UnsafeArchiveError(`unsafe path in archive: ${name}`);
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    extracted.push(target);
  }
  return extracted;
}

export function fileKind(filePath: string): string {
  const ext = filePath.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "";
  return TEXT_KINDS[ext] ?? "other";
}

export function readText(filePath: string): string | null {
  const raw = readFileSync(filePath);
  // Check for binary (null byte in first 8192 bytes)
  const check = raw.subarray(0, 8192);
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return null;
  }
  return raw.toString("utf-8");
}

export function detectSignals(text: string): Record<string, number> {
  const signals: Record<string, number> = {};
  for (const [name, pattern] of Object.entries(SIGNAL_PATTERNS)) {
    // Reset lastIndex since we use global regexes
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      signals[name] = matches.length;
    }
  }
  return signals;
}

export function screenNameFromPath(rel: string): string {
  // Extract stem (filename without extension)
  const basename_ = rel.split("/").pop() ?? rel;
  const stem = basename_.replace(/\.[^.]+$/, "");
  const parts = rel.split("/");

  let useStem = stem;
  if (stem.toLowerCase() === "index" && parts.length >= 2) {
    useStem = parts[parts.length - 2] ?? stem;
  }

  // CamelCase split, then replace separators
  return useStem
    .replace(/(?<!^)(?=[A-Z])/g, " ")
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .trim();
}

interface ScreenEntry {
  id: string;
  name: string;
  evidence: string[];
  files: string[];
}

function mergeScreen(
  screens: Map<string, ScreenEntry>,
  name: string,
  evidence: string,
  rel: string,
  prefix = "scr"
): void {
  const slug = slugify(name);
  if (!screens.has(slug)) {
    screens.set(slug, { id: `${prefix}-${slug}`, name, evidence: [], files: [] });
  }
  const entry = screens.get(slug)!;
  if (!entry.evidence.includes(evidence)) {
    entry.evidence.push(evidence);
  }
  if (!entry.files.includes(rel)) {
    entry.files.push(rel);
  }
}

export function localScriptSrcs(text: string): string[] {
  const srcs: string[] = [];
  const re = new RegExp(SCRIPT_SRC.source, "g");
  for (const match of text.matchAll(re)) {
    const src = match[1];
    if (src && !src.startsWith("http:") && !src.startsWith("https:") && !src.startsWith("//")) {
      srcs.push(src);
    }
  }
  return srcs;
}

export function routeToName(route: string): string {
  const parts = route
    .split("/")
    .filter((p) => p.length > 0 && !p.startsWith(":") && p !== "*");
  if (parts.length === 0) return "Home";
  return parts
    .map((p) => p.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(" ");
}

function posixDirname(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(0, idx) : "";
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/").replace(/^\//, "");
}

function resolveSrc(base: string, src: string): string {
  const joined = base ? posixJoin(base, src) : src;
  // Remove leading "./"
  return joined.replace(/^\.\//, "");
}

export function detectScreens(
  files: Array<[string, string]>,
  texts: Map<string, string>
): ScreenEntry[] {
  const screens = new Map<string, ScreenEntry>();

  for (const [rel] of files) {
    const text = texts.get(rel);
    const kind = fileKind(rel);

    if (kind === "html" && text !== null && text !== undefined) {
      const srcs = localScriptSrcs(text);
      if (srcs.length >= 2) {
        const base = posixDirname(rel);
        for (const src of srcs) {
          const target = resolveSrc(base, src);
          const targetStem = target.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
          if (SCREEN_NAME.test(targetStem)) {
            mergeScreen(screens, screenNameFromPath(target), `script_tag:${rel}`, target);
          }
        }
      } else {
        const titleMatch = HTML_TITLE.exec(text);
        const name = titleMatch
          ? (titleMatch[1] ?? "").trim()
          : screenNameFromPath(rel);
        mergeScreen(screens, name, `html_file:${rel}`, rel);
      }
    }

    if (COMPONENT_FILE.test(rel)) {
      const stem = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      if (SCREEN_DIR.test(rel)) {
        mergeScreen(screens, screenNameFromPath(rel), `screen_dir:${rel}`, rel);
      } else if (SCREEN_NAME.test(stem)) {
        mergeScreen(screens, screenNameFromPath(rel), `screen_name:${rel}`, rel);
      }
    }

    if (text !== null && text !== undefined && ["js", "jsx", "ts", "tsx"].includes(kind)) {
      const routeJsxRe = new RegExp(ROUTE_JSX.source, "g");
      for (const match of text.matchAll(routeJsxRe)) {
        const route = match[1];
        if (route) {
          mergeScreen(screens, routeToName(route), `route:${route}`, rel);
        }
      }
      if (ROUTER_MARKERS.test(text)) {
        const routeObjRe = new RegExp(ROUTE_OBJECT.source, "g");
        for (const match of text.matchAll(routeObjRe)) {
          const route = match[1];
          if (route) {
            mergeScreen(screens, routeToName(route), `route:${route}`, rel);
          }
        }
      }
    }
  }

  return [...screens.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function detectUnits(
  files: Array<[string, string]>,
  texts: Map<string, string>
): DesignUnit[] {
  const screenEntries = detectScreens(files, texts);
  const units: DesignUnit[] = [];
  const claimed = new Set<string>();

  for (const screen of screenEntries) {
    const unit: DesignUnit = { ...screen, type: "screen", primary: "" };
    units.push(unit);
    for (const f of screen.files) {
      claimed.add(f);
    }
  }

  const regions = new Map<string, ScreenEntry>();
  const components = new Map<string, ScreenEntry>();

  for (const [rel] of files) {
    if (claimed.has(rel) || !COMPONENT_FILE.test(rel)) continue;
    const stem = rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    if (!PASCAL_STEM.test(stem)) continue;
    const name = screenNameFromPath(rel);
    if (REGION_NAME.test(stem)) {
      mergeScreen(regions, name, `region_name:${rel}`, rel, "rgn");
    } else if (!NON_COMPONENT_STEM.test(stem)) {
      mergeScreen(components, name, `component:${rel}`, rel, "cmp");
    }
  }

  for (const [bucket, unitType] of [
    [regions, "region"],
    [components, "component"],
  ] as Array<[Map<string, ScreenEntry>, string]>) {
    const sorted = [...bucket.values()].sort((a, b) => a.id.localeCompare(b.id));
    for (const entry of sorted) {
      const unit: DesignUnit = { ...entry, type: unitType, primary: "" };
      units.push(unit);
    }
  }

  return units;
}

export function extractDocHeader(text: string, maxLines = 40): string | null {
  const header: string[] = [];
  let inBlock = false;

  const lines = text.split("\n").slice(0, maxLines);
  for (const line of lines) {
    const stripped = line.trim();
    if (inBlock) {
      const ended = stripped.endsWith("*/");
      let content = ended ? stripped.slice(0, -2) : stripped;
      content = content.trimEnd().replace(/^\*/, "").trim();
      if (content) header.push(content);
      if (ended) inBlock = false;
      continue;
    }
    if (stripped.startsWith("//")) {
      header.push(stripped.slice(2).trim());
    } else if (stripped.startsWith("/*")) {
      let content = stripped.slice(2);
      if (content.endsWith("*/")) {
        content = content.slice(0, -2);
      } else {
        inBlock = true;
      }
      content = content.trim().replace(/^\*/, "").trim();
      if (content) header.push(content);
    } else if (stripped === "") {
      continue;
    } else {
      break;
    }
  }

  const joined = header.join("\n").trim();
  return joined || null;
}

export function detectOverlays(
  files: Array<[string, string]>,
  texts: Map<string, string>
): Array<{ path: string; line: number; kind: string; text: string }> {
  const overlays: Array<{ path: string; line: number; kind: string; text: string }> = [];

  for (const [rel] of files) {
    const text = texts.get(rel);
    if (text === undefined) continue;

    const name = rel.split("/").pop() ?? rel;
    if (OVERLAY_FILE_NAME.test(name) && ["md", "txt"].includes(fileKind(rel))) {
      overlays.push({ path: rel, line: 1, kind: "overlay_file", text: text.slice(0, 500) });
      continue;
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (OVERLAY_COMMENT.test(line)) {
        overlays.push({
          path: rel,
          line: i + 1,
          kind: "inline_note",
          text: line.trim().slice(0, 500),
        });
      }
    }
  }

  return overlays;
}

export function splitLargeFile(
  rel: string,
  text: string,
  segmentsDir: string,
  maxChunkBytes: number
): SplitEntry {
  const lines = text.split(/^/m); // split keeping line endings (splitlines(keepends=True))
  const segments: SegmentEntry[] = [];
  const flat = rel.replace(/\//g, "__");

  let buffer: string[] = [];
  let bufferBytes = 0;
  let startLine = 1;

  function flush(endLine: number): void {
    if (buffer.length === 0) return;
    const segPath = join(segmentsDir, `${flat}.seg${String(segments.length).padStart(3, "0")}.txt`);
    writeFileSync(segPath, buffer.join(""), "utf-8");
    segments.push({
      file: segPath,
      start_line: startLine,
      end_line: endLine,
      bytes: bufferBytes,
    });
    buffer = [];
    bufferBytes = 0;
    startLine = endLine + 1;
  }

  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const line = lines[lineNo - 1] ?? "";
    const encoded = Buffer.byteLength(line, "utf-8");
    const atBoundary = SPLIT_BOUNDARY.test(line);
    if (
      buffer.length > 0 &&
      bufferBytes + encoded > maxChunkBytes &&
      (atBoundary || bufferBytes + encoded > 2 * maxChunkBytes)
    ) {
      flush(lineNo - 1);
    }
    buffer.push(line);
    bufferBytes += encoded;
  }
  flush(lines.length);

  return { path: rel, segments };
}

export function buildManifest(zipPath: string, workdir: string, maxChunkBytes: number): string {
  const extractDir = join(workdir, "extracted");
  const segmentsDir = join(workdir, "segments");
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(segmentsDir, { recursive: true });

  const extractedPaths = safeExtract(zipPath, extractDir);

  // Build sorted list of [rel, absPath]
  const files: Array<[string, string]> = extractedPaths
    .map((p): [string, string] => {
      const rel = p.slice(extractDir.length + 1).replace(/\\/g, "/");
      return [rel, p];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  const texts = new Map<string, string>();
  const fileEntries: FileEntry[] = [];
  const interactionSignals: Record<string, Record<string, number>> = {};
  const docHeaders: Record<string, string> = {};
  const splits: SplitEntry[] = [];
  const regionTotals: Record<string, number> = {};
  const sourceFiles: Array<[string, string]> = [];

  for (const [rel, absPath] of files) {
    const size = statSync(absPath).size;
    const kind = fileKind(rel);
    const region = classifyRegion(rel);
    regionTotals[region] = (regionTotals[region] ?? 0) + 1;

    const text = kind !== "other" ? readText(absPath) : null;
    if (text !== null) {
      texts.set(rel, text);
    }

    const entry: FileEntry = {
      path: rel,
      bytes: size,
      kind,
      region,
      lines: text !== null ? text.split("\n").length : null,
    };
    fileEntries.push(entry);

    if (region === "source") {
      sourceFiles.push([rel, absPath]);
    }

    if (
      region === "source" &&
      text !== null &&
      ["html", "js", "jsx", "ts", "tsx", "css"].includes(kind)
    ) {
      const signals = detectSignals(text);
      if (Object.keys(signals).length > 0) {
        interactionSignals[rel] = signals;
      }
    }

    if (region === "source" && text !== null && ["js", "jsx", "ts", "tsx"].includes(kind)) {
      const docHeader = extractDocHeader(text);
      if (docHeader !== null) {
        docHeaders[rel] = docHeader;
      }
    }

    if (
      ["source", "design_system"].includes(region) &&
      text !== null &&
      size > maxChunkBytes
    ) {
      splits.push(splitLargeFile(rel, text, segmentsDir, maxChunkBytes));
    }
  }

  const sizes: Record<string, number> = {};
  for (const e of fileEntries) {
    sizes[e.path] = e.bytes;
  }

  const units = detectUnits(sourceFiles, texts);
  for (const unit of units) {
    unit.primary = unit.files.reduce(
      (best, f) => ((sizes[f] ?? 0) >= (sizes[best] ?? 0) ? f : best),
      unit.files[0] ?? ""
    );
  }

  const screens = units.filter((u) => u.type === "screen");

  const manifest: Manifest = {
    export_zip: zipPath,
    extract_dir: extractDir,
    max_chunk_bytes: maxChunkBytes,
    totals: {
      files: fileEntries.length,
      bytes: fileEntries.reduce((s, e) => s + e.bytes, 0),
      text_files: texts.size,
      by_region: regionTotals,
    },
    files: fileEntries,
    units,
    screens,
    interaction_signals: interactionSignals,
    doc_headers: docHeaders,
    spec_overlays: detectOverlays(sourceFiles, texts),
    splits,
  };

  const manifestPath = join(workdir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifestPath;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workdir: { type: "string" },
      "max-chunk-bytes": { type: "string" },
    },
    strict: false,
  });

  if (positionals.length === 0) {
    console.error("error: zip path is required");
    return 1;
  }

  const zipPath = positionals[0]!;
  const maxChunkBytes =
    values["max-chunk-bytes"] !== undefined
      ? parseInt(String(values["max-chunk-bytes"]), 10)
      : DEFAULT_MAX_CHUNK_BYTES;

  // Check file exists
  try {
    statSync(zipPath);
  } catch {
    console.error(`error: zip not found: ${zipPath}`);
    return 1;
  }

  // Basic zip magic bytes check (PK\x03\x04)
  try {
    const buf = Buffer.alloc(4);
    const fd = readFileSync(zipPath);
    if (
      fd.length < 4 ||
      fd[0] !== 0x50 ||
      fd[1] !== 0x4b ||
      fd[2] !== 0x03 ||
      fd[3] !== 0x04
    ) {
      console.error(`error: not a zip archive: ${zipPath}`);
      return 1;
    }
    void buf;
  } catch {
    console.error(`error: not a zip archive: ${zipPath}`);
    return 1;
  }

  const stem = basename(zipPath).replace(/\.[^.]+$/, "");
  const workdir =
    values.workdir !== undefined
      ? String(values.workdir)
      : join(dirname(zipPath), `${stem}-design-inventory`);

  try {
    const manifestPath = buildManifest(zipPath, workdir, maxChunkBytes);
    console.log(manifestPath);
    return 0;
  } catch (err) {
    if (err instanceof UnsafeArchiveError) {
      console.error(`error: refusing to extract: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

runWhenMain(import.meta.url, main);
