import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { parse } from "yaml";
import { MainSyncError, producerInputSchema } from "./main-sync-contracts.js";
import { originTree } from "./main-sync-input-files.js";
import { git } from "../../../plugins/vibe-core/lib/vibe/scripts/session-record.mjs";
import { digest } from "./main-sync-state.js";
import { readProducerMetadata, verifyProducerHead } from "./main-sync-producer-read.js";
import { mainSyncRecipe } from "./main-sync-recipe.js";

export type InputProducer = { id: string; roots: string[]; inputs: string[]; argv?: string[];
  package?: { dir: string; name: string }; strategy: "pristine" | "full-write" | "pure"; refreshable?: boolean };
const WORKSPACE = "pnpm-workspace.yaml";

/** The repository's generated inputs and their canonical producers: its main-sync recipe's, none without one. */
export function inputProducers(root: string): readonly InputProducer[] {
  return mainSyncRecipe(root).producers;
}

const packageSchema = z.object({ name: z.string(), version: z.string() }).passthrough();
const manifestSchema = z.object({ dependencies: z.record(z.string()).optional(), devDependencies: z.record(z.string()).optional(),
  optionalDependencies: z.record(z.string()).optional() }).passthrough();
const workspaceSchema = z.object({ catalog: z.record(z.string()).optional(), catalogs: z.record(z.record(z.string())).optional() }).passthrough();

/** Finite owning paths are discovery, never directory permission without complete canonical evidence. */
export function producerFor(root: string, path: string) {
  return inputProducers(root).find((producer) => producer.roots.some((root) => path === root || path.startsWith(`${root}/`)));
}
export function presentProducers(root: string) {
  return inputProducers(root).filter((producer) => producer.roots.some((path) => lstatSync(join(root, path), { throwIfNoEntry: false })));
}
export function producerFiles(root: string, producer: InputProducer, allowed?: ReadonlySet<string>) {
  return producer.roots.flatMap((path) => originTree(root, path, allowed));
}

/** Uses the normal locked installed-package boundary; no config evaluation or default installer.
 * Locates the package directory by Node's node_modules lookup rather than resolving `<name>/package.json`,
 * which a package whose `exports` map omits that subpath (husky, geist) refuses with ERR_PACKAGE_PATH_NOT_EXPORTED. */
export function producerPackage(root: string, producer: InputProducer) {
  if (!producer.package) return undefined;
  const owner = producer.package;
  const lookup = createRequire(join(root, owner.dir, "package.json")).resolve.paths(owner.name) ?? [];
  const file = lookup.map((directory) => join(directory, owner.name, "package.json")).find((candidate) => existsSync(candidate));
  if (!file) throw new MainSyncError(`Canonical installed producer is not installed: ${producer.id}`, "NEEDS_CHANGE");
  const canonical = realpathSync(file);
  if (!canonical.startsWith(`${root}${sep}`) || !lstatSync(canonical).isFile()) {
    throw new MainSyncError(`Canonical installed producer resolves outside the owned validation checkout: ${producer.id}`, "NEEDS_CHANGE");
  }
  const data = packageSchema.parse(JSON.parse(readFileSync(canonical, "utf8")));
  if (data.name !== owner.name || data.version !== targetPackageVersion(root, owner, data.version)) {
    throw new MainSyncError(`Installed producer contract changed: ${producer.id}`, "NEEDS_CHANGE");
  }
  return { path: relative(root, canonical), directory: dirname(canonical), version: data.version };
}

/** Resolves catalog-backed package versions from the target repository; other declarations use its installed package. */
function targetPackageVersion(root: string, owner: NonNullable<InputProducer["package"]>, installed: string) {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, owner.dir, "package.json"), "utf8")));
  const specifier = manifest.dependencies?.[owner.name] ?? manifest.devDependencies?.[owner.name]
    ?? manifest.optionalDependencies?.[owner.name];
  if (!specifier?.startsWith("catalog:")) return installed;
  const file = join(root, WORKSPACE);
  if (!existsSync(file)) throw new MainSyncError(`Catalog-backed producer has no pnpm workspace: ${owner.name}`, "NEEDS_CHANGE");
  const workspace = workspaceSchema.parse(parse(readFileSync(file, "utf8")));
  const catalogName = specifier.slice("catalog:".length);
  const version = (catalogName ? workspace.catalogs?.[catalogName] : workspace.catalog)?.[owner.name];
  if (!version) throw new MainSyncError(`Catalog has no producer version: ${owner.name}`, "NEEDS_CHANGE");
  return version;
}

/** Binds only the selected installed producer package, not the transitive node_modules population.
 * The package's own node_modules/.bin holds pnpm's install-time launcher shims, which embed the absolute
 * checkout path (cmd-shim-target, NODE_PATH) and so can never match a pristine checkout elsewhere; their
 * relative targets are the package content compared here or transitive packages this owner never binds. */
export function producerOwnerInputs(root: string, producer: InputProducer, allowed?: ReadonlySet<string>) {
  const owner = producerPackage(root, producer);
  if (!owner) return [];
  const shims = join(owner.directory, "node_modules", ".bin");
  const result: z.infer<typeof producerInputSchema>[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (path === shims) continue;
      const file = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new MainSyncError(`Selected producer package contains a noncanonical node: ${producer.id}`, "NEEDS_CHANGE");
      if (stat.isDirectory()) {
        if (allowed && !shims.startsWith(`${path}${sep}`) && ![...allowed].some((item) => item.startsWith(`${file}/`))) throw new MainSyncError("Selected producer contains an unknown directory; preserve it without reading contents", "NEEDS_CHANGE");
        walk(path);
      }
      else {
        if (allowed && !allowed.has(file)) throw new MainSyncError("Selected producer contains an unknown file; preserve it without reading its body", "NEEDS_CHANGE");
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024 || result.length >= 10000) throw new MainSyncError("Selected producer package exceeds its finite regular-file contract", "NEEDS_CHANGE");
        result.push(producerInputSchema.parse({ path: file, bytes: stat.size,
          sha256: digest(readFileSync(path)), mode: (stat.mode & 0o111) ? "100755" : "100644" }));
      }
    }
  };
  walk(owner.directory);
  return result;
}

/** Existing committed producer collection roots cannot silently consume an ignored or untracked input. */
export function verifyProducerInputs(root: string, head: string, producers: InputProducer[], untracked?: string[]) {
  verifyProducerInputPaths(root, producers, untracked);
  verifyProducerHead(root, head);
}

/** Internal generated-origin completion; never used by standalone inventory callers. */
export function verifyProducerInputsForOrigin(root: string, head: string, producers: InputProducer[], untracked: string[]) {
  verifyProducerInputPaths(root, producers, untracked);
  return readProducerMetadata(root, head);
}

function verifyProducerInputPaths(root: string, producers: InputProducer[], untracked?: string[]) {
  const all = untracked ?? [...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ...git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0")].filter(Boolean);
  for (const producer of producers) {
    for (const file of all) {
      if (producer.inputs.some((input) => file === input || file.startsWith(`${input}/`))) {
        throw new MainSyncError(`Untracked canonical producer input cannot be consumed: ${file}`, "NEEDS_CHANGE");
      }
    }
    for (const input of producer.inputs) {
      if (!lstatSync(join(root, input), { throwIfNoEntry: false })) continue;
      if (realpathSync(join(root, input)) !== join(root, input)) throw new MainSyncError(`Producer input is not canonical: ${input}`, "NEEDS_CHANGE");
    }
  }
}
