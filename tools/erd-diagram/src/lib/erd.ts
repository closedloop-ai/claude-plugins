/**
 * erd-diagram commands: find a repo's schema sources, extract the model, and build or
 * update the interactive HTML. Only code is read; no database connection is ever made.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Domain, draft, hubs as findHubs, merge, validateDomains } from "./domains.js";
import { domainLayouts, fullLayout } from "./layout.js";
import { byString, type ErdModel, validateModel } from "./model.js";
import { extractPrisma } from "./prisma.js";
import { extractSql } from "./sql.js";

export const STYLES = ["schema-explorer", "canvas-sidebar"] as const;
export type Style = (typeof STYLES)[number];

export class ErdError extends Error {}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".next",
  ".turbo",
  "coverage",
  "tmp",
  ".venv",
  "venv",
  "__pycache__",
  ".claude",
  "target",
]);
const SKIP_PATH = /(^|\/)(test|tests|__tests__|fixtures?|spec|examples?|docs?)(\/|$)/i;
const MIGRATION_DIR = /(^|\/)(migrations?|migrate|drizzle|schema)$/i;
const DUMP_FILE = /(^|\/)(structure|schema|.*schema.*|dump)\.sql$/i;
const PROVIDER_RE = /datasource\s+\w+\s*\{[^}]*?\bprovider\s*=\s*"(\w+)"/g;
const LOCK_RE = /provider\s*=\s*"(\w+)"/g;
const SPEC_RE = /^(prisma|sql|json):(.+)$/;
const PLACEHOLDER = /__(TITLE|META|SCHEMA|LAYOUT|DOMAINS|HUBS)__/g;
const BRAND_RE = /<div class="brand"><strong>(.*?)<\/strong>/s;
const NON_ASCII = /[\u0080-\uffff]/g;
const POSTGRES_PROVIDERS = new Set(["postgresql", "postgres", "cockroachdb"]);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

export interface Source {
  spec: string;
  kind: "prisma" | "sql-dump" | "sql-migrations";
  path: string;
  files: number;
  database: string;
}

export interface Meta {
  generator: "erd-diagram";
  version: 1;
  style: Style;
  title: string;
  source: { kind: string; path: string };
  repoRoot: string;
  commit: string;
  hubs: string[];
  generatedAt: string;
  exclude?: string;
}

export interface DiagramInfo extends Partial<Meta> {
  path: string;
  legacy: boolean;
  domains: Domain[];
}

export interface BuildOptions {
  style: string;
  out: string;
  spec: string;
  repo: string;
  templatesDir: string;
  domainMap?: Domain[] | null;
  title?: string | null;
  exclude?: string | null;
}

export interface BuildResult {
  out: string;
  style: Style;
  title: string;
  source: string;
  commit: string;
  tables: number;
  relations: number;
  enums: number;
  domains: number;
  draftedDomains: boolean;
  unsorted: string[];
  hubs: string[];
}

export interface UpdateResult extends BuildResult {
  updated: true;
  previousStyle: string | undefined;
  wasLegacy: boolean;
  newTables: string[];
  removedTables: string[];
}

export function git(repo: string, ...args: string[]): string | null {
  const res = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

export function repoRoot(start?: string | null): string {
  const abs = resolve(start || process.cwd());
  return git(abs, "rev-parse", "--show-toplevel") || abs;
}

function walkFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else {
        out.push(relative(repo, join(dir, entry.name)));
      }
    }
  };
  walk(repo);
  return out;
}

function repoFiles(repo: string): string[] {
  const listed = git(repo, "ls-files", "--cached", "--others", "--exclude-standard");
  if (listed !== null) return listed.split("\n").filter(Boolean);
  return walkFiles(repo);
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function tryRead(path: string): string {
  try {
    return readText(path);
  } catch {
    return "";
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** postgres, another engine name, or unknown. */
function providerOf(repo: string, paths: string[], lockDir?: string): string {
  const names = new Set<string>();
  for (const rel of paths) {
    for (const m of tryRead(join(repo, rel)).matchAll(PROVIDER_RE)) names.add(m[1] ?? "");
  }
  if (lockDir !== undefined) {
    for (const m of tryRead(join(repo, lockDir, "migration_lock.toml")).matchAll(LOCK_RE)) names.add(m[1] ?? "");
  }
  if (!names.size) return "unknown";
  if ([...names].some((n) => POSTGRES_PROVIDERS.has(n))) return "postgres";
  return [...names].sort(byString)[0] ?? "unknown";
}

