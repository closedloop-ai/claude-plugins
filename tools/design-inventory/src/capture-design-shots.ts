/**
 * Capture highlighted screenshots of the live design for review cards.
 *
 * Claude Design exports are runnable apps, not just pictures: the entry HTML
 * mounts the screens with in-browser Babel. This tool serves the extracted
 * export locally, loads it in headless Chromium, navigates to the unit's
 * screen, and for every finding that cites `spec.selectors` it outlines the
 * matching elements and screenshots the region. The reviewer then sees
 * exactly which part of the design each decision is about.
 *
 * Playwright is resolved at runtime from the target repo (or cwd) rather
 * than bundled: web-ui repos in scope already depend on it. When it cannot
 * be resolved the tool exits 3 so the pipeline can degrade gracefully to
 * un-highlighted unit screenshots.
 *
 * Usage:
 *     node capture-design-shots.mjs --extract-dir DIR --entry ui_kits/app/index.html \
 *         --findings unit.json --shots-dir DIR [--repo REPO] [--nav-text "Sessions"] \
 *         [--eval "window.clOpenSession('ses_1')"] [--viewport 1600x1000]
 *
 * Patches the findings document in place (finding.screenshot, theme.screenshot)
 * and prints a JSON summary. Exit codes: 0 ok, 1 input error, 2 capture
 * failed (page never mounted), 3 Playwright unavailable.
 */

import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { validateFindings, type JsonObject } from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

const HIGHLIGHT_CSS =
  ".cl-shot-highlight { outline: 3px solid #e11d48 !important; outline-offset: 2px; " +
  "border-radius: 4px; box-shadow: 0 0 0 6px rgba(225,29,72,.15) !important; }";
const CLIP_PADDING = 28;
const MAX_MATCHES = 12;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Union of bounding boxes plus padding, clamped to the page size. */
export function unionClip(boxes: Box[], pageW: number, pageH: number): Box | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  x0 = Math.max(0, x0 - CLIP_PADDING);
  y0 = Math.max(0, y0 - CLIP_PADDING);
  x1 = Math.min(pageW, x1 + CLIP_PADDING);
  y1 = Math.min(pageH, y1 + CLIP_PADDING);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Findings with non-empty spec.selectors, in document order. */
export function selectorTargets(doc: JsonObject): Array<{ id: string; selectors: string[] }> {
  const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
  const targets: Array<{ id: string; selectors: string[] }> = [];
  for (const finding of findings) {
    const spec = finding["spec"];
    if (typeof spec !== "object" || spec === null) continue;
    const selectors = (spec as JsonObject)["selectors"];
    if (Array.isArray(selectors) && selectors.length > 0 && typeof finding["id"] === "string") {
      targets.push({ id: finding["id"], selectors: selectors.map(String) });
    }
  }
  return targets;
}

/**
 * Theme-level capture targets: the union of every member finding's selectors,
 * so a multi-part theme's screenshot highlights everything it covers instead
 * of anchoring the reviewer to its first member.
 */
export function themeTargets(doc: JsonObject): Array<{ id: string; selectors: string[] }> {
  const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
  const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
  const targets: Array<{ id: string; selectors: string[] }> = [];
  for (const theme of themes) {
    const tid = theme["id"];
    if (typeof tid !== "string") continue;
    const selectors = new Set<string>();
    for (const finding of findings) {
      if (finding["theme"] !== tid) continue;
      const spec = finding["spec"];
      if (typeof spec !== "object" || spec === null) continue;
      const own = (spec as JsonObject)["selectors"];
      if (Array.isArray(own)) own.forEach((s) => selectors.add(String(s)));
    }
    if (selectors.size > 0) targets.push({ id: tid, selectors: [...selectors] });
  }
  return targets;
}

/**
 * Apply capture results to the findings document: per-finding screenshots,
 * theme screenshots (theme union shot, else first captured member, else the
 * unit base shot).
 */
export function patchFindings(
  doc: JsonObject,
  shots: Map<string, string>,
  baseShot: string | null,
): void {
  const findings = Array.isArray(doc["findings"]) ? (doc["findings"] as JsonObject[]) : [];
  for (const finding of findings) {
    const fid = String(finding["id"] ?? "");
    const shot = shots.get(fid);
    if (shot) finding["screenshot"] = shot;
  }
  const themes = Array.isArray(doc["themes"]) ? (doc["themes"] as JsonObject[]) : [];
  for (const theme of themes) {
    const tid = String(theme["id"] ?? "");
    const member = findings.find((f) => f["theme"] === tid && typeof f["screenshot"] === "string");
    const shot = shots.get(tid) ?? (member ? String(member["screenshot"]) : baseShot);
    if (shot) theme["screenshot"] = shot;
  }
}

