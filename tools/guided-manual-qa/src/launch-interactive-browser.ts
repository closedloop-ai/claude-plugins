/**
 * launch-interactive-browser -- open a visible Playwright browser for a guided
 * manual QA walkthrough with per-origin localStorage fixtures preloaded before
 * the first application navigation.
 *
 * Playwright is resolved from the current working directory (the bootstrapped
 * repository under test), never bundled, so the browser matches the version the
 * repository already installs.
 *
 * Usage:
 *   launch-interactive-browser --url URL --storage-file FILE [options]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runWhenMain } from "../../shared/cli.js";

const HELP = `Usage:
  launch-interactive-browser.mjs --url URL --storage-file FILE [options]

Options:
  --auth-state FILE     Existing private Playwright storage state to merge
  --browser NAME        chromium (default), firefox, or webkit
  --channel NAME        Chromium channel such as chrome
  --ready-file FILE     Private readiness artifact path
  --ready-selector CSS  Wait for this visible control before reporting ready
  --state-name NAME     Human-readable matrix state
  --viewport WxH        Interactive viewport, for example 1440x1000
`;

const BROWSERS = ["chromium", "firefox", "webkit"] as const;
type BrowserName = (typeof BROWSERS)[number];

export interface Viewport {
  width: number;
  height: number;
}

export interface LaunchOptions {
  authState: string | undefined;
  browser: BrowserName;
  channel: string | undefined;
  readyFile: string | undefined;
  readySelector: string | undefined;
  stateName: string;
  storageFile: string;
  url: URL;
  viewport: Viewport | undefined;
}

export type StorageFixture = Record<string, string>;

interface StorageEntry {
  name: string;
  value: string;
}

interface OriginState {
  origin: string;
  localStorage?: StorageEntry[];
  [key: string]: unknown;
}

export interface StorageState {
  cookies: unknown[];
  origins: OriginState[];
  [key: string]: unknown;
}

/** Minimal structural view of the Playwright surface this launcher uses. */
interface PlaywrightPage {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): { waitFor(options: { state: "visible"; timeout: number }): Promise<void> };
  url(): string;
}

interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  storageState(): Promise<StorageState>;
}

interface PlaywrightBrowser {
  newContext(options: { storageState: StorageState; viewport?: Viewport }): Promise<PlaywrightContext>;
  close(): Promise<void>;
  once(event: "disconnected", listener: () => void): unknown;
}

interface PlaywrightBrowserType {
  launch(options: { headless: false; channel?: string }): Promise<PlaywrightBrowser>;
}

type Playwright = Partial<Record<BrowserName, PlaywrightBrowserType>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseViewport(value: string): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error("--viewport must use WIDTHxHEIGHT, for example 1440x1000");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 320) {
    throw new Error("--viewport dimensions must each be at least 320");
  }
  return { width, height };
}

/** Parse CLI arguments. Returns null when --help was requested. */
export function parseLaunchArguments(argv: string[]): LaunchOptions | null {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "auth-state": { type: "string" },
      browser: { type: "string", default: "chromium" },
      channel: { type: "string" },
      help: { type: "boolean" },
      "ready-file": { type: "string" },
      "ready-selector": { type: "string" },
      "state-name": { type: "string", default: "manual-qa" },
      "storage-file": { type: "string" },
      url: { type: "string" },
      viewport: { type: "string" },
    },
  });
  if (values.help) return null;

  if (!values.url || !values["storage-file"]) {
    throw new Error("--url and --storage-file are required");
  }
  const url = new URL(values.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must use http or https");
  }
  const browser = values.browser;
  if (!(BROWSERS as readonly string[]).includes(browser)) {
    throw new Error("--browser must be chromium, firefox, or webkit");
  }
  if (values.channel && browser !== "chromium") {
    throw new Error("--channel is supported only with --browser chromium");
  }

  return {
    authState: values["auth-state"] ? resolve(values["auth-state"]) : undefined,
    browser: browser as BrowserName,
    channel: values.channel,
    readyFile: values["ready-file"] ? resolve(values["ready-file"]) : undefined,
    readySelector: values["ready-selector"],
    stateName: values["state-name"],
    storageFile: resolve(values["storage-file"]),
    url,
    viewport: values.viewport ? parseViewport(values.viewport) : undefined,
  };
}

/** Validate a parsed storage fixture: a JSON object of non-empty keys to string values. */
export function validateStorageFixture(parsed: unknown): StorageFixture {
  if (!isPlainObject(parsed)) {
    throw new Error("The storage fixture must be a JSON object");
  }
  const fixture: StorageFixture = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || typeof value !== "string") {
      throw new Error("Every storage fixture entry must have a non-empty key and string value");
    }
    fixture[key] = value;
  }
  return fixture;
}

