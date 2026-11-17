// Builds the ClosedLoop vibe: plugins/vibe with the ClosedLoop provider's text assembled in, written to
// plugins/vibe-closedloop. Markdown goes through provider.mjs's assembleProviderText with every capability the
// contract declares; every other runtime file is copied byte for byte. The provider's build.json says what the
// assembler cannot: the manifest and frontmatter descriptions, the cold blocks that live in their own files, the
// line over recipe text, and where each whole reference file goes. The built plugin carries the provider's contract
// in provider/provider.json and no block file: the assembled text is all a reader needs.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleProviderText,
  BUNDLED_PROVIDER_DIR,
  CONTRACT_FILE,
  providerBlock,
  providerStubs,
  readContract,
  type ProviderContract,
} from "../../../plugins/vibe-core/lib/vibe/scripts/provider.mjs";

export const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface BuildPaths {
  /** The plugin the build starts from (plugins/vibe). */
  source: string;
  /** The provider plugin whose contract, references and build.json the build reads. */
  provider: string;
  /** Where the built plugin is written (plugins/vibe-closedloop). */
  output: string;
}

export const DEFAULT_PATHS: BuildPaths = {
  source: join(REPO, "plugins/vibe"),
  provider: join(REPO, "plugins/vibe-closedloop-provider"),
  output: join(REPO, "plugins/vibe-closedloop"),
};

/** The built plugin's manifest name, whatever the source plugin calls itself. */
export const BUILT_NAME = "vibe";
export const BUILD_DATA = "build.json";
export const MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] as const;

/**
 * Files of the source plugin that are not runtime and stay out of the build, each with why. Paths are relative to
 * the source plugin. Every test-support module listed by name has no importer outside tests.
 */
