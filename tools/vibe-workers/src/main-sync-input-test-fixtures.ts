import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { syncFixture } from "./main-sync-test-fixtures.js";
import { z } from "zod";

/** A committed synthetic producer exercises the real CLI/lifecycle, not real Prisma behavior. */
export function prismaInputFixture(value: ReturnType<typeof syncFixture>) {
  const output = "packages/database/generated/client.ts";
  const body = "export const canonicalGeneratedValue = 1;\n";
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\npackages/database/generated/\n`);
  value.write("packages/database/package.json", JSON.stringify({ name: "@repo/database",
    scripts: { "db:generate": "prisma generate --no-hints --schema=./prisma/schema.prisma" }, devDependencies: { prisma: "7.10.0" } }));
  value.write("packages/database/prisma/schema.prisma", 'generator client {\n provider = "prisma-client"\n output = "../generated"\n}\n');
  value.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  packages/database:\n    devDependencies:\n      prisma:\n        specifier: 7.10.0\n        version: 7.10.0\n");
  value.write("scripts/fixture-generated.cjs", `const fs=require('node:fs'); const path=require('node:path');
fs.mkdirSync(path.dirname(${JSON.stringify(output)}),{recursive:true});
fs.writeFileSync(${JSON.stringify(output)},${JSON.stringify(body)});
`);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\npnpm --dir packages/database run db:generate\n");
  value.git(["add", "."]);
  value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic committed generator and bootstrap"]);
  const original = readFileSync(join(value.bin, "pnpm"), "utf8");
  value.write("node_modules/prisma/package.json", JSON.stringify({ name: "prisma", version: "7.10.0", main: "index.js" }));
  value.write("node_modules/prisma/index.js", "module.exports = {};\n");
  const dispatch = String.raw`
if (args[0] === '--dir' && args[1] === 'packages/database' && args[2] === 'run' && args[3] === 'db:generate') {
  fs.mkdirSync(path.join(process.cwd(),'node_modules/prisma'),{recursive:true});
  fs.writeFileSync(path.join(process.cwd(),'node_modules/prisma/package.json'),JSON.stringify({name:'prisma',version:'7.10.0',main:'index.js'}));
  fs.writeFileSync(path.join(process.cwd(),'node_modules/prisma/index.js'),'module.exports = {};\n');
  const cp=require('node:child_process');
  const run=cp.spawnSync(process.execPath,['scripts/fixture-generated.cjs'],{cwd:process.cwd(),encoding:'utf8'});
  process.stdout.write(run.stdout||''); process.stderr.write(run.stderr||''); process.exit(run.status??1);
}

`;
  value.write("../bin/pnpm", original.replace("if (args[0] === 'exec' && args[1] === 'node') {", `${dispatch}\nif (args[0] === 'exec' && args[1] === 'node') {`)
    .replace("path.join(process.cwd(), '.git', 'validation-calls.jsonl')",
      "path.join(require('node:child_process').execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'validation-calls.jsonl')"));
  value.write(output, body);
  return { output, body };
}

/** Synthetic Desktop emitter includes the separate fingerprint; that marker is never treated as body origin. */
export function desktopPrismaInputFixture(value: ReturnType<typeof syncFixture>) {
  const output = "apps/desktop/src/main/database/generated/client.ts";
  const fingerprint = "apps/desktop/src/main/database/generated/.prisma-generate-fingerprint";
  const body = "export const canonicalDesktopClient = true;\n";
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\napps/desktop/src/main/database/generated/\n`);
  value.write("apps/desktop/package.json", JSON.stringify({ name: "desktop", devDependencies: { prisma: "7.10.0" } }));
  value.write("apps/desktop/prisma/schema.prisma", 'generator client {provider="prisma-client" output="../src/main/database/generated"}\n');
  value.write("apps/desktop/scripts/generate-prisma-client-lib.mjs", "export const fingerprintOnly = false;\n");
  value.write("scripts/fixture-desktop-prisma.cjs", `const fs=require('node:fs');const path=require('node:path');
fs.mkdirSync('node_modules/prisma',{recursive:true});fs.writeFileSync('node_modules/prisma/package.json',JSON.stringify({name:'prisma',version:'7.10.0'}));
fs.mkdirSync(path.dirname(${JSON.stringify(output)}),{recursive:true});fs.writeFileSync(${JSON.stringify(output)},${JSON.stringify(body)});fs.writeFileSync(${JSON.stringify(fingerprint)},'current input fingerprint');\n`);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-desktop-prisma.cjs\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic Desktop client and separate fingerprint"]);
  const created = spawnSync(process.execPath, ["scripts/fixture-desktop-prisma.cjs"], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
  if (created.error || created.status !== 0) throw new Error("Synthetic Desktop generation failed");
  const original = readFileSync(join(value.bin, "pnpm"), "utf8");
  const dispatch = String.raw`
if(args[0]==='--dir'&&args[1]==='apps/desktop'&&args[2]==='exec'&&args[3]==='prisma'&&args[4]==='generate') {
const run=require('node:child_process').spawnSync(process.execPath,['scripts/fixture-desktop-prisma.cjs'],{cwd:process.cwd(),encoding:'utf8'});process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');process.exit(run.status??1);
}
`;
  value.write("../bin/pnpm", original.replace("if (args[0] === 'exec' && args[1] === 'node') {", `${dispatch}\nif (args[0] === 'exec' && args[1] === 'node') {`)
    .replace("path.join(process.cwd(), '.git', 'validation-calls.jsonl')",
      "path.join(require('node:child_process').execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'validation-calls.jsonl')"));
  return { output, fingerprint, body };
}

/** Synthetic full-write IO contract; the real locked Fumadocs effect was established separately. */
export function fumadocsInputFixture(value: ReturnType<typeof syncFixture>) {
  const paths = ["browser.ts", "dynamic.ts", "server.ts", "source.config.mjs"].map((path) => `apps/web/.source/${path}`);
  const body = "export const canonicalDocs = true;\n";
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\napps/web/.source/\n`);
  value.write("apps/web/package.json", JSON.stringify({ name: "web", dependencies: { "fumadocs-mdx": "14.3.1" } }));
  value.write("apps/web/source.config.ts", "export default {dir: 'content/docs'};\n");
  value.write("apps/web/content/docs/index.mdx", "# Synthetic committed docs\n");
  value.write("scripts/fixture-fumadocs.cjs", `const fs=require('node:fs');const path=require('node:path');
for(const file of ${JSON.stringify(paths)}) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,${JSON.stringify(body)});}
`);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\npnpm --dir apps/web exec fumadocs-mdx\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic canonical full-write owner"]);
  value.write("node_modules/fumadocs-mdx/package.json", JSON.stringify({ name: "fumadocs-mdx", version: "14.3.1", main: "index.js" }));
  value.write("node_modules/fumadocs-mdx/index.js", "module.exports = {};\n");
  const original = readFileSync(join(value.bin, "pnpm"), "utf8");
  const dispatch = String.raw`
