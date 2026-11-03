import { relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "zod";
import { MainSyncError, canonicalRelativeSchema, packageOwnerSchema, type PackageOwner, type producerInputSchema } from "./main-sync-contracts.js";
import { digest } from "./main-sync-state.js";

type Tuple = z.infer<typeof producerInputSchema>;
const namesSchema = z.array(canonicalRelativeSchema).min(1).max(10000);
const MAX_DECODED_NAMES = 2 * 1024 * 1024;

/** Complete structured byte/mode/set digest; canonical paths and tuple key order are explicit. */
export function packageTupleIdentity(inputs: readonly Tuple[]) {
  const ordered = [...inputs].sort((left, right) => comparePath(left.path, right.path));
  if (new Set(ordered.map((file) => file.path)).size !== ordered.length) throw new MainSyncError("Duplicate selected-package tuple path", "NEEDS_CHANGE");
  return digest(JSON.stringify(ordered.map((file) => [file.path, file.bytes, file.sha256, file.mode])));
}

/** Encodes only public relative names, not package bodies; deduplication stays in the existing receipt. */
export function packPackageOwner(root: string, owner: { directory: string; version: string }, name: string,
  inputs: readonly Tuple[]): PackageOwner {
  const path = canonicalRelativeSchema.parse(relative(root, owner.directory));
  const names = namesSchema.parse(inputs.map((file) => relative(owner.directory, resolve(root, file.path))).sort(comparePath));
  if (new Set(names).size !== names.length) throw new MainSyncError("Duplicate selected-package filename", "NEEDS_CHANGE");
  const raw = Buffer.from(JSON.stringify(names));
  if (raw.length > MAX_DECODED_NAMES) throw new MainSyncError("Selected-package names exceed the finite decoded bound", "NEEDS_CHANGE");
  return packageOwnerSchema.parse({ path, name, version: owner.version, files: names.length,
    names: gzipSync(raw).toString("base64"), sha256: packageTupleIdentity(inputs) });
}

/** Actual checks alone decode bounded names; the prelaunch witness reader never inflates package data. */
export function packageOwnerPaths(root: string, owner: PackageOwner) {
  let names: string[];
  try {
    const data = Buffer.from(owner.names, "base64");
    if (data.toString("base64") !== owner.names) throw new Error("Noncanonical base64");
    const raw = gunzipSync(data, { maxOutputLength: MAX_DECODED_NAMES });
    names = namesSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch { throw new MainSyncError("Selected-package name data is malformed or exceeds its finite bound", "NEEDS_CHANGE"); }
  if (names.length !== owner.files || names.some((name, index) => index > 0 && comparePath(names[index - 1]!, name) >= 0)) {
    throw new MainSyncError("Selected-package names are duplicated, unsorted or incomplete", "NEEDS_CHANGE");
  }
  const directory = resolve(root, owner.path);
  return new Set(names.map((name) => {
    const path = resolve(directory, name);
    if (!path.startsWith(`${directory}${sep}`)) throw new MainSyncError("Selected-package name escapes its canonical owner", "NEEDS_CHANGE");
    return relative(root, path);
  }));
}

function comparePath(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