/** CommonJS interop: playwright's chromium may live on the default export. */
function pickChromium(mod: Record<string, unknown>): unknown {
  const direct = mod["chromium"];
  if (direct) return direct;
  const dflt = mod["default"];
  if (typeof dflt === "object" && dflt !== null) {
    return (dflt as Record<string, unknown>)["chromium"];
  }
  return undefined;
}

/** Resolve Playwright's chromium from the repo, cwd, or bare specifier. */
export async function resolveChromium(repo: string | null): Promise<unknown> {
  const bases = [repo, process.cwd()].filter((b): b is string => Boolean(b));
  const attempts: Array<() => Promise<unknown>> = [];
  for (const mod of ["playwright", "playwright-core"]) {
    attempts.push(async () => pickChromium(await import(mod)));
    for (const base of bases) {
      attempts.push(async () => {
        const resolved = createRequire(join(base, "package.json")).resolve(mod);
        return pickChromium(await import(pathToFileURL(resolved).href));
      });
    }
  }
  for (const base of bases) {
    attempts.push(async () => {
      // Resolve via the package main: subpath resolution like
      // "@playwright/test/package.json" is blocked by its exports map.
      const ptest = createRequire(join(base, "package.json")).resolve("@playwright/test");
      const resolved = createRequire(ptest).resolve("playwright-core");
      return pickChromium(await import(pathToFileURL(resolved).href));
    });
  }
  for (const attempt of attempts) {
    try {
      const chromium = await attempt();
      if (chromium) return chromium;
    } catch {
      // try the next resolution strategy
    }
  }
  throw new Error(
    "Playwright not found. Install it in the target repo (npm i -D playwright && " +
      "npx playwright install chromium) or run from a repo that already has @playwright/test.",
  );
}

/**
 * Resolve a URL path against a root directory and return the absolute file
 * path only if it lies within the root. Returns null for any path that would
 * escape the root (directory traversal, absolute paths, encoded traversal, etc.).
 *
 * The caller is expected to have already decoded percent-encoding before
 * passing urlPath (the server does this via decodeURIComponent).
 */
export function containedPath(root: string, urlPath: string): string | null {
  const normalizedRoot = resolve(root);
  // For the root URL serve index.html; for everything else strip the leading slash.
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const candidate = resolve(join(normalizedRoot, rel));
  // The relative path from root to candidate must not start with ".." (which
  // would mean it escaped the root) and must not be absolute (Windows UNC).
  const rel2 = relative(normalizedRoot, candidate);
  if (rel2.startsWith("..") || sep !== "/" && rel2.startsWith(sep)) return null;
  // candidate must be strictly inside normalizedRoot, not the root dir itself.
  if (candidate === normalizedRoot) return null;
  return candidate;
}

