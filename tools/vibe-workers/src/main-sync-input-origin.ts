import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MainSyncError, type OriginProof } from "./main-sync-contracts.js";
import { digest, type syncContext } from "./main-sync-state.js";
import { trackedInputs } from "./main-sync-checks.js";
import { producerFiles, producerPackage, producerOwnerInputs, verifyProducerInputs, type InputProducer } from "./main-sync-input-catalog.js";
import { originIdentity, sameOriginFiles, type OriginFile } from "./main-sync-input-files.js";
import { pureOriginFiles } from "./main-sync-input-pure.js";
import { packPackageOwner } from "./main-sync-package-owner.js";

const OWNER_MS = 15 * 60 * 1000;
type SourceIdentity = ReturnType<typeof trackedInputs>;

/** Establishes complete pristine origin without deleting or copying any retained feature output. */
export function prepareInputOrigins(value: ReturnType<typeof syncContext>, before: SourceIdentity,
  producers: InputProducer[]): OriginProof {
  const root = value.place.root;
  const attempt = randomUUID();
  const files: OriginFile[] = [];
  const evidence: OriginProof["producers"] = [];
  const packages: OriginProof["packages"] = [];
  if (!producers.length) return proof();
  const needsCold = producers.some((producer) => producer.argv || producer.package);
  const cold = needsCold ? realpathSync(mkdtempSync(join(tmpdir(), "vibe-input-origin-"))) : undefined;
  let registered = false;
  const commands: { argv: string[]; exitCode: number | null; stdoutSha256: string; stderrSha256: string }[] = [];
  const log = join(value.place.dir, `vibe-input-origin-${attempt}.json`);
  try {
    verifyProducerInputs(root, before.headSha, producers);
   if (cold) {
    git(root, ["worktree", "add", "--detach", cold, before.headSha], { timeout: OWNER_MS });
    registered = true;
    assertTracked(cold, before);
    for (const producer of producers) {
      for (const path of producer.roots) if (lstatSync(join(cold, path), { throwIfNoEntry: false })) {
        throw new MainSyncError(`Pristine output origin was not empty: ${path}`, "NEEDS_CHANGE");
      }
    }
    if (lstatSync(join(cold, "node_modules"), { throwIfNoEntry: false })
      || lstatSync(join(cold, "apps/desktop/src/main/database/migrations-manifest.ts"), { throwIfNoEntry: false })) {
      throw new MainSyncError("Pristine bootstrap prerequisites are not empty or contain a legacy migration artifact", "NEEDS_CHANGE");
    }
    run(cold, ["bash", ".closedloop-ai/loops-setup.sh"]);
    assertTracked(cold, before);
   }
    const prepared: { producer: InputProducer; expected: OriginFile[]; actual: OriginFile[];
      ownerInputs: ReturnType<typeof producerOwnerInputs>; ownerPath?: string }[] = [];
    for (const producer of producers) {
      producerPackage(cold ?? root, producer);
      const sourceOwner = producerPackage(root, producer);
      const expectedOwner = producerOwnerInputs(cold ?? root, producer);
      const ownerInputs = producerOwnerInputs(root, producer, new Set(expectedOwner.map((file) => file.path)));
      if (JSON.stringify(ownerInputs) !== JSON.stringify(expectedOwner)) {
        throw new MainSyncError(`Selected installed producer differs from the pristine locked owner: ${producer.id}`, "NEEDS_CHANGE");
      }
      let ownerPath: string | undefined;
      if (sourceOwner && producer.package) {
        const packed = packPackageOwner(root, sourceOwner, producer.package.name, ownerInputs);
        const previous = packages.find((owner) => owner.path === packed.path);
        if (previous && JSON.stringify(previous) !== JSON.stringify(packed)) throw new MainSyncError("Canonical package owner conflicts within one origin operation", "NEEDS_CHANGE");
        if (!previous) packages.push(packed);
        ownerPath = packed.path;
      }
      if (producer.argv && cold) run(cold, producer.argv);
      if (cold) assertTracked(cold, before);
      const expected = producer.strategy === "pure" ? pureOriginFiles(root, producer, before.headSha) : producerFiles(cold!, producer);
      if (!expected.length) throw new MainSyncError(`Canonical producer emitted no complete output set: ${producer.id}`, "NEEDS_CHANGE");
      const names = new Set(expected.map((file) => file.path));
      const actual = producerFiles(root, producer, names);
      if (producer.strategy !== "full-write" && !sameOriginFiles(actual, expected)) {
        throw new MainSyncError(`Generated input differs from canonical committed production: ${producer.id}; SAME source must use the existing canonical producer then recheck`, "NEEDS_CHANGE");
      }
      prepared.push({ producer, expected, actual, ownerInputs, ...(ownerPath ? { ownerPath } : {}) });
    }
    // Every original set must be known before any canonical writer touches the feature checkout.
    for (const item of prepared) {
      const { producer, expected, ownerInputs, ownerPath } = item;
      const names = new Set(expected.map((file) => file.path));
      let actual = item.actual;
      if (producer.strategy === "full-write") {
        verifyProducerInputs(root, before.headSha, producers);
        run(root, producer.argv!);
        assertTracked(root, before);
        if (JSON.stringify(producerOwnerInputs(root, producer, new Set(ownerInputs.map((file) => file.path)))) !== JSON.stringify(ownerInputs)) {
          throw new MainSyncError("Trusted full-write producer changed during preparation", "NEEDS_CHANGE");
        }
        actual = producerFiles(root, producer, names);
        if (JSON.stringify(actual.map((file) => file.path)) !== JSON.stringify(expected.map((file) => file.path))) {
          throw new MainSyncError("Trusted full-write producer left a partial output set; no origin was issued", "NEEDS_CHANGE");
        }
      }
      files.push(...actual);
      evidence.push({ id: producer.id, ...(ownerPath ? { ownerPath } : {}), files: actual.map((file) => file.path), log, logSha256: "" });
    }
    assertTracked(root, before);
    verifyProducerInputs(root, before.headSha, producers);
    writeLog();
    const logSha256 = digest(readFileSync(log));
    for (const producer of evidence) producer.logSha256 = logSha256;
    return proof();
  } finally {
    writeLog();
    if (registered && cold) {
      // This exact temporary validation checkout is owned; retained feature artifacts are never touched.
      try { git(root, ["worktree", "remove", "--force", cold], { timeout: OWNER_MS }); }
      catch { throw new MainSyncError("Owned validation checkout cleanup is unproven; preserve its operation evidence"); }
    } else if (cold) rmSync(cold, { recursive: true });
  }

  function proof(): OriginProof {
    return { headSha: before.headSha, treeSha: before.treeSha, trackedInputSha256: before.inputSha256,
      inputSha256: originIdentity(before.inputSha256, files, packages), source: { runtime: value.context.runtime, workerId: value.context.workerId },
      checkedAt: new Date().toISOString(), files, packages, producers: evidence };
  }
  function writeLog() {
    writeFileSync(log, JSON.stringify({ headSha: before.headSha, treeSha: before.treeSha, ...(cold ? { scratch: cold } : {}), commands }), { mode: 0o600 });
  }
  function run(cwd: string, argv: string[]) {
    const executable = argv[0] === "node" ? process.execPath : argv[0]!;
    const result = spawnSync(executable, argv.slice(1), { cwd, encoding: "utf8", timeout: OWNER_MS, maxBuffer: 16 * 1024 * 1024 });
    commands.push({ argv, exitCode: result.status, stdoutSha256: digest(result.stdout ?? ""), stderrSha256: digest(result.stderr ?? "") });
    if (result.error || result.status !== 0) throw new MainSyncError(`Canonical generated-input producer failed: ${argv.slice(0, 4).join(" ")}; preserve private operation evidence`, "NEEDS_CHANGE");
  }
}

function assertTracked(root: string, before: SourceIdentity) {
  const after = trackedInputs(root);
  if (after.headSha !== before.headSha || after.treeSha !== before.treeSha || after.inputSha256 !== before.inputSha256) {
    throw new MainSyncError("Canonical input preparation changed committed source or lock identity", "NEEDS_CHANGE");
  }
}