/**
 * Merge the fixture into the target origin's localStorage, preserving cookies,
 * unrelated origins, and unrelated keys from an optional private auth state.
 */
export function mergeStorageState(baseState: unknown, origin: string, fixture: StorageFixture): StorageState {
  const base = baseState ?? { cookies: [], origins: [] };
  if (!isPlainObject(base) || !Array.isArray(base.cookies) || !Array.isArray(base.origins)) {
    throw new Error("The authentication state is not a valid Playwright storage state");
  }

  const origins = (base.origins as OriginState[]).map((entry) => ({ ...entry }));
  let target = origins.find((entry) => entry.origin === origin);
  if (!target) {
    target = { origin, localStorage: [] };
    origins.push(target);
  }
  const entries = new Map<string, string>(
    Array.isArray(target.localStorage) ? target.localStorage.map((entry) => [entry.name, entry.value]) : [],
  );
  for (const [name, value] of Object.entries(fixture)) {
    entries.set(name, value);
  }
  target.localStorage = [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  return { ...base, cookies: base.cookies, origins };
}

/** Throw when any fixture key is missing or differs in the observed browser state. */
export function verifyStorageFixture(observedState: StorageState, origin: string, fixture: StorageFixture): void {
  const target = observedState.origins.find((entry) => entry.origin === origin);
  const observed = new Map<string, string>(target?.localStorage?.map((entry) => [entry.name, entry.value]) ?? []);
  for (const [name, expected] of Object.entries(fixture)) {
    if (observed.get(name) !== expected) {
      throw new Error(`Browser storage verification failed for key: ${name}`);
    }
  }
}

/** Refuse a page that left the requested origin/path or is mid Clerk handshake. */
export function assertSettledUrl(settled: URL, target: URL): void {
  if (
    settled.origin !== target.origin ||
    settled.pathname !== target.pathname ||
    settled.searchParams.has("__clerk_handshake")
  ) {
    throw new Error("Browser did not settle on the requested origin and path");
  }
}

function loadPlaywrightFromCwd(): Playwright {
  const requireFromCwd = createRequire(join(process.cwd(), "noop.js"));
  for (const packageName of ["@playwright/test", "playwright"]) {
    try {
      return requireFromCwd(packageName) as Playwright;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
  }
  throw new Error(
    "Playwright is not installed in the current repository. Run this helper from a bootstrapped repository with @playwright/test or playwright installed.",
  );
}

function registerSignalCleanup(browser: PlaywrightBrowser): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      void browser.close().finally(() => process.exit(0));
    });
  }
}

async function main(argv: string[]): Promise<number> {
  const options = parseLaunchArguments(argv);
  if (!options) {
    process.stdout.write(HELP);
    return 0;
  }

  const fixture = validateStorageFixture(JSON.parse(await readFile(options.storageFile, "utf8")));
  const baseState: unknown = options.authState ? JSON.parse(await readFile(options.authState, "utf8")) : undefined;
  const storageState = mergeStorageState(baseState, options.url.origin, fixture);

  const browserType = loadPlaywrightFromCwd()[options.browser];
  if (!browserType) {
    throw new Error(`Unsupported browser: ${options.browser}`);
  }
  const browser = await browserType.launch(
    options.channel ? { headless: false, channel: options.channel } : { headless: false },
  );
  registerSignalCleanup(browser);

  try {
    const context = await browser.newContext(
      options.viewport ? { storageState, viewport: options.viewport } : { storageState },
    );
    const page = await context.newPage();
    await page.goto(options.url.href, { waitUntil: "domcontentloaded" });
    if (options.readySelector) {
      await page.locator(options.readySelector).waitFor({ state: "visible", timeout: 30_000 });
    }
    const settledUrl = new URL(page.url());
    assertSettledUrl(settledUrl, options.url);
    verifyStorageFixture(await context.storageState(), options.url.origin, fixture);

    const readiness = {
      version: 1,
      status: "ready",
      stateName: options.stateName,
      url: page.url(),
      origin: settledUrl.origin,
      storageKeys: Object.keys(fixture).sort(),
      browser: options.browser,
      channel: options.channel ?? null,
      authStateMerged: Boolean(options.authState),
      launchedAt: new Date().toISOString(),
    };
    if (options.readyFile) {
      await mkdir(dirname(options.readyFile), { recursive: true });
      await writeFile(options.readyFile, `${JSON.stringify(readiness, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(readiness)}\n`);

    await new Promise<void>((done) => browser.once("disconnected", done));
    return 0;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

runWhenMain(import.meta.url, main);