function inMigrationDir(path: string): boolean {
  const parts = path.split("/").slice(0, -1);
  return parts.some((_, i) => MIGRATION_DIR.test(parts.slice(0, i + 1).join("/")));
}

function migrationDirOf(file: string): string | null {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    const d = parts.slice(0, i).join("/");
    if (MIGRATION_DIR.test(d)) return d;
  }
  return null;
}

export function detect(repo: string): Source[] {
  const files = repoFiles(repo).filter(
    (f) => !f.split("/").some((part) => SKIP_DIRS.has(part)) && !SKIP_PATH.test(dirOf(f)),
  );
  const found: Source[] = [];
  const prismaDirs = new Map<string, string[]>();
  for (const f of files.filter((x) => x.endsWith(".prisma")).sort(byString)) {
    prismaDirs.set(dirOf(f), [...(prismaDirs.get(dirOf(f)) ?? []), f]);
  }
  for (const [d, fs] of [...prismaDirs].sort((a, b) => byString(a[0], b[0]))) {
    const path = fs.length === 1 ? (fs[0] ?? d) : d;
    found.push({ spec: `prisma:${path}`, kind: "prisma", path, files: fs.length, database: providerOf(repo, fs) });
  }
  const sql = files.filter((f) => f.endsWith(".sql"));
  for (const f of sql.filter((x) => DUMP_FILE.test(x) && !inMigrationDir(x)).sort(byString)) {
    found.push({ spec: `sql:${f}`, kind: "sql-dump", path: f, files: 1, database: "unknown" });
  }
  const migDirs = new Map<string, number>();
  for (const f of sql) {
    const d = migrationDirOf(f);
    if (d !== null) migDirs.set(d, (migDirs.get(d) ?? 0) + 1);
  }
  for (const [d, n] of [...migDirs].sort((a, b) => byString(a[0], b[0]))) {
    found.push({ spec: `sql:${d}`, kind: "sql-migrations", path: d, files: n, database: providerOf(repo, [], d) });
  }
  return found;
}

function parseSpec(spec: string | null | undefined): [string, string] {
  const m = SPEC_RE.exec(spec ?? "");
  if (!m) throw new ErdError(`source ${JSON.stringify(spec)} must look like prisma:<path>, sql:<path> or json:<path>`);
  return [m[1] ?? "", m[2] ?? ""];
}

function readJsonModel(path: string): ErdModel {
  const raw: unknown = JSON.parse(readText(path));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ErdError(`${path} must hold a JSON object with models, enums and relations`);
  }
  const obj = raw as Record<string, unknown>;
  return { models: obj.models, enums: obj.enums ?? {}, relations: obj.relations ?? [] } as ErdModel;
}

export function extract(
  spec: string,
  repo: string,
  exclude?: string | null,
): { model: ErdModel; kind: string; rel: string } {
  const [kind, given] = parseSpec(spec);
  const path = isAbsolute(given) ? given : join(repo, given);
  if (!existsSync(path)) throw new ErdError(`schema source ${path} does not exist`);
  let model: ErdModel;
  if (kind === "prisma") model = extractPrisma(path);
  else if (kind === "sql") model = extractSql(path, exclude);
  else model = readJsonModel(path);
  const problems = validateModel(model);
  if (problems.length) {
    throw new ErdError(`the extracted model is not renderable:\n  ${problems.slice(0, 40).join("\n  ")}`);
  }
  const rel = relative(repo, path) || ".";
  return { model, kind, rel: rel.startsWith("..") ? resolve(path) : rel };
}