export const EXCLUDED: readonly { pattern: RegExp; why: string }[] = [
  // Not the Codex model policy: cl-sweep/scripts/model-policy.mjs reads it at load as the one default model source.
  { pattern: /^evals\/(?!codex\/model-policy\.json$)/, why: "eval cases and their runner" },
  { pattern: /^tools\//, why: "contract tests and the modules only they use" },
  { pattern: /\.test\.(?:mjs|cjs|js|ts)$/, why: "node and vitest tests" },
  { pattern: /(?:^|\/)test_[^/]*\.py$/, why: "pytest tests" },
  { pattern: /(?:^|\/)fixtures\//, why: "test fixtures" },
  { pattern: /(?:^|\/)(?:__pycache__|node_modules)\/|\.pyc$|(?:^|\/)\.DS_Store$/, why: "caches and installs" },
  {
    pattern: /^skills\/(?:vibe\/scripts\/(?:test-fixtures|skill-split)|cl-sweep\/scripts\/core-client-fixture|codex-fleet-monitor\/scripts\/test-support|fleet-orchestrator\/scripts\/fleet-test-support|handoff\/scripts\/(?:diff-rules|lockfile-manifest|targeted-tests-ruling)-test-fixture)\.mjs$/,
    why: "test support imported only by tests",
  },
];

interface BuildData {
  manifests: Record<string, Record<string, unknown>>;
  descriptions: Record<string, string>;
  /** Per provider reference file, groups of block ids; each group, and the text between its blocks, moves to one file. */
  cold: Record<string, string[][]>;
  coldPointer: string;
  recipesNote: string;
  /**
   * Each provider reference file read whole (not a block source), mapped to its path in the built plugin: where
   * plugins/vibe on main kept it, so built text names it as main's did. It replaces a source file at that path.
   */
  place: Record<string, string>;
}

type Binding = { state: "bound"; name: string; root: string; capabilities: string[] };

const RECIPES = "recipes";
/** The built contract's references folder: the plugin around provider/, so its `placed` paths are the plugin's own. */
const BUNDLED_REFERENCES = "..";
const BLOCK_START = /^<!-- block: [a-z0-9-]+ -->$/m;
const PLACED_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_./-]+\.md$/;
const PROVIDER_NAME = /(?<![\w-])provider:((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.md)/g;
const GENERIC_PREFIX = /(?<![\w-])vibe-generic:/g;
/** The generic plugin's own install id (`vibe-generic@<marketplace>`) and cache folder (a `/vibe-generic/` path segment). */
const GENERIC_INSTALL_ID = /(?<![\w-])vibe-generic@/g;
const GENERIC_CACHE_SEGMENT = /\/vibe-generic\//g;
const LEFTOVER_STUB = /^> Provider `/m;
const COLD_BEGIN = (file: string, name: string) => `<!-- vibe-closedloop-build cold-begin ${file} ${name} -->`;
const COLD_END = (file: string, name: string) => `<!-- vibe-closedloop-build cold-end ${file} ${name} -->`;
const COLD_SECTION = /^<!-- vibe-closedloop-build cold-begin (\S+) (\S+) -->\n([\s\S]*?)\n<!-- vibe-closedloop-build cold-end \1 \2 -->\n?/gm;
const COLD_SENTINEL_LEFT = /^<!-- vibe-closedloop-build cold-/m;

export function isExcluded(relative: string): boolean {
  return EXCLUDED.some(({ pattern }) => pattern.test(relative));
}

/** The built path of the cold section named `id` (its first block's id) taken out of source file `relative`. */
export function coldPath(relative: string, id: string): string {
  const dir = posix.dirname(relative);
  // A skill's references name paths from the skill's folder, as its SKILL.md does, so a block moved there keeps them.
  const folder = posix.basename(relative) === "SKILL.md" ? posix.join(dir, "references") : dir;
  return posix.join(folder, `closedloop-${id}.md`);
}

/**
 * One build: the provider's contract and data, and a staged copy of its references in which each cold group opens
 * and closes with a sentinel line, so assembleProviderText places the section as it would inline and the build then
 * moves what lies between the sentinels to its own file.
 */
export class ClosedLoopBuild {
  readonly paths: BuildPaths;
  readonly contract: ProviderContract;
  readonly data: BuildData;
  readonly binding: Binding;
  private readonly realBinding: Binding;
  private readonly stage: string;
  private readonly groups: { file: string; ids: string[] }[] = [];
  private readonly assembled = new Map<string, Assembled>();

  constructor(paths: BuildPaths = DEFAULT_PATHS) {
    this.paths = paths;
    const contract = readContract(paths.provider);
    if (!contract) throw new Error(`${paths.provider} has no provider contract vibe can read`);
    this.contract = contract;
    this.data = JSON.parse(readFileSync(join(paths.provider, BUILD_DATA), "utf8")) as BuildData;
    checkPlacement(join(paths.provider, contract.references), this.data.place);
    const capabilities = Object.keys(contract.capabilities);
    this.realBinding = { state: "bound", name: contract.name, root: paths.provider, capabilities };
    this.stage = mkdtempSync(join(tmpdir(), "vibe-closedloop-build-"));
    cpSync(paths.provider, this.stage, { recursive: true });
    for (const [file, groups] of Object.entries(this.data.cold).sort(([a], [b]) => compare(a, b))) {
      const reference = join(this.stage, contract.references, file);
      let text = readFileSync(reference, "utf8");
      const mark = (id: string, edit: (block: string) => string) => {
        const block = providerBlock(this.realBinding, capabilities.join("+"), file, id);
        if (text.indexOf(block) !== text.lastIndexOf(block)) throw new Error(`cold block ${file} ${id} is not unique in its file`);
        text = text.replace(block, () => edit(block));
      };
      for (const ids of groups) {
        const [first] = ids;
        const last = ids.at(-1);
        if (first === undefined || last === undefined) throw new Error(`an empty cold group in ${file}`);
        mark(first, (block) => `${COLD_BEGIN(file, first)}\n${block}`);
        mark(last, (block) => `${block}\n${COLD_END(file, first)}`);
        this.groups.push({ file, ids });
      }
      writeFileSync(reference, text);
    }
    this.binding = { ...this.realBinding, root: this.stage };
  }

  close(): void {
    rmSync(this.stage, { recursive: true, force: true });
  }

  /** Every file of the built plugin, relative to it, mapped to how it is made; sorted. */
  plan(): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    const add = (relative: string, entry: Entry) => {
      if (entries.has(relative)) throw new Error(`two build outputs at ${relative}`);
      entries.set(relative, entry);
    };
    const placed = new Map(Object.entries(this.data.place).map(([file, target]) => [target, file]));
    for (const relative of sourceFiles(this.paths.source)) {
      if (placed.has(relative)) continue;
      if ((MANIFESTS as readonly string[]).includes(relative)) add(relative, { kind: "manifest", relative });
      else if (relative.endsWith(".md")) {
        add(relative, { kind: "markdown", relative });
        for (const group of this.groupsIn(this.sourceMarkdown(relative))) add(coldPath(relative, group.name), { kind: "cold", relative, id: group.name });
      } else add(relative, { kind: "copy", relative });
    }
    add(`${BUNDLED_PROVIDER_DIR}/${CONTRACT_FILE}`, { kind: "contract", relative: CONTRACT_FILE });
    for (const [target, file] of placed) add(target, { kind: "reference", relative: file });
    return new Map([...entries].sort(([a], [b]) => compare(a, b)));
  }

  /** The bytes of one built file. */
  render(target: string, entry: Entry): Buffer {
    switch (entry.kind) {
      case "copy":
        return readFileSync(join(this.paths.source, entry.relative));
      case "reference":
        return readFileSync(join(this.paths.provider, this.contract.references, entry.relative));
      case "contract":
        return json({ ...this.contract, references: BUNDLED_REFERENCES, placed: this.data.place });
      case "manifest":
        return json(this.manifest(entry.relative));
      case "markdown":
        return Buffer.from(this.markdown(entry.relative, target));
      case "cold":
        return Buffer.from(this.cold(entry.relative, entry.id, target));
    }
  }

  /** The text of built file `target` (relative to the built plugin), made from the current sources. */
  text(target: string): string {
    const entry = this.plan().get(target);
    if (!entry) throw new Error(`${target} is not in the built plugin`);
    return this.render(target, entry).toString("utf8");
  }

  /** Writes the built plugin to `paths.output`, replacing what was there. Returns the number of files written. */
  write(): number {
    const plan = this.plan();
    rmSync(this.paths.output, { recursive: true, force: true });
    for (const [target, entry] of plan) {
      const file = join(this.paths.output, target);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, this.render(target, entry));
      chmodSync(file, executable(entry, this.paths) ? 0o755 : 0o644);
    }
    return plan.size;
  }

  private sourceMarkdown(relative: string): string {
    return readFileSync(join(this.paths.source, relative), "utf8");
  }

  /** The cold groups whose first block `text` stubs, each with its stubs and the name its file takes. */
  private groupsIn(text: string): { name: string; stubs: ReturnType<typeof providerStubs> }[] {
    const stubs = providerStubs(text);
    return this.groups.flatMap(({ file, ids }) => {
      const members = stubs.filter((stub) => stub.file === file && ids.includes(stub.id));
      return members.some((stub) => stub.id === ids[0]) ? [{ name: ids[0] as string, stubs: members }] : [];
    });
  }

  /** Source file `relative` assembled, with each cold section cut out to its own text and a pointer left in its place. */
  private assemble(relative: string): Assembled {
    const cached = this.assembled.get(relative);
    if (cached) return cached;
    const source = this.sourceMarkdown(relative);
    const groups = this.groupsIn(source);
    const sections = new Map<string, string>();
    const text = assembleProviderText(source, this.binding).replace(COLD_SECTION, (_section, _file: string, name: string, body: string) => {
      sections.set(name, body);
      return `${this.data.coldPointer.replace("{path}", posix.relative(posix.dirname(relative), coldPath(relative, name)))}\n`;
    });
    const inCold = new Set(groups.flatMap((group) => group.stubs.map((stub) => `${stub.file} ${stub.id}`)));
    const result: Assembled = {
      text,
      recipes: providerStubs(source).some((stub) => stub.capability === RECIPES && !inCold.has(`${stub.file} ${stub.id}`)),
      cold: new Map(groups.map((group) => [group.name, {
        text: sections.get(group.name) ?? "",
        recipes: group.stubs.some((stub) => stub.capability === RECIPES),
      }])),
    };
    for (const [name, section] of result.cold) if (!sections.has(name) || !section.text) throw new Error(`${relative}: cold section ${name} did not assemble`);
    this.assembled.set(relative, result);
    return result;
  }

  private markdown(relative: string, target: string): string {
    const assembled = this.assemble(relative);
    let text = assembled.recipes ? withNote(assembled.text, this.data.recipesNote) : assembled.text;
    const description = this.data.descriptions[relative];
    if (description !== undefined) text = withDescription(text, description, relative);
    return this.finish(text, target);
  }

  private cold(relative: string, name: string, target: string): string {
    const section = this.assemble(relative).cold.get(name);
    if (!section) throw new Error(`no cold section ${name} in ${relative}`);
    return this.finish(section.recipes ? `${this.data.recipesNote}\n\n${section.text}\n` : `${section.text}\n`, target);
  }

  /**
   * Provider names become paths from the file to where the reference is placed, `vibe-generic:` ids become `vibe:`,
   * `vibe-generic@` install ids `vibe@`, `/vibe-generic/` cache folders `/vibe/`, and nothing is left.
   */
  private finish(text: string, target: string): string {
    const out = text
      .replace(PROVIDER_NAME, (_name, file: string) => {
        const placed = this.data.place[file];
        if (placed === undefined) throw new Error(`${target} names provider:${file}, which build.json does not place`);
        return posix.relative(posix.dirname(target), placed);
      })
      .replace(GENERIC_PREFIX, `${BUILT_NAME}:`)
      .replace(GENERIC_INSTALL_ID, `${BUILT_NAME}@`)
      .replace(GENERIC_CACHE_SEGMENT, `/${BUILT_NAME}/`);
    if (LEFTOVER_STUB.test(out) || COLD_SENTINEL_LEFT.test(out)) throw new Error(`${target} still holds provider stubs after assembly`);
    return out;
  }

  private manifest(relative: string): Record<string, unknown> {
    const source = JSON.parse(readFileSync(join(this.paths.source, relative), "utf8")) as Record<string, unknown>;
    const overlay = this.data.manifests[relative] ?? {};
    const merged: Record<string, unknown> = { ...source, name: BUILT_NAME };
    for (const [key, value] of Object.entries(overlay)) {
      const base = merged[key];
      merged[key] = isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
    }
    return merged;
  }
}

interface Assembled {
  text: string;
  /** Whether recipe text stays inline (a stub served by recipes alone, outside every cold section). */
  recipes: boolean;
  cold: Map<string, { text: string; recipes: boolean }>;
}

export type Entry =
  | { kind: "copy" | "markdown" | "manifest" | "reference" | "contract"; relative: string }
  | { kind: "cold"; relative: string; id: string };

/** Builds into `paths.output`. */
export function buildClosedLoopVibe(paths: BuildPaths = DEFAULT_PATHS): number {
  const build = new ClosedLoopBuild(paths);
  try {
    return build.write();
  } finally {
    build.close();
  }
}

/**
 * The text of one built file (relative to plugins/vibe-closedloop) made from the current sources, without writing
 * anything: what a contract test reads so it fails when the source text changes, built or not.
 */
export function builtText(target: string, paths: BuildPaths = DEFAULT_PATHS): string {
  const build = new ClosedLoopBuild(paths);
  try {
    return build.text(target);
  } finally {
    build.close();
  }
}

/** The source plugin's files the build reads: git's tracked and unignored files that exist, minus EXCLUDED; sorted. */
export function sourceFiles(source: string): string[] {
  const listed = execFileSync("git", ["-C", source, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set(listed.split("\0").filter(Boolean));
  return [...files].filter((relative) => !isExcluded(relative) && isFile(join(source, relative))).sort(compare);
}

/**
 * Every reference file is placed or is a block source, never both, so nothing the provider ships is dropped from the
 * build and no block file lands in it; each placed path stays inside the plugin and outside provider/.
 */
function checkPlacement(references: string, place: Record<string, string>): void {
  for (const [file, target] of Object.entries(place)) {
    if (!isFile(join(references, file))) throw new Error(`build.json places ${file}, which the provider does not have`);
    if (!PLACED_PATH.test(target) || target.startsWith(`${BUNDLED_PROVIDER_DIR}/`)) throw new Error(`build.json places ${file} at ${target}, which is not a path in the plugin outside provider/`);
  }
  for (const file of listFiles(references)) {
    const blocks = BLOCK_START.test(readFileSync(join(references, file), "utf8"));
    if (blocks === Object.hasOwn(place, file)) {
      throw new Error(blocks ? `build.json places ${file}, a block source the build assembles` : `${file} is neither a block source nor placed by build.json`);
    }
  }
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) out.push(...listFiles(path, relative));
    else out.push(relative);
  }
  return out.sort(compare);
}

function withNote(text: string, note: string): string {
  const lines = text.split("\n");
  let at = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    at = end + 1;
  }
  while (at < lines.length && lines[at] === "") at += 1;
  if (lines[at]?.startsWith("# ")) lines.splice(at + 1, 0, "", note);
  else lines.splice(at, 0, note, "");
  return lines.join("\n");
}

function withDescription(text: string, description: string, relative: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const lines = frontmatter?.[1]?.split("\n") ?? [];
  const at = lines.findIndex((line) => line.startsWith("description: "));
  if (!frontmatter || at === -1) throw new Error(`${relative} has no one-line frontmatter description to replace`);
  lines[at] = `description: ${description}`;
  return `---\n${lines.join("\n")}\n---\n${text.slice(frontmatter[0].length)}`;
}

function executable(entry: Entry, paths: BuildPaths): boolean {
  if (entry.kind === "copy") return (statSync(join(paths.source, entry.relative)).mode & 0o111) !== 0;
  return false;
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