function serveDir(root: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
      const file = containedPath(root, urlPath);
      if (file === null) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        const data = readFileSync(file);
        res.writeHead(200, {
          "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;

async function navigateToUnit(page: Page, navText: string | null, evalJs: string | null): Promise<void> {
  if (evalJs) {
    await page.evaluate(evalJs);
  } else if (navText) {
    const item = page
      .locator("nav, aside, .sidebar, #root")
      .locator(`text=${navText}`)
      .first();
    await item.click({ timeout: 5000 });
  }
  await page.waitForTimeout(900);
}

async function captureUnit(args: {
  chromium: any;
  url: string;
  navText: string | null;
  evalJs: string | null;
  viewport: { width: number; height: number };
  timeout: number;
  unitId: string;
  targets: Array<{ id: string; selectors: string[] }>;
  shotsDir: string;
}): Promise<{ baseShot: string | null; shots: Map<string, string>; skipped: string[] }> {
  const browser = await args.chromium.launch({ headless: true });
  const shots = new Map<string, string>();
  const skipped: string[] = [];
  let baseShot: string | null = null;
  try {
    const page = await browser.newPage({ viewport: args.viewport });
    await page.goto(args.url, { waitUntil: "networkidle", timeout: args.timeout });
    await page.waitForFunction("document.querySelector('#root') && document.querySelector('#root').children.length > 0", {
      timeout: args.timeout,
    });
    await navigateToUnit(page, args.navText, args.evalJs);
    await page.addStyleTag({ content: HIGHLIGHT_CSS });

    const basePath = join(args.shotsDir, `${args.unitId}.png`);
    await page.screenshot({ path: basePath, fullPage: false });
    baseShot = basePath;

    for (const target of args.targets) {
      const selectorList = JSON.stringify(target.selectors);
      const boxes: Box[] = await page.evaluate(
        `(() => {
          const selectors = ${selectorList};
          const seen = [];
          document.querySelectorAll('.cl-shot-highlight').forEach((el) => el.classList.remove('cl-shot-highlight'));
          for (const sel of selectors) {
            let matches = [];
            try { matches = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
            for (const el of matches.slice(0, ${MAX_MATCHES})) {
              el.classList.add('cl-shot-highlight');
              seen.push(el);
            }
          }
          if (seen.length > 0) seen[0].scrollIntoView({ block: 'center' });
          return seen.slice(0, ${MAX_MATCHES}).map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
          });
        })()`,
      );
      if (!boxes || boxes.length === 0) {
        skipped.push(`${target.id}: no elements matched ${target.selectors.join(", ")}`);
        continue;
      }
      await page.waitForTimeout(150);
      const size: { width: number; height: number } = await page.evaluate(
        "({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })",
      );
      const clip = unionClip(boxes, size.width, size.height);
      const shotPath = join(args.shotsDir, `${target.id}.png`);
      if (clip && clip.width >= 40 && clip.height >= 24) {
        await page.screenshot({ path: shotPath, clip, fullPage: true });
      } else {
        await page.screenshot({ path: shotPath, fullPage: false });
      }
      shots.set(target.id, shotPath);
    }
    await page.evaluate(
      "document.querySelectorAll('.cl-shot-highlight').forEach((el) => el.classList.remove('cl-shot-highlight'))",
    );
  } finally {
    await browser.close();
  }
  return { baseShot, shots, skipped };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "extract-dir": { type: "string" },
      entry: { type: "string" },
      findings: { type: "string" },
      "shots-dir": { type: "string" },
      repo: { type: "string" },
      "nav-text": { type: "string" },
      eval: { type: "string" },
      viewport: { type: "string", default: "1600x1000" },
      timeout: { type: "string", default: "30000" },
    },
  });
  const extractDir = values["extract-dir"];
  const entry = values.entry;
  const findingsPath = values.findings;
  const shotsDir = values["shots-dir"];
  if (!extractDir || !entry || !findingsPath || !shotsDir) {
    console.error("error: --extract-dir, --entry, --findings, and --shots-dir are required");
    return 1;
  }

  let doc: JsonObject;
  try {
    doc = JSON.parse(readFileSync(findingsPath, "utf-8")) as JsonObject;
  } catch (exc) {
    console.error(`error: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 1;
  }
  const errors = validateFindings(doc);
  if (errors.length > 0) {
    for (const error of errors) console.error(`${findingsPath}: ${error}`);
    return 1;
  }
  const unitId = String((doc["unit"] as JsonObject)["id"]);
  const targets = [...selectorTargets(doc), ...themeTargets(doc)];

  let chromium: unknown;
  try {
    chromium = await resolveChromium(values.repo ?? null);
  } catch (exc) {
    console.error(exc instanceof Error ? exc.message : String(exc));
    return 3;
  }

  const viewportMatch = /^(\d+)x(\d+)$/.exec(String(values.viewport));
  const viewport = viewportMatch
    ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) }
    : { width: 1600, height: 1000 };

  const { mkdirSync } = await import("node:fs");
  mkdirSync(shotsDir, { recursive: true });

  const { server, port } = await serveDir(String(extractDir));
  try {
    const url = `http://127.0.0.1:${port}/${String(entry)}`;
    const result = await captureUnit({
      chromium,
      url,
      navText: values["nav-text"] ?? null,
      evalJs: values.eval ?? null,
      viewport,
      timeout: Number(values.timeout),
      unitId,
      targets,
      shotsDir: String(shotsDir),
    });
    patchFindings(doc, result.shots, result.baseShot);
    writeFileSync(findingsPath, JSON.stringify(doc, null, 1), "utf-8");
    console.log(
      JSON.stringify({
        unit: unitId,
        base: result.baseShot,
        captured: result.shots.size,
        skipped: result.skipped,
      }),
    );
    return 0;
  } catch (exc) {
    console.error(`capture failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    return 2;
  } finally {
    server.close();
  }
}

runWhenMain(import.meta.url, main);
