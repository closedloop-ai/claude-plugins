import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isPlanFile, planPrefixesOf } from "./main-sync-plan-folder.js";
import { git } from "../../../plugins/vibe/lib/vibe/scripts/session-record.mjs";
import { MainSyncError } from "./main-sync-contracts.js";
import { MAX_INPUT_BYTES } from "./main-sync-generated-input.js";
import { committedInputReferences, explicitPlanningReference, referenceMatches, type ReferenceScanOptions } from "./main-sync-input-references.js";

let analyzed: { root: string; head: string; candidates: string; privatePaths: boolean } | undefined;

/**
 * Checks owned archive paths and finite static import/collector references, not arbitrary runtime reachability.
 * `bounds` overrides the reference scan's size and time bounds (`committedInputReferences`).
 */
export function verifyPrivateInput(root: string, file: string, head: string, bounds: Omit<ReferenceScanOptions, "unparsed"> = {}) {
  verifyEvidencePath(root, file);
  const privatePaths = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter((path) => isPlanFile(root, path));
  const candidates = privatePaths.join("\0");
  if (analyzed?.root !== root || analyzed.head !== head || analyzed.candidates !== candidates) {
    analyzed = { root, head, candidates, privatePaths: referencesPrivateInputs(root, privatePaths, bounds) };
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
  for (const path of [...new Set(paths)]) {
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(join(root, path)) !== join(root, path))) {
      throw new MainSyncError("Private planning evidence requires its canonical owned directory; no symlink or alias is accepted", "NEEDS_CHANGE");
    }
  }
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

function referencesPrivateInputs(root: string, privatePaths: string[], bounds: Omit<ReferenceScanOptions, "unparsed">) {
  // An unparsed bundle counts as a reader when its text names a private file or the name of a plan folder.
  const folders = planPrefixesOf(root).map((prefix) => prefix.slice(0, -1).split("/").at(-1) ?? "").filter(Boolean);
  return committedInputReferences(root, (file, reference) => {
    if (explicitPlanningReference(root, file, reference) || referenceMatches(root, file, reference, privatePaths)) return true;
    if (reference.kind !== "path") return false;
    const path = resolve(reference.base === "module" ? dirname(join(root, file)) : root, reference.value);
    return existsSync(path) && isPlanFile(root, relative(root, realpathSync(path)));
  }, { ...bounds, unparsed: (_file, text) => [...privatePaths, ...folders].some((name) => text.includes(name)) });
}
