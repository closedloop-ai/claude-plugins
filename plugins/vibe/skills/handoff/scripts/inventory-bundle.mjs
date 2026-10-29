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
import { isTestFile } from "../../vibe/scripts/test-files.mjs";
import { parseUnifiedDiff, storyId } from "./diff-rules.mjs";
import { storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const STORY = /\.stories\.[jt]sx?$/;
const MAX_ITEMS = 50;
const MAX_BLAST_FILES = 40;
const FLAG_READ = /\b(?:useFeatureFlag(?:Enabled)?|isFlagEnabled|getFeatureFlag|checkFeatureFlag)\s*\(\s*["'`]([^"'`]+)["'`]|<FeatureFlagged\b[^>]*\b(?:flag|flagKey|name)=["'{`]+([^"'`}]+)/g;
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

/** Added lines in changed source files that read a guard (auth, role, org match) or a feature flag. */
export function guardPredicates(files) {
  const found = [];
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path))) {
    for (const { line, text } of file.added) {
      if (GUARD.test(text) || FLAG_NAME.test(text)) found.push({ file: file.path, line, text: text.trim().slice(0, 200) });
    }
  }
  return { predicates: found.slice(0, MAX_ITEMS), total: found.length };
}

/** Flag keys read in the added lines, and the keys the session record proposed with the person's recorded answer. */
export function flagKeys(files, record) {
  const read = new Map();
  for (const file of files.filter((entry) => entry.status !== "D" && SOURCE.test(entry.path) && !isTestFile(entry.path))) {
    for (const { line, text } of file.added) {
      for (const match of text.matchAll(FLAG_READ)) {
        const key = match[1] ?? match[2];
        if (key && !read.has(`${file.path}:${key}`)) read.set(`${file.path}:${key}`, { key, file: file.path, line });
      }
    }
  }
  return { readInDiff: [...read.values()].slice(0, MAX_ITEMS), recorded: record?.flagKeys ?? null };
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
export function buildInventoryBundle({ worktree, diffText, backendFiles, record, readHead, pack }) {
  try {
    const files = parseUnifiedDiff(diffText);
    return {
      backendPaths: backendGroups(backendFiles),
      guards: guardPredicates(files),
      flagKeys: flagKeys(files, record),
      storybookLinks: storybookLinks(files, record, readHead),
      blastBundle: blastBundle(worktree, files, pack),
    };
  } catch (error) {
    return { unavailable: String(error?.message ?? error).split("\n")[0] };
  }
}