if(args[0]==='--dir'&&args[1]==='apps/web'&&args[2]==='exec'&&args[3]==='fumadocs-mdx') {
  fs.mkdirSync(path.join(process.cwd(),'node_modules/fumadocs-mdx'),{recursive:true});
  fs.writeFileSync(path.join(process.cwd(),'node_modules/fumadocs-mdx/package.json'),JSON.stringify({name:'fumadocs-mdx',version:'14.3.1',main:'index.js'}));
  fs.writeFileSync(path.join(process.cwd(),'node_modules/fumadocs-mdx/index.js'),'module.exports = {};\n');
  const run=require('node:child_process').spawnSync(process.execPath,['scripts/fixture-fumadocs.cjs'],{cwd:process.cwd(),encoding:'utf8'});
  process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');process.exit(run.status??1);
}
`;
  value.write("../bin/pnpm", original.replace("if (args[0] === 'exec' && args[1] === 'node') {", `${dispatch}\nif (args[0] === 'exec' && args[1] === 'node') {`)
    .replace("path.join(process.cwd(), '.git', 'validation-calls.jsonl')",
      "path.join(require('node:child_process').execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'validation-calls.jsonl')"));
  for (const path of paths) value.write(path, body);
  return { paths, body };
}

const buildFixtureSchema = z.object({ purpose: z.string(), origin: z.object({ repository: z.literal("closedloop-ai/symphony-alpha"),
  commit: z.literal("3dd896dfcecd5b14940fbebe3a10f969bcb8c93e"), license: z.literal("Apache-2.0"), copyright: z.string() }).strict(),
  files: z.array(z.object({ path: z.enum(["apps/desktop/scripts/write-build-info-lib.mjs", "LICENSE"]),
    gitBlob: z.string(), sha256: z.string(), content: z.string() }).strict()).length(2) }).strict();

/** Executes the unmodified actual Source pure renderer; this opaque data is never a runtime dependency. */
export function buildInfoInputFixture(value: ReturnType<typeof syncFixture>) {
  const data = buildFixtureSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/symphony-build-info-producer.json", import.meta.url), "utf8")));
  for (const file of data.files) {
    const bytes = Buffer.from(file.content);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) throw new Error("Opaque Source pure fixture identity changed");
    value.write(file.path, file.content);
  }
  const output = "apps/desktop/src/shared/build-info.ts";
  value.write("apps/desktop/package.json", JSON.stringify({ name: "desktop", version: "0.0.1" }));
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n${output}\n`);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\ntrue\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Actual opaque pure owner test data"]);
  const derive = () => {
    const run = spawnSync(process.execPath, ["--input-type=module", "--eval",
      "import {renderBuildInfoSource,resolveAppVersion} from './apps/desktop/scripts/write-build-info-lib.mjs';import {readFileSync} from 'node:fs';process.stdout.write(renderBuildInfoSource({commitHash:process.argv[1],appVersion:resolveAppVersion(JSON.parse(readFileSync('apps/desktop/package.json','utf8')))}));",
      value.git(["rev-parse", "HEAD"])], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
    if (run.error || run.status !== 0) throw new Error(run.stderr || "Actual pure renderer failed");
    return run.stdout;
  };
  const body = derive(); value.write(output, body);
  return { output, body, derive };
}