function commitLabel(repo: string, relSource: string): string {
  const sha = git(repo, "rev-parse", "--short", "HEAD");
  if (!sha) return "not a git repo";
  const dirty = git(repo, "status", "--porcelain", "--", relSource);
  return sha + (dirty ? " + local changes" : "");
}

function embeddedJson(text: string, scriptId: string): unknown {
  const re = new RegExp(`<script id="${scriptId}" type="application/json">(.*?)</script>`, "s");
  const m = re.exec(text);
  return m ? JSON.parse(m[1] ?? "null") : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function htmlUnescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ent.toLowerCase()] ?? whole;
  });
}

function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function asDomains(value: unknown): Domain[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (d): d is Domain => typeof d === "object" && d !== null && (d as Record<string, unknown>).id !== "unsorted",
  );
}

export function inspect(path: string): DiagramInfo {
  if (!existsSync(path) || !statSync(path).isFile()) throw new ErdError(`${path} does not exist`);
  const text = readText(path);
  const embedded = embeddedJson(text, "erd-meta") as Partial<Meta> | null;
  const meta = embedded ?? legacyMeta(path, text);
  const legacy = embedded === null;
  const doms =
    meta.style === "schema-explorer"
      ? (embeddedJson(text, "layout-data") as { domains?: unknown } | null)?.domains
      : embeddedJson(text, "domain-data");
  return { path: resolve(path), legacy, ...meta, domains: asDomains(doms) };
}

/** Style and title of a diagram made before erd-diagram embedded its metadata. */
function legacyMeta(path: string, text: string): Partial<Meta> {
  let style: Style;
  if (text.includes('role="tablist"') && text.includes('id="layout-data"')) style = "schema-explorer";
  else if (text.includes('id="domain-data"') && text.includes('id="minicanvas"')) style = "canvas-sidebar";
  else throw new ErdError(`${path} is not a diagram made by erd-diagram`);
  const t = BRAND_RE.exec(text);
  return { style, title: t ? htmlUnescape(t[1] ?? "") : undefined };
}

