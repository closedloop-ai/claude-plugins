import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";

const WORKSPACE_MANIFEST = /^(?:apps|packages|containers)\/[^/]+\/package\.json$/;
const manifestSchema = z.object({ name: z.string().optional() }).passthrough();
type CommittedTree = { root: string; files: readonly string[]; tracked: ReadonlySet<string>; workspaces?: ReadonlyMap<string, readonly string[]> };
let active: CommittedTree | undefined;

/** One report assessment reads HEAD's file list and workspace names once; its callers recheck HEAD and tree after it. */
export function withCommittedTree<T>(root: string, assess: () => T): T {
  if (active?.root === root) return assess();
  const view = load(root);
  const previous = active;
  active = view;
  try { return assess(); }
  finally { active = previous; }
}

/** Every committed path at HEAD, read once per assessment. */
export function committedFiles(root: string): readonly string[] {
  return tree(root).files;
}

/** Committed membership comes from the same list, not one git spawn per file. */
export function committedSet(root: string): ReadonlySet<string> {
  return tree(root).tracked;
}

/** Inside an assessment this is a set lookup; outside one it stays a single-path read. */
export function isCommittedFile(root: string, file: string) {
  return active?.root === root ? active.tracked.has(file) : Boolean(git(root, ["ls-tree", "HEAD", "--", file]));
}

/** Exact package filters and Turbo task packages reuse committed manifest identity, not guessed selectors. */
export function committedWorkspace(root: string, name: string) {
  const view = tree(root);
  view.workspaces ??= workspaceNames(root, view.files);
  const matches = view.workspaces.get(name) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function tree(root: string): CommittedTree {
  return active?.root === root ? active : load(root);
}

function load(root: string): CommittedTree {
  const files = git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"]).split("\0").filter(Boolean);
  return { root, files, tracked: new Set(files) };
}

function workspaceNames(root: string, files: readonly string[]) {
  const names = new Map<string, string[]>();
  for (const file of files) {
    if (!WORKSPACE_MANIFEST.test(file)) continue;
    const name = manifestSchema.parse(JSON.parse(readFileSync(join(root, file), "utf8"))).name;
    if (name === undefined) continue;
    names.set(name, [...(names.get(name) ?? []), dirname(file)]);
  }
  return names;
}
