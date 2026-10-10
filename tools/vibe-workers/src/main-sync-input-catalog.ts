import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { MainSyncError, producerInputSchema } from "./main-sync-contracts.js";
import { originTree } from "./main-sync-input-files.js";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { digest } from "./main-sync-state.js";

export type InputProducer = { id: string; roots: string[]; inputs: string[]; argv?: string[];
  package?: { dir: string; name: string; version: string }; strategy: "pristine" | "full-write" | "pure" };
const DESKTOP = "apps/desktop";
export const inputProducers: readonly InputProducer[] = [
  { id: "shared-prisma", roots: ["packages/database/generated"], inputs: ["packages/database/prisma", "packages/database/prisma.config.ts", "packages/database/package.json"],
    argv: ["pnpm", "--dir", "packages/database", "run", "db:generate"], package: { dir: "packages/database", name: "prisma", version: "7.10.0" }, strategy: "pristine" },
  { id: "desktop-prisma", roots: [`${DESKTOP}/src/main/database/generated`], inputs: [`${DESKTOP}/prisma`, `${DESKTOP}/prisma.config.ts`, `${DESKTOP}/package.json`, `${DESKTOP}/scripts/generate-prisma-client-lib.mjs`],
    argv: ["pnpm", "--dir", DESKTOP, "exec", "prisma", "generate"], package: { dir: DESKTOP, name: "prisma", version: "7.10.0" }, strategy: "pristine" },
  ...["api", "app"].map((app): InputProducer => ({ id: `next-${app}`, roots: [`apps/${app}/next-env.d.ts`, `apps/${app}/.next/types`],
    inputs: [`apps/${app}/app`, `apps/${app}/next.config.ts`, `apps/${app}/tsconfig.json`, `apps/${app}/package.json`],
    argv: ["pnpm", "--dir", `apps/${app}`, "exec", "next", "typegen"], package: { dir: `apps/${app}`, name: "next", version: "16.3.6" }, strategy: "pristine" })),
  { id: "fumadocs", roots: ["apps/web/.source"], inputs: ["apps/web/content/docs", "apps/web/source.config.ts", "apps/web/package.json"],
    argv: ["pnpm", "--dir", "apps/web", "exec", "fumadocs-mdx"], package: { dir: "apps/web", name: "fumadocs-mdx", version: "14.3.1" }, strategy: "full-write" },
  { id: "desktop-build", roots: [`${DESKTOP}/src/shared/build-info.ts`], inputs: [`${DESKTOP}/package.json`, `${DESKTOP}/scripts/write-build-info-lib.mjs`], strategy: "pure" },
  { id: "desktop-migrations", roots: [`${DESKTOP}/src/main/database/migration/migrations-manifest.ts`], inputs: [`${DESKTOP}/prisma/migrations`, `${DESKTOP}/scripts/generate-migrations-manifest-lib.mjs`, `${DESKTOP}/scripts/migration-order.mjs`], strategy: "pure" },
  { id: "desktop-docs", roots: [`${DESKTOP}/src/main/docs-help/docs-bundle-manifest.ts`], inputs: ["apps/web/content/docs", `${DESKTOP}/scripts/generate-docs-bundle-manifest.mjs`, `${DESKTOP}/scripts/generate-docs-bundle-manifest-lib.mjs`],
    argv: ["node", `${DESKTOP}/scripts/generate-docs-bundle-manifest.mjs`], strategy: "pristine" },
  { id: "desktop-auth", roots: [`${DESKTOP}/src/shared/auth-handoff-assets.generated.ts`], inputs: ["packages/design-system/styles/globals.css", "packages/design-system/brand/logos/Horizontal", `${DESKTOP}/scripts/generate-auth-handoff-assets-lib.mjs`],
    package: { dir: "packages/design-system", name: "geist", version: "1.7.2" }, strategy: "pure" },
  { id: "husky", roots: [".husky/_/husky.sh"], inputs: ["package.json"], package: { dir: ".", name: "husky", version: "9.1.7" }, strategy: "pure" },
];

export const reportOutputs = new Set([".vitest/blob/blob.json", ".vitest/json/output.json", "playwright-report/index.html",
  "playwright-results.json", "test-results/.last-run.json", `${DESKTOP}/playwright-report-e2e/index.html`,
  `${DESKTOP}/playwright-report-e2e/results.json`, `${DESKTOP}/playwright-report-e2e/dd-quarantine.json`]);
const packageSchema = z.object({ name: z.string(), version: z.string() }).passthrough();

/** Finite owning paths are discovery, never directory permission without complete canonical evidence. */
export function producerFor(path: string) {
  return inputProducers.find((producer) => producer.roots.some((root) => path === root || path.startsWith(`${root}/`)));
}
export function presentProducers(root: string) {
  return inputProducers.filter((producer) => producer.roots.some((path) => lstatSync(join(root, path), { throwIfNoEntry: false })));
}
export function producerFiles(root: string, producer: InputProducer, allowed?: ReadonlySet<string>) {
  return producer.roots.flatMap((path) => originTree(root, path, allowed));
}

/** Uses the normal locked installed-package boundary; no config evaluation or default installer. */
export function producerPackage(root: string, producer: InputProducer) {
  if (!producer.package) return undefined;
  const owner = producer.package;
  const file = createRequire(join(root, owner.dir, "package.json")).resolve(`${owner.name}/package.json`);
  const canonical = realpathSync(file);
  if (!canonical.startsWith(`${root}${sep}`) || !lstatSync(canonical).isFile()) {
    throw new MainSyncError(`Canonical installed producer resolves outside the owned validation checkout: ${producer.id}`, "NEEDS_CHANGE");
  }
  const data = packageSchema.parse(JSON.parse(readFileSync(canonical, "utf8")));
  if (data.name !== owner.name || data.version !== owner.version) throw new MainSyncError(`Installed producer contract changed: ${producer.id}`, "NEEDS_CHANGE");
  return { path: relative(root, canonical), directory: dirname(canonical), version: data.version };
}

/** Binds only the selected installed producer package, not the transitive node_modules population. */
export function producerOwnerInputs(root: string, producer: InputProducer, allowed?: ReadonlySet<string>) {
  const owner = producerPackage(root, producer);
  if (!owner) return [];
  const result: z.infer<typeof producerInputSchema>[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const file = relative(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || realpathSync(path) !== path) throw new MainSyncError(`Selected producer package contains a noncanonical node: ${producer.id}`, "NEEDS_CHANGE");
      if (stat.isDirectory()) {
        if (allowed && ![...allowed].some((item) => item.startsWith(`${file}/`))) throw new MainSyncError("Selected producer contains an unknown directory; preserve it without reading contents", "NEEDS_CHANGE");
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
  // The caller also verifies absolute HEAD/index parity; this probe never grants source exceptions.
  if (git(root, ["rev-parse", "HEAD"]) !== head) throw new MainSyncError("Producer input HEAD changed during inspection", "NEEDS_CHANGE");
}
