import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { MainSyncError, originFileSchema } from "./main-sync-contracts.js";
import { digest } from "./main-sync-state.js";
import { producerPackage, type InputProducer } from "./main-sync-input-catalog.js";
import { type OriginFile } from "./main-sync-input-files.js";

const PURE_OWNER_PROBE = String.raw`
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const input=JSON.parse(readFileSync(0,'utf8'));
const root=process.cwd();
const load=path=>import(pathToFileURL(join(root,path)).href);
const read=path=>{
 const full=join(root,path),stat=lstatSync(full);
 if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(full)!==full||stat.size>128*1024*1024) throw new Error('Noncanonical pure input');
 return readFileSync(full);
};
let body;
if(input.id==='desktop-build') {
 const owner=await load('apps/desktop/scripts/write-build-info-lib.mjs');
 body=owner.renderBuildInfoSource({commitHash:input.head,appVersion:owner.resolveAppVersion(JSON.parse(read('apps/desktop/package.json').toString('utf8')))});
} else if(input.id==='desktop-migrations') {
 const owner=await load('apps/desktop/scripts/generate-migrations-manifest-lib.mjs');
 const appDir=join(root,'apps/desktop'),migrationsDir=join(appDir,'prisma/migrations');
 body=owner.renderManifest(owner.buildMigrationEntries(owner.readMigrationDirNames(migrationsDir),{appDir,migrationsDir}));
} else if(input.id==='desktop-auth') {
 const owner=await load('apps/desktop/scripts/generate-auth-handoff-assets-lib.mjs');
 const base='packages/design-system';
 body=owner.renderAuthHandoffAssetsModule(owner.buildAuthHandoffAssets(path=>{
  const full=realpathSync(join(root,base,path));
  if(!full.startsWith(root+'/')) throw new Error('Asset outside owned installed checkout');
  return readFileSync(full);
 }));
} else throw new Error('Unsupported pure owner');
if(typeof body!=='string'||Buffer.byteLength(body)>128*1024*1024) throw new Error('Invalid complete pure body');
process.stdout.write(JSON.stringify({path:input.output,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex'),mode:'100644'}));
`;
const pureResultSchema = z.array(originFileSchema).length(1);

/** Invokes existing import-safe renderers without writing wrappers, legacy healing or output normalization. */
export function pureOriginFiles(root: string, producer: InputProducer, head: string): OriginFile[] {
  if (producer.id === "husky") return huskyBody(root, producer);
  const result = spawnSync("pnpm", ["exec", "node", "--import", "tsx/esm", "--input-type=module", "--eval", PURE_OWNER_PROBE], {
    cwd: root, encoding: "utf8", input: JSON.stringify({ id: producer.id, head, output: producer.roots[0] }),
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new MainSyncError(`Existing pure input owner failed: ${producer.id}`, "NEEDS_CHANGE");
  return pureResultSchema.parse([JSON.parse(result.stdout)]);
}

function huskyBody(root: string, producer: InputProducer): OriginFile[] {
  const owner = producerPackage(root, producer);
  if (!owner) throw new MainSyncError("Locked Husky owner is unavailable", "NEEDS_CHANGE");
  const file = join(owner.directory, "index.js");
  const source = ts.createSourceFile(relative(root, file), readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const candidates: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "msg"
      && node.initializer && ts.isStringLiteralLike(node.initializer)) candidates.push(node.initializer.text);
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  if (candidates.length !== 1) throw new MainSyncError("Locked Husky support literal has no recognized read-only interface", "NEEDS_CHANGE");
  const body = candidates[0]!;
  return pureResultSchema.parse([{ path: producer.roots[0], bytes: Buffer.byteLength(body), sha256: digest(body), mode: "100644" }]);
}