/**
 * JSON for an inline <script> block. ASCII-only output (non-ASCII as \uXXXX) keeps
 * U+2028/U+2029 and the file's charset out of play; "</" and "<!--" are escaped so the
 * data cannot close or comment out its script element.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(NON_ASCII, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replaceAll("</", "<\\u002f")
    .replaceAll("<!--", "<\\u0021--");
}

async function render(
  style: Style,
  model: ErdModel,
  domainMap: Domain[],
  meta: Meta,
  sourceLabel: string,
  templatesDir: string,
): Promise<string> {
  const data = { meta: { source: sourceLabel, commit: meta.commit }, ...model };
  const layout =
    style === "schema-explorer" ? await domainLayouts(model, domainMap) : await fullLayout(model, new Set(meta.hubs));
  const values: Record<string, string> = {
    TITLE: htmlEscape(meta.title),
    META: safeJson(meta),
    SCHEMA: safeJson(data),
    LAYOUT: safeJson(layout),
    DOMAINS: safeJson(domainMap),
    HUBS: safeJson(Object.fromEntries(meta.hubs.map((h) => [h, true]))),
  };
  const template = readText(join(templatesDir, `${style}.html`));
  return template.replace(PLACEHOLDER, (_, key: string) => values[key] ?? "");
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const tmp = `${path}.erd-tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function isStyle(style: string): style is Style {
  return (STYLES as readonly string[]).includes(style);
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const { style, out, spec, repo, templatesDir } = opts;
  if (!isStyle(style)) throw new ErdError(`style must be one of ${STYLES.join(", ")}`);
  const { model, kind, rel } = extract(spec, repo, opts.exclude);
  const drafted = !opts.domainMap;
  const domainMap = opts.domainMap ?? draft(model);
  const problems = validateDomains(domainMap, model);
  if (problems.length) throw new ErdError(`domain map problems:\n  ${problems.slice(0, 40).join("\n  ")}`);
  const hubList = findHubs(model);
  const meta: Meta = {
    generator: "erd-diagram",
    version: 1,
    style,
    title: opts.title || `${basename(repo)} schema`,
    source: { kind, path: rel },
    repoRoot: repo,
    commit: commitLabel(repo, rel),
    hubs: hubList,
    generatedAt: utcStamp(),
  };
  if (opts.exclude) meta.exclude = opts.exclude;
  writeAtomic(out, await render(style, model, domainMap, meta, rel, templatesDir));
  const placed = new Set(domainMap.flatMap((d) => d.tables));
  return {
    out: resolve(out),
    style,
    title: meta.title,
    source: `${kind}:${rel}`,
    commit: meta.commit,
    tables: model.models.length,
    relations: model.relations.length,
    enums: Object.keys(model.enums).length,
    domains: domainMap.length,
    draftedDomains: drafted,
    unsorted: model.models
      .map((m) => m.name)
      .filter((n) => !placed.has(n))
      .sort(byString),
    hubs: hubList,
  };
}

export function loadJson(path: string): unknown {
  return JSON.parse(readText(path));
}

export function pickSource(repo: string): string {
  const cands = detect(repo).filter((c) => c.database === "postgres" || c.database === "unknown");
  for (const kind of ["prisma", "sql-dump", "sql-migrations"] as const) {
    const ofKind = cands.filter((c) => c.kind === kind);
    if (ofKind.length === 1) return ofKind[0]?.spec ?? "";
    if (ofKind.length > 1) {
      throw new ErdError(`several schema sources found; pass --source with one of: ${ofKind.map((c) => c.spec).join(", ")}`);
    }
  }
  throw new ErdError("no Postgres Prisma schema, SQL dump or SQL migrations found; pass --source");
}

export interface UpdateOptions {
  path: string;
  templatesDir: string;
  style?: string | null;
  spec?: string | null;
  repo?: string | null;
  domainsPath?: string | null;
  title?: string | null;
}

function updateRoot(info: DiagramInfo, repo?: string | null): string {
  if (repo) return repoRoot(repo);
  const saved = info.repoRoot;
  if (saved && existsSync(saved) && statSync(saved).isDirectory()) return saved;
  return repoRoot(null);
}

export async function update(opts: UpdateOptions): Promise<UpdateResult> {
  const info = inspect(opts.path);
  const style = opts.style || info.style || "";
  const root = updateRoot(info, opts.repo);
  const src = info.source;
  const spec = opts.spec || (src ? `${src.kind}:${src.path}` : pickSource(root));
  const { model } = extract(spec, root, info.exclude);
  let domainMap: Domain[];
  let added: string[] = [];
  let removed: string[] = [];
  if (opts.domainsPath) {
    domainMap = loadJson(opts.domainsPath) as Domain[];
  } else if (info.domains.length) {
    ({ domains: domainMap, added, removed } = merge(info.domains, model));
  } else {
    domainMap = draft(model);
  }
  const before = new Set(info.domains.flatMap((d) => d.tables));
  const result = await build({
    style,
    out: opts.path,
    spec,
    repo: root,
    templatesDir: opts.templatesDir,
    domainMap,
    title: opts.title || info.title,
    exclude: info.exclude,
  });
  const names = model.models.map((m) => m.name);
  return {
    ...result,
    updated: true,
    previousStyle: info.style,
    wasLegacy: info.legacy,
    newTables: before.size ? names.filter((n) => !before.has(n)).sort(byString) : added,
    removedTables: removed,
  };
}
