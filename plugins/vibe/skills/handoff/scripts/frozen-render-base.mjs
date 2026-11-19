// What frozen-render.mjs reads from the base tree: its files through one `git cat-file --batch` per request, and
// the render-relevant text of a render manifest (a package manifest without its version and dependency specifiers,
// a pnpm lockfile as what the render manifests' importers resolve). frozen-render-cache.mjs hashes this file with the
// renderer's own source, so a change here invalidates cached base renders as a change in frozen-render.mjs does.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { importerResolution } from "./lockfile-manifest.mjs";

const SELECTION_MAX_BUFFER = 512 * 1024 * 1024;
export const PNPM_LOCKFILE = /(?:^|\/)pnpm-lock\.yaml$/;
const PACKAGE_MANIFEST = /(?:^|\/)package\.json$/;
const MANIFEST_DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);
const DOCUMENT_SEPARATOR = /^---\s*$/m;

/**
 * What a render manifest contributes to a render, as comparable text: a package manifest without its version and
 * dependency specifiers, a pnpm lockfile as what the render manifests' importers resolve. Null when unreadable.
 */
export function renderRelevantManifest(file, text, manifests) {
  if (text === null) return null;
  try {
    if (PNPM_LOCKFILE.test(file)) {
      const roots = storybookImporters(file, manifests);
      return text.split(DOCUMENT_SEPARATOR).filter((part) => part.trim()).map((part) => importerResolution(part, roots)).join("\n---\n");
    }
    return JSON.stringify(renderRelevantPackageFields(text));
  } catch {
    return null;
  }
}

/** A package manifest's fields without its version and dependency specifiers. Throws on text that is not an object. */
export function renderRelevantPackageFields(text) {
  const value = JSON.parse(text);
  for (const field of ["version", ...MANIFEST_DEPENDENCY_FIELDS]) delete value[field];
  return value;
}

/** The lockfile-relative importers of the render manifests' package manifests. */
export function storybookImporters(lockfile, manifests) {
  const lockDir = path.posix.dirname(lockfile);
  return manifests.filter((manifest) => PACKAGE_MANIFEST.test(manifest)).map((manifest) => path.posix.relative(lockDir, path.posix.dirname(manifest)) || ".");
}

/** Reads `base` in `repo` through one `git cat-file --batch` per request: its file list, many files at once, or one. */
export function gitBaseReader(repo, base) {
  const run = (args, input) => execFileSync("git", ["-C", repo, ...args], { encoding: input === undefined ? "utf8" : undefined, input,
    maxBuffer: SELECTION_MAX_BUFFER, stdio: ["pipe", "pipe", "pipe"] });
  const list = (args) => run(args).split("\0").filter(Boolean);
  const baseFiles = new Set(list(["ls-tree", "-r", "-z", "--name-only", base]));
  const blobs = new Map();
  const baseBlobs = (files) => {
    const missing = [...new Set(files)].filter((file) => !blobs.has(file));
    const wanted = missing.filter((file) => baseFiles.has(file));
    if (wanted.length) {
      const output = run(["cat-file", "--batch"], `${wanted.map((file) => `${base}:${file}`).join("\n")}\n`);
      let offset = 0;
      for (const file of wanted) {
        const end = output.indexOf(10, offset);
        const header = output.subarray(offset, end).toString();
        offset = end + 1;
        if (header.endsWith("missing")) continue;
        const size = Number(header.split(" ")[2]);
        blobs.set(file, output.subarray(offset, offset + size).toString("utf8"));
        offset += size + 1;
      }
    }
    for (const file of missing) if (!blobs.has(file)) blobs.set(file, null);
    return new Map(files.map((file) => [file, blobs.get(file)]));
  };
  return { run, list, baseFiles, baseBlobs, baseText: (file) => baseBlobs([file]).get(file) };
}
