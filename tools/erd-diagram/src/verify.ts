/**
 * Renders a generated ERD headlessly (no window) and checks that it works.
 *   node verify.mjs <diagram.html> [screenshot-prefix]
 * Prints JSON and exits 0 when the page passes, 1 when it does not. Prints "skipped" and
 * exits 0 when no puppeteer install can be found (ERD_PUPPETEER, a local one, or a global one).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runWhenMain } from "../../shared/cli.js";
import type { ErdModel } from "./lib/model.js";

interface Page {
  on(event: "pageerror", fn: (e: unknown) => void): void;
  on(event: "console", fn: (m: { type(): string; text(): string }) => void): void;
  setViewport(v: { width: number; height: number }): Promise<void>;
  goto(url: string): Promise<unknown>;
  screenshot(o: { path: string }): Promise<unknown>;
  $$eval<T>(selector: string, fn: (els: Array<{ value: string }>) => T): Promise<T>;
  evaluate<T>(expression: string): Promise<T>;
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
}

interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
  process(): { kill(signal: string): void } | null;
}

interface Puppeteer {
  launch(o: { headless: boolean }): Promise<Browser>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findPuppeteer(): Puppeteer | null {
  const req = createRequire(join(process.cwd(), "noop.js"));
  const tries: string[] = [];
  if (process.env.ERD_PUPPETEER) tries.push(process.env.ERD_PUPPETEER);
  tries.push("puppeteer");
  try {
    const root = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    tries.push(join(root, "puppeteer"), join(root, "@mermaid-js/mermaid-cli/node_modules/puppeteer"));
  } catch {
    // npm missing: only the explicit and bare-name tries remain
  }
  for (const t of tries) {
    try {
      return req(t) as Puppeteer;
    } catch {
      // try the next location
    }
  }
  return null;
}

function embedded<T>(html: string, id: string): T {
  const m = new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error(`no ${id} block; not an erd-diagram file`);
  return JSON.parse(m[1] ?? "null") as T;
}

interface Checks {
  nodesRendered?: number;
  sidebarItems?: number;
  overviewItems?: number;
  domainsRendered?: number;
  domains?: number;
  tableViewRows?: number;
  searchHash?: string;
}

const count = (page: Page, selector: string) => page.$$eval(selector, (n) => n.length);

async function explorerChecks(page: Page, url: string, target: string, checks: Checks): Promise<void> {
  checks.overviewItems = await count(page, ".olist button");
  checks.sidebarItems = await count(page, ".titem");
  const domainIds = await page.$$eval("#dsel option", (o) => o.map((x) => x.value));
  checks.domainsRendered = 0;
  for (const id of domainIds) {
    await page.goto(`${url}#diagram/${id}`);
    await wait(150);
    if ((await count(page, ".node")) > 0) checks.domainsRendered += 1;
  }
  checks.domains = domainIds.length;
  await page.goto(`${url}#table/${target}`);
  await wait(300);
  checks.tableViewRows = await count(page, ".frow");
}

async function main(argv: string[]): Promise<number> {
  const [file, shotPrefix] = argv;
  if (!file || !existsSync(file)) {
    console.log(JSON.stringify({ ok: false, error: `no such file ${file}` }));
    return 1;
  }
  const puppeteer = findPuppeteer();
  if (!puppeteer) {
    console.log(
      JSON.stringify({ skipped: "puppeteer not found; set ERD_PUPPETEER to a puppeteer install to enable render checks" }),
    );
    return 0;
  }
  const html = readFileSync(file, "utf8");
  const meta = embedded<{ style: string }>(html, "erd-meta");
  const model = embedded<ErdModel>(html, "schema-data");
  const tables = model.models.map((m) => m.name);
  const target = [...model.models].sort((a, b) => b.fields.length - a.fields.length)[0];
  const col = target?.fields.find((f) => f.kind !== "relation");
  if (!target || !col) throw new Error("the diagram has no table with a column to search for");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.setViewport({ width: 1600, height: 1000 });
  const url = pathToFileURL(resolve(file)).href;
  const checks: Checks = {};
  await page.goto(url);
  await wait(500);
  if (shotPrefix) await page.screenshot({ path: `${shotPrefix}-start.png` });

  if (meta.style === "canvas-sidebar") {
    checks.nodesRendered = await count(page, ".node");
    checks.sidebarItems = await count(page, ".titem");
  } else {
    await explorerChecks(page, url, target.name, checks);
  }

  await page.goto(url);
  await wait(300);
  await page.keyboard.press("/");
  await page.keyboard.type(`${target.name}.${col.name}`);
  await wait(150);
  await page.keyboard.press("Enter");
  await wait(1200);
  checks.searchHash = await page.evaluate<string>("decodeURIComponent(location.hash)");
  if (shotPrefix) await page.screenshot({ path: `${shotPrefix}-search.png` });
  // Headless Chrome can take most of a minute to shut down; give it 5s, then kill it.
  await Promise.race([browser.close(), wait(5000)]);
  browser.process()?.kill("SIGKILL");

  const expectHash =
    meta.style === "canvas-sidebar" ? `#${target.name}.${col.name}` : `#table/${target.name}.${col.name}`;
  const columns = target.fields.filter((f) => f.kind !== "relation").length;
  const styleOk =
    meta.style === "canvas-sidebar"
      ? checks.nodesRendered === tables.length
      : checks.overviewItems === tables.length &&
        checks.domainsRendered === checks.domains &&
        checks.tableViewRows === columns;
  const ok = errors.length === 0 && checks.sidebarItems === tables.length && checks.searchHash === expectHash && styleOk;
  console.log(
    JSON.stringify({
      ok,
      style: meta.style,
      tables: tables.length,
      searched: `${target.name}.${col.name}`,
      expectHash,
      checks,
      errors,
    }),
  );
  return ok ? 0 : 1;
}

runWhenMain(import.meta.url, async (argv) => {
  try {
    return await main(argv);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }));
    return 1;
  }
});
