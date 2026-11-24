import { readGitInventory } from "../../../plugins/vibe/lib/vibe/scripts/git-inventory.mjs";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isPlanFile, planPrefixesOf } from "./main-sync-plan-folder.js";
import { MainSyncError } from "./main-sync-contracts.js";
import { MAX_INPUT_BYTES } from "./main-sync-generated-input.js";
import { committedInputReferences, explicitPlanningReference, referenceMatches } from "./main-sync-input-references.js";

let analyzed: { root: string; head: string; candidates: string; privatePaths: boolean } | undefined;

/** Checks owned archive paths and finite static import/collector references, not arbitrary runtime reachability. */
export function verifyPrivateInput(root: string, file: string, head: string) {
  verifyEvidencePath(root, file);
  const privatePaths = readGitInventory(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((path) => isPlanFile(root, path));
  const candidates = privatePaths.join("\0");
  if (analyzed?.root !== root || analyzed.head !== head || analyzed.candidates !== candidates) {
    analyzed = { root, head, candidates, privatePaths: referencesPrivateInputs(root, privatePaths) };
  }
  if (analyzed.privatePaths) {
    throw new MainSyncError("Private planning evidence is consumed by a committed import, reader or collector; preserve it and correct the same-writer input boundary", "NEEDS_CHANGE");
  }
}

/** Git can omit a symlinked private directory's descendants, so inspect the namespace itself first. */
export function verifyPrivateRoot(root: string) {
  // Every known plan folder and its artifact root, bound or not.
  const paths = planPrefixesOf(root).flatMap((prefix) => [prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/")), prefix.slice(0, -1)])
    .filter(Boolean);
  const invalid = new Map<string, string>();
  for (const path of [...new Set(paths)].sort()) {
    if ([...invalid.keys()].some(parent => path.startsWith(parent + "/"))) continue;
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(join(root, path)) !== join(root, path))) {
      invalid.set(path, "Private planning evidence requires its canonical owned directory; no symlink or alias is accepted");
    }
  }
  return invalid;
}

/** Return the nearest non-directory ancestor without traversing a symlink or non-directory. */
export function invalidReportParent(root: string, file: string): string | undefined {
  const parts = file.split("/");
  let parent = "";
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(join(root, parent), { throwIfNoEntry: false });
    if (!stat) break;
    if (!stat.isDirectory()) return parent;
  }
  return undefined;
}

/** Checks only owned evidence metadata; neither private diagnostics nor report/auth bodies are opened. */
export function verifyEvidencePath(root: string, file: string, label = "Private planning evidence") {
  const target = join(root, file);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES || realpathSync(target) !== target) {
    throw new MainSyncError(`${label} requires a bounded canonical regular file`, "NEEDS_CHANGE");
  }
  for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
    if (!parent.startsWith(`${root}${sep}`) || lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) {
      throw new MainSyncError(`${label} cannot use a symlinked or escaping parent`, "NEEDS_CHANGE");
    }
  }
}

function referencesPrivateInputs(root: string, privatePaths: string[]) {
  return committedInputReferences(root, (file, reference) => {
    if (explicitPlanningReference(root, file, reference) || referenceMatches(root, file, reference, privatePaths)) return true;
    if (reference.kind !== "path") return false;
    const path = resolve(reference.base === "module" ? dirname(join(root, file)) : root, reference.value);
    return existsSync(path) && isPlanFile(root, relative(root, realpathSync(path)));
  });
}
