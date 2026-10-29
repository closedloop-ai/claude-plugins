// The prebuilt evidence bundle `handoff-inventory.mjs` adds in the handoff and
// pull-request phases (PRD-823, WS3 D7, ISS-13349), so `vibe-handoff-summarizer`
// writes prose over data instead of deriving it: the backend paths grouped by
// kind, the guard predicates and feature flag reads on the changed lines, the
// session's flag keys, the Storybook links to each changed story, and a blast
// bundle (owner, importing hosts, tests, stories, FEATURE_MAP ids) for each
// changed source file. Every field is read from the diff, the session record
// or the worktree; none is invented, and a field with nothing to say is an
// empty list, never a claim. The closedloop-graph tools (`code_callers`,
// `blast_radius_tickets`) are not called here: `blastBundle.source` says it is
// worktree evidence and the summarizer's graph calls stay owed.

import { createGraphPack } from "../../vibe/scripts/graph-pack.mjs";
import { execCommand } from "../../vibe/scripts/ws3-exec.mjs";
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { parseUnifiedDiff, storyId } from "./diff-rules.mjs";
import { renameLines } from "./guardrails-gate.mjs";
import { storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const STORY = /\.stories\.[jt]sx?$/;
const MAX_ITEMS = 50;
const MAX_BLAST_FILES = 40;
// A flag read: the key is a string literal or an upper-case constant; the call or tag may span lines.
const FLAG_CALL = /\b(?:useFeatureFlag(?:Enabled)?|isFlagEnabled|getFeatureFlag|checkFeatureFlag)\s*\(\s*(?:["'`]([^"'`]+)["'`]|([A-Z][A-Z0-9_]*)\b)|<FeatureFlagged\b[^>]*?\b(?:flag|flagKey|name)=(?:["']([^"']+)["']|\{\s*(?:["'`]([^"'`]+)["'`]|([A-Z][A-Z0-9_]*)\b))/g;
const MAX_ALIAS_DEPTH = 4;
const FLAG_MODULE_PATHSPECS = ["*-flag.ts", "*-flags.ts", "*/feature-flags.ts", "*/feature-flags/*.ts"];
const GUARD = /\b(?:withAnyAuth|requireRole|requireOrg|requireAuth|assertOrg|assertCan|isAdmin|hasRole|hasPermission|canManage|can\()|\b(?:orgId|organizationId)\b.*(?:!==|===)|\bif\s*\(\s*!\s*(?:user|session|org|auth|isAdmin|canEdit|isOwner)\w*/;
const FLAG_NAME = /\bfeature[- ]?flag\w*|\buseFeatureFlag\w*|\bFeatureFlagged\b|\bisFlagEnabled\b/i;

/** Backend files grouped by what they are: routes, services, schema, migrations, shared types, desktop main, other. */
export function backendGroups(backendFiles) {
  const kind = (file) => {
    if (/\/migrations\/|\/prisma\/migrations\//.test(`/${file}`)) return "migrations";
    if (/(?:^|\/)schema\.prisma$/.test(file) || file.startsWith("packages/database/")) return "schema";
    if (/\/route\.tsx?$/.test(file) || /^apps\/api\/app\//.test(file)) return "routes";
    if (/\/(?:lib|services?)\//.test(file) || /service[^/]*\.tsx?$/.test(file)) return "services";
    if (file.startsWith("packages/api/")) return "sharedTypes";
    if (file.startsWith("apps/desktop/")) return "desktopMain";
    return "other";
  };
  const groups = {};
  for (const entry of backendFiles) {
    const file = typeof entry === "string" ? entry : entry.path;
    (groups[kind(file)] ??= []).push(file);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, list.sort()]));
}

/** Added lines in changed source files that read a guard (auth, role, org match) or a feature flag; import lines and comments are not predicates. */
export function guardPredicates(files, readHead = () => undefined) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path))) {
    const imports = renameLines(readHead(file.path) ?? "");
    for (const { line, text } of file.added) {
      if (imports.has(line) || /^\s*(?:import|export)\b[^=]*\bfrom\b/.test(text) || /^\s*(?:\/\/|\/\*|\*)/.test(text)) continue;
      if (GUARD.test(text) || FLAG_NAME.test(text)) found.push({ file: file.path, line, text: text.trim().slice(0, 200) });
    }
  }
  return { predicates: found.slice(0, MAX_ITEMS), total: found.length };
}

const escapeName = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The literal a constant resolves to through string definitions and aliases, searching `texts` then `lookup(name)`; null when it does not. */
export function resolveConstant(name, texts, lookup, depth = 0) {
  if (depth > MAX_ALIAS_DEPTH) return null;
  const definition = new RegExp(`export\\s+const\\s+${escapeName(name)}\\s*(?::[^=]+)?=\\s*(?:"([^"]+)"|'([^']+)'|([A-Z][A-Z0-9_]*))\\s*(?:as const)?\\s*;`);
  for (const text of [...texts, ...lookup(name)]) {
    const match = definition.exec(text);
    if (!match) continue;
    const literal = match[1] ?? match[2];
    if (literal) return { key: literal, source: "definition" };
    const inner = resolveConstant(match[3], texts, lookup, depth + 1);
    if (inner) return { key: inner.key, source: `alias of ${match[3]}` };
  }
  return null;
}

/** Flag keys read in the changed source files (literal or constant, calls spanning lines included) on added lines, and the keys the session record proposed. */
export function flagKeys(files, record, readHead = () => undefined, lookup = () => []) {
  const reads = [];
  const sources = files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path));
  const texts = sources.map((entry) => readHead(entry.path)).filter((text) => typeof text === "string");
  for (const file of sources) {
    const added = new Set(file.added.map((entry) => entry.line));
    const head = readHead(file.path);
    const scanned = typeof head === "string" ? head : file.added.map((entry) => entry.text).join("\n");
    const lineOf = typeof head === "string" ? (index) => head.slice(0, index).split("\n").length : (index) => file.added[scanned.slice(0, index).split("\n").length - 1]?.line ?? 0;
    for (const match of scanned.matchAll(FLAG_CALL)) {
      const line = lineOf(match.index);
      const close = scanned.indexOf(match[0].startsWith("<") ? ">" : ")", match.index + match[0].length);
      const endLine = close === -1 ? line : lineOf(close);
      if (![...added].some((at) => at >= line && at <= Math.max(line, endLine))) continue;
      const literal = match[1] ?? match[3] ?? match[4];
      const constant = match[2] ?? match[5];
      if (literal) { reads.push({ key: literal, file: file.path, line }); continue; }
      const resolved = constant ? resolveConstant(constant, texts, lookup) : null;
      reads.push(resolved ? { key: resolved.key, file: file.path, line, constant, resolvedBy: resolved.source } : { key: null, file: file.path, line, constant, unresolved: true });
    }
  }
  const seen = new Set();
  const unique = reads.filter((item) => { const id = `${item.file}:${item.line}:${item.key ?? item.constant}`; if (seen.has(id)) return false; seen.add(id); return true; });
  return { readInDiff: unique.slice(0, MAX_ITEMS), recorded: record?.flagKeys ?? null };
}

/** Looks a constant's definition up in the repository's flag key modules (`git grep`, a few lines of context). */
export function flagModuleLookup(worktree, run = execCommand) {
  return (name) => {
    const grepped = run("git", ["-C", worktree, "grep", "-h", "-A3", "-E", `export const ${name}\\b`, "--", ...FLAG_MODULE_PATHSPECS]);
    return grepped.status === 0 ? grepped.stdout.split(/^--$/m) : [];
  };
}

/** The full-UI Storybook link for each story in a changed story file (`environment.md`, "Storybook links"). */
export function storybookLinks(files, record, readHead) {
  const base = record?.vercel?.storybookUrl ?? record?.stack?.storybookUrl ?? null;
  const stories = [];
  for (const file of files.filter((entry) => entry.status !== "D" && STORY.test(entry.path))) {
    const source = readHead(file.path);
    const title = source ? storyMetaTitle(source) : null;
    if (!title) continue;
    for (const name of storyExportNames(source)) {
      const id = storyId(title, name);
      stories.push({ file: file.path, storyId: id, url: base ? `${base.replace(/\/$/, "")}/?path=/story/${id}` : null });
    }
  }
  return { base, source: record?.vercel?.storybookUrl ? "verified Vercel storybookUrl" : record?.stack?.storybookUrl ? "local storybookUrl on the stack" : null, stories: stories.slice(0, MAX_ITEMS * 2), total: stories.length };
}

/** Owner, importing hosts, tests, stories and FEATURE_MAP ids for each changed source file, from the worktree. */
export function blastBundle(worktree, files, pack = createGraphPack()) {
  const paths = files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path) && !STORY.test(entry.path)).map((entry) => entry.path);
  const result = pack.pack({ worktree, paths: paths.slice(0, MAX_BLAST_FILES), terms: [] });
  return {
    source: result.source,
    files: result.paths.map(({ path: file, owner, importers, tests, stories, featureMap }) => ({ path: file, owner, importers, tests, stories, featureMap })),
    truncated: Math.max(0, paths.length - MAX_BLAST_FILES),
    graphCallsStillOwed: result.graphCallsStillOwed,
  };
}

/** The whole bundle, or `{ unavailable }` when reading it failed: the inventory never fails because of it. */
export function buildInventoryBundle({ worktree, diffText, backendFiles, record, readHead, pack, lookup }) {
  try {
    const files = parseUnifiedDiff(diffText);
    return {
      backendPaths: backendGroups(backendFiles),
      guards: guardPredicates(files, readHead),
      flagKeys: flagKeys(files, record, readHead, lookup ?? flagModuleLookup(worktree)),
      storybookLinks: storybookLinks(files, record, readHead),
      blastBundle: blastBundle(worktree, files, pack),
    };
  } catch (error) {
    return { unavailable: String(error?.message ?? error).split("\n")[0] };
  }
}