/** Real-sized IO adapter for receipt bounds; it is not a reproduction of Next's implementation. */
export function largeProducerInputFixture(value: ReturnType<typeof syncFixture>, count = 8533) {
  const generated = prismaInputFixture(value);
  const create = String.raw`const fs=require('node:fs');const path=require('node:path');
const root='node_modules/prisma';fs.mkdirSync(path.join(root,'dist','compiled','immutable-owner'),{recursive:true});
for(let index=0;index<Number(process.argv[2])-2;index++) fs.writeFileSync(path.join(root,'dist','compiled','immutable-owner','owned-module-'+String(index).padStart(5,'0')+'.js'),'module.exports = '+index+';\n');
`;
  value.write("scripts/fixture-large-owner.cjs", create);
  value.write(".closedloop-ai/loops-setup.sh", `#!/bin/sh\nset -eu\nnode scripts/fixture-large-owner.cjs ${count}\npnpm --dir packages/database run db:generate\n`);
  value.git(["add", "scripts/fixture-large-owner.cjs"]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic real-sized selected package owner"]);
  const run = spawnSync(process.execPath, ["scripts/fixture-large-owner.cjs", String(count)], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
  if (run.error || run.status !== 0) throw new Error(run.stderr || "Synthetic package creation failed");
  return generated;
}

/** Synthetic finite Next IO contract proves shared-package refs, not framework/config safety. */
export function nextInputFixture(value: ReturnType<typeof syncFixture>) {
  const files: string[] = [];
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\napps/api/next-env.d.ts\napps/app/next-env.d.ts\napps/api/.next/\napps/app/.next/\n`);
  for (const app of ["api", "app"]) {
    value.write(`apps/${app}/package.json`, JSON.stringify({ name: app, dependencies: { next: "16.3.6" } }));
    value.write(`apps/${app}/next.config.ts`, "export default {};\n");
    value.write(`apps/${app}/tsconfig.json`, "{\"include\":[\"next-env.d.ts\",\".next/types/**/*.ts\"]}\n");
    value.write(`apps/${app}/app/page.tsx`, "export default function Page(){return null;}\n");
    files.push(`apps/${app}/next-env.d.ts`, ...["routes.d.ts", "validator.ts", "cache-life.d.ts", "root-params.d.ts"].map((file) => `apps/${app}/.next/types/${file}`));
  }
  const owner = String.raw`const fs=require('node:fs');const path=require('node:path');const app=process.argv[2];
if(app==='setup') {fs.mkdirSync('node_modules/next',{recursive:true});fs.writeFileSync('node_modules/next/package.json',JSON.stringify({name:'next',version:'16.3.6',main:'index.js'}));fs.writeFileSync('node_modules/next/index.js','module.exports = {};\n');}
else {const root=path.join('apps',app);fs.mkdirSync(path.join(root,'.next/types'),{recursive:true});fs.writeFileSync(path.join(root,'next-env.d.ts'),'export {};\n');for(const file of ['routes.d.ts','validator.ts','cache-life.d.ts','root-params.d.ts'])fs.writeFileSync(path.join(root,'.next/types',file),'export {};\n');}
`;
  value.write("scripts/fixture-next.cjs", owner);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-next.cjs setup\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic Next finite emitter and shared installed owner"]);
  for (const app of ["setup", "api", "app"]) {
    const run = spawnSync(process.execPath, ["scripts/fixture-next.cjs", app], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
    if (run.error || run.status !== 0) throw new Error(run.stderr || "Synthetic Next creation failed");
  }
  const original = readFileSync(join(value.bin, "pnpm"), "utf8");
  const dispatch = String.raw`
if(args[0]==='--dir'&&['apps/api','apps/app'].includes(args[1])&&args[2]==='exec'&&args[3]==='next'&&args[4]==='typegen') {
const run=require('node:child_process').spawnSync(process.execPath,['scripts/fixture-next.cjs',args[1].split('/')[1]],{cwd:process.cwd(),encoding:'utf8'});process.stdout.write(run.stdout||'');process.stderr.write(run.stderr||'');process.exit(run.status??1);
}
`;
  value.write("../bin/pnpm", original.replace("if (args[0] === 'exec' && args[1] === 'node') {", `${dispatch}\nif (args[0] === 'exec' && args[1] === 'node') {`)
    .replace("path.join(process.cwd(), '.git', 'validation-calls.jsonl')",
      "path.join(require('node:child_process').execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'validation-calls.jsonl')"));
  return { files };
}

const pureFixturesSchema = buildFixtureSchema.extend({ files: z.array(z.object({ path: z.enum([
  "apps/desktop/scripts/generate-migrations-manifest-lib.mjs", "apps/desktop/scripts/migration-order.mjs",
  "apps/desktop/scripts/generate-auth-handoff-assets-lib.mjs", "LICENSE"]), gitBlob: z.string(), sha256: z.string(), content: z.string() }).strict()).length(4) });

/** Actual Source pure APIs with synthetic SQL/theme/font inputs; no database or installer is started. */
export function pureInputFixture(value: ReturnType<typeof syncFixture>, kind: "migrations" | "auth") {
  const data = pureFixturesSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/symphony-pure-input-producers.json", import.meta.url), "utf8")));
  for (const file of data.files) {
    const bytes = Buffer.from(file.content);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) throw new Error("Opaque pure producer identity changed");
    value.write(file.path, file.content);
  }
  const output = kind === "migrations" ? "apps/desktop/src/main/database/migration/migrations-manifest.ts"
    : "apps/desktop/src/shared/auth-handoff-assets.generated.ts";
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n${output}\n`);
  value.write("apps/desktop/package.json", JSON.stringify({ name: "desktop", version: "0.0.1" }));
  let derive: string;
  if (kind === "migrations") {
    value.write("apps/desktop/prisma/migrations/20261010000001_initial/migration.sql", "SELECT 1;\n");
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\ntrue\n");
    derive = "import{readMigrationDirNames,buildMigrationEntries,renderManifest}from'./apps/desktop/scripts/generate-migrations-manifest-lib.mjs';import{join}from'node:path';const appDir=join(process.cwd(),'apps/desktop'),migrationsDir=join(appDir,'prisma/migrations');process.stdout.write(renderManifest(buildMigrationEntries(readMigrationDirNames(migrationsDir),{appDir,migrationsDir})));";
  } else {
    value.write("packages/design-system/package.json", JSON.stringify({ name: "@repo/design-system", dependencies: { geist: "1.7.2" } }));
    value.write("packages/design-system/styles/globals.css", ":root {\n color: red;\n}\n.dark {\n color: blue;\n}\n");
    for (const theme of ["light", "dark"]) value.write(`packages/design-system/brand/logos/Horizontal/closedloop-logo-horizontal-on-${theme}.svg`, "<svg/>\n");
    value.write("scripts/fixture-font.cjs", "const fs=require('node:fs');fs.mkdirSync('node_modules/geist/dist/fonts/geist-sans',{recursive:true});fs.writeFileSync('node_modules/geist/package.json',JSON.stringify({name:'geist',version:'1.7.2'}));fs.writeFileSync('node_modules/geist/dist/fonts/geist-sans/Geist-Regular.woff2','synthetic font bytes');\n");
    value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-font.cjs\n");
    const font = spawnSync(process.execPath, ["scripts/fixture-font.cjs"], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
    if (font.error || font.status !== 0) throw new Error("Synthetic font setup failed");
    derive = "import{buildAuthHandoffAssets,renderAuthHandoffAssetsModule}from'./apps/desktop/scripts/generate-auth-handoff-assets-lib.mjs';import{readFileSync}from'node:fs';import{join}from'node:path';process.stdout.write(renderAuthHandoffAssetsModule(buildAuthHandoffAssets(path=>readFileSync(join('packages/design-system',path)))));";
    // The synthetic workspace resolves the same installed package through its normal link.
    value.write("packages/design-system/node_modules/geist/package.json", JSON.stringify({ name: "geist", version: "1.7.2" }));
    value.write("packages/design-system/node_modules/geist/dist/fonts/geist-sans/Geist-Regular.woff2", "synthetic font bytes");
    const original = readFileSync(join(value.bin, "pnpm"), "utf8");
    value.write("../bin/pnpm", original.replace("path.join(process.cwd(), '.git', 'validation-calls.jsonl')",
      "path.join(require('node:child_process').execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:process.cwd(),encoding:'utf8'}).trim(),'validation-calls.jsonl')"));
    value.write("scripts/fixture-font.cjs", `${readFileSync(join(value.worktree, "scripts/fixture-font.cjs"), "utf8")}fs.mkdirSync('packages/design-system/node_modules/geist/dist/fonts/geist-sans',{recursive:true});fs.writeFileSync('packages/design-system/node_modules/geist/package.json',JSON.stringify({name:'geist',version:'1.7.2'}));fs.writeFileSync('packages/design-system/node_modules/geist/dist/fonts/geist-sans/Geist-Regular.woff2','synthetic font bytes');\n`);
  }
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Actual opaque pure owners with synthetic immutable inputs"]);
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", derive], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || "Actual pure owner failed");
  value.write(output, result.stdout);
  return { output, body: result.stdout };
}

/** Executes the unmodified docs CLI from committed content, without requiring web .source. */
export function docsInputFixture(value: ReturnType<typeof syncFixture>) {
  const schema = buildFixtureSchema.extend({ files: z.array(z.object({ path: z.enum([
    "apps/desktop/scripts/generate-docs-bundle-manifest.mjs", "apps/desktop/scripts/generate-docs-bundle-manifest-lib.mjs", "LICENSE"]),
    gitBlob: z.string(), sha256: z.string(), content: z.string() }).strict()).length(3) });
  const data = schema.parse(JSON.parse(readFileSync(new URL("./fixtures/symphony-docs-input-producer.json", import.meta.url), "utf8")));
  for (const file of data.files) {
    const bytes = Buffer.from(file.content);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== file.gitBlob) throw new Error("Opaque docs identity changed");
    value.write(file.path, file.content);
  }
  const output = "apps/desktop/src/main/docs-help/docs-bundle-manifest.ts";
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n${output}\n`);
  value.write("apps/desktop/src/main/docs-help/reader.ts", "export {};\n");
  value.write("apps/web/content/docs/index.mdx", "---\ntitle: Synthetic docs\n---\n# Fixture heading\n\nFixture body.\n");
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\ntrue\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Actual opaque docs producer with committed content"]);
  const run = spawnSync(process.execPath, ["apps/desktop/scripts/generate-docs-bundle-manifest.mjs"], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
  if (run.error || run.status !== 0) throw new Error(run.stderr || "Actual docs producer failed");
  return { output, body: readFileSync(join(value.worktree, output), "utf8") };
}

/** A synthetic locked literal throws if imported, proving AST-only support verification rather than installer execution. */
export function huskyInputFixture(value: ReturnType<typeof syncFixture>) {
  const output = ".husky/_/husky.sh";
  const body = "echo 'synthetic deprecated support'\n";
  const module = `throw new Error('installer module must never execute');\nconst msg=${JSON.stringify(body)};\nexport default()=>{};\n`;
  const setup = `const fs=require('node:fs');fs.mkdirSync('node_modules/husky',{recursive:true});fs.writeFileSync('node_modules/husky/package.json',JSON.stringify({name:'husky',version:'9.1.7',type:'module'}));fs.writeFileSync('node_modules/husky/index.js',${JSON.stringify(module)});\n`;
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}\n.husky/_/\n`);
  value.write("scripts/fixture-husky.cjs", setup);
  value.write(".closedloop-ai/loops-setup.sh", "#!/bin/sh\nset -eu\nnode scripts/fixture-husky.cjs\n");
  value.git(["add", "."]); value.git(["add", "-f", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Synthetic locked support literal"]);
  const run = spawnSync(process.execPath, ["scripts/fixture-husky.cjs"], { cwd: value.worktree, encoding: "utf8", timeout: 10000 });
  if (run.error || run.status !== 0) throw new Error("Synthetic support setup failed");
  value.write(output, body);
  return { output, body };
}
