import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MainSyncError } from "./main-sync-contracts.js";

export const GENERATED_BIOME_PATH = ".biome-noscan.jsonc";
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const PRODUCER_FILES = [
  { path: "lint-staged.config.js", sha256: "cab246172e6fb362d97a1dc634a5741dbd5027a8ec18f891aebe145c15c990fd" },
  { path: "scripts/exec-git.ts", sha256: "a884fc8d0dc9735933eed6a6d5eaca4b935ddb9957ba873495a38adc973ac17e" },
] as const;
const HASH = /^[a-f0-9]{64}$/;
const probeSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative().max(MAX_INPUT_BYTES),
  sha256: z.string().regex(HASH) }).strict();
const PURE_PROBE = String.raw`
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const input = JSON.parse(readFileSync(0, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = () => {
  for (const file of input.files) {
    const path = join(process.cwd(), file.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > input.maxBytes || (stat.mode & 0o111) || realpathSync(path) !== path
      || hash(readFileSync(path)) !== file.sha256) throw new Error('Canonical committed probe input changed');
  }
};
check();
const owner = await import(pathToFileURL(join(process.cwd(), 'lint-staged.config.js')).href);
const path = join(process.cwd(), '.biome-noscan.jsonc');
if (owner.NO_SCAN_BIOME_CONFIG !== path || typeof owner.noScanBiomeConfig !== 'function') throw new Error('Canonical pure export unavailable');
const output = owner.noScanBiomeConfig(input.config);
if (typeof output !== 'string' || Buffer.byteLength(output) > input.maxBytes) throw new Error('Canonical pure output invalid');
check();
process.stdout.write(JSON.stringify({path,bytes:Buffer.byteLength(output),sha256:hash(Buffer.from(output))}));
`;

/** Recognizes only the exact ignored root derivative; the writing hook and default callbacks never run. */
export function verifyGeneratedBiomeInput(root: string, headSha: string) {
  try {
    const artifact = readRegular(root, GENERATED_BIOME_PATH);
    const files = PRODUCER_FILES.map((file) => {
      const committed = rawBlob(root, headSha, file.path);
      if (sha256(committed) !== file.sha256 || !readRegular(root, file.path).equals(committed)) {
        throw new MainSyncError(`Canonical generated-input producer is not the reviewed committed source: ${file.path}`, "NEEDS_CHANGE");
      }
      return file;
    });
    const config = rawBlob(root, headSha, "biome.jsonc");
    if (!readRegular(root, "biome.jsonc").equals(config)) throw new MainSyncError("Canonical committed Biome config changed", "NEEDS_CHANGE");
    const inputs = [...files, { path: "biome.jsonc", sha256: sha256(config) }];
    const result = spawnSync("pnpm", ["exec", "node", "--import", "tsx/esm", "--input-type=module", "--eval", PURE_PROBE], {
      cwd: root, encoding: "utf8", input: JSON.stringify({ files: inputs, config: config.toString("utf8"), maxBytes: MAX_INPUT_BYTES }),
      timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new MainSyncError("Read-only canonical generated-input probe failed; no source check or publication permitted", "NEEDS_CHANGE");
    const proof = probeSchema.parse(JSON.parse(result.stdout));
    if (proof.path !== join(root, GENERATED_BIOME_PATH) || proof.bytes !== artifact.length || proof.sha256 !== sha256(artifact)) {
      throw new MainSyncError("Generated Biome input differs from the exact committed-config derivative; preserve the artifact", "NEEDS_CHANGE");
    }
    for (const file of inputs) {
      if (sha256(readRegular(root, file.path)) !== file.sha256) throw new MainSyncError("Canonical generated-input source changed during the probe", "NEEDS_CHANGE");
    }
    if (!readRegular(root, GENERATED_BIOME_PATH).equals(artifact)) throw new MainSyncError("Generated Biome input changed during the probe", "NEEDS_CHANGE");
  } catch (error) {
    if (error instanceof MainSyncError) throw error;
    throw new MainSyncError("Could not verify the exact bounded canonical generated Biome input; preserve files and block publication", "NEEDS_CHANGE");
  }
}

function readRegular(root: string, file: string) {
  const path = join(root, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES || (stat.mode & 0o111) || realpathSync(path) !== path) {
    throw new MainSyncError(`Generated-input verification requires a bounded canonical regular file: ${file}`, "NEEDS_CHANGE");
  }
  return readFileSync(path);
}

function rawBlob(root: string, headSha: string, file: string) {
  // The shared text Git helper trims stdout; derivative identity needs the complete committed blob bytes.
  return execFileSync("git", ["show", `${headSha}:${file}`], { cwd: root, timeout: 10000, maxBuffer: MAX_INPUT_BYTES });
}

function sha256(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
