import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MAX_CHECK_MS, MainSyncError, mainSyncStateSchema, type MainComparison, type MainSyncReceipt, type OriginProof, type e2eLimitationSchema } from "./main-sync-contracts.js";
import { committedIdentity, digest, syncContext, readPrivateJson, saveSyncReceipt, MAIN_SYNC_FILE } from "./main-sync-state.js";
import { CapturedMainComparison, comparisonLogs, runBounded } from "./main-sync-main-comparison.js";
import { comparisonBudgetMs } from "./main-sync-validation-recipe.js";
import { discoverRequiredE2eLanes, type CheckCommand } from "./main-sync-lanes.js";
import { GENERATED_BIOME_PATH, MAX_INPUT_BYTES, verifyGeneratedBiomeInput } from "./main-sync-generated-input.js";
import { committedLocalPlans, isLocalPlanPath } from "../../../plugins/vibe/skills/vibe/scripts/local-plans.mjs";
import { verifyPrivateInput, verifyPrivateRoot, verifyEvidencePath } from "./main-sync-private-inputs.js";
import { presentProducers, producerFor, producerFiles, producerPackage, producerOwnerInputs, reportOutputs, verifyProducerInputs, verifyProducerInputsForOrigin } from "./main-sync-input-catalog.js";
import { originIdentity, sameOriginFiles } from "./main-sync-input-files.js";
import { readWriterSummary } from "./ledger.js";
import { bindCheckBudgets, commandSelection } from "./main-sync-budget.js";
import { verifyReportRecipe, verifyReportExecution } from "./main-sync-report-inputs.js";
import { ReportExecutionOwner } from "./main-sync-report-execution.js";
import { recheckSelectedProduction, selectedRecoveryReserve } from "./main-sync-check-production.js";
import { performance } from "node:perf_hooks";
import { relative } from "node:path";
import { packageOwnerPaths, packageTupleIdentity } from "./main-sync-package-owner.js";

const EXECUTABLE_INPUT = /(?:\.(?:[cm]?js|tsx?|jsx|py|sh|jsonc?|ya?ml|toml|css|scss|html|sql|prisma)$|(?:^|\/)\.(?:npmrc|nvmrc)|(?:^|\/)(?:package-lock|pnpm-lock))/;
const BIOME_PATHS_PER_COMMAND = 120;
const SOURCE_PATH = /\.(?:[cm]?js|tsx?|jsx|py|sh|jsonc?|ya?ml|toml|css|scss)$/;
const PRIVATE_ARTIFACT = /\.(?:md|json|log|txt|png|webp)$/;
const CACHE_SEGMENTS = new Set(["node_modules", ".next", ".turbo", "dist", "storybook-static", ".cache"]);
/** A person's own agent and editor config: ignored files here are never a validation input (ISS-13291). */
const LOCAL_CONFIG_DIRS = new Set([".codex", ".claude", ".agents", ".vscode", ".idea"]);
const turboTasksSchema = z.object({ tasks: z.array(z.object({ taskId: z.string(), package: z.string().optional() }).passthrough()) }).passthrough();

/** Every tracked byte/mode and nonprivate executable overlay must match the committed publication tree. */
export function committedInputs(root: string) {
  const inspected = inspectInventory(root, "origin");
  const before = inspected.inventory;
  if (!before.producers.length) return { headSha: before.headSha, treeSha: before.treeSha, inputSha256: before.inputSha256 };
  const metadata = inspected.metadata!;
  const file = join(metadata, MAIN_SYNC_FILE);
  if (!existsSync(file)) throw new MainSyncError("Canonical source input readiness is required before generated dependencies can be consumed", "NEEDS_CHANGE");
  const state = mainSyncStateSchema.parse(readPrivateJson(file));
  if (state.worktree !== root) throw new MainSyncError("Generated input origin belongs to another worktree", "NEEDS_CHANGE");
  const proof = state.inputs;
  if (!proof) throw new MainSyncError("Canonical source input readiness proof is missing", "NEEDS_CHANGE");
  verifyOriginProof(root, metadata, before, proof);
  return { headSha: before.headSha, treeSha: before.treeSha, inputSha256: proof.inputSha256 };
}

/** Inventory is not admission: only source preparation or a verified canonical origin can consume its generated set. */
export function inspectInputInventory(root: string) {
  return inspectInventory(root, "standalone").inventory;
}

function inspectInventory(root: string, completion: "standalone" | "origin") {
  const before = trackedInputs(root);
  verifyPrivateRoot(root);
  for (const path of reportOutputs) {
    if (lstatSync(join(root, path), { throwIfNoEntry: false })) verifyEvidencePath(root, path, "Retained report");
  }
  const generated = lstatSync(join(root, GENERATED_BIOME_PATH), { throwIfNoEntry: false });
  if (generated && !generated.isFile()) {
    throw new MainSyncError(`Generated-input verification requires a bounded canonical regular file: ${GENERATED_BIOME_PATH}`, "NEEDS_CHANGE");
  }
  let recognizedDerivative = false;
  const untracked: string[] = [];
  for (const ignored of [false, true]) {
    const args = ["ls-files", "--others", "--exclude-standard", "-z", ...(ignored ? ["--ignored"] : [])];
    for (const file of git(root, args).split("\0").filter(Boolean)) {
      untracked.push(file);
      if (file.split("/").some((segment) => CACHE_SEGMENTS.has(segment))) continue;
      if (ignored && file.split("/").slice(0, -1).some((segment) => LOCAL_CONFIG_DIRS.has(segment))) continue;
      if (isLocalPlanPath(file)) {
        if (!ignored) throw new MainSyncError(`Private planning evidence must remain ignored: ${file}`, "NEEDS_CHANGE");
        verifyPrivateInput(root, file, before.headSha);
        continue;
      }
      if (PRIVATE_ARTIFACT.test(file) && (file.startsWith(".closedloop-ai/decision-tables/") || file.startsWith(".control/"))) continue;
      if (producerFor(file)) {
        if (!ignored) throw new MainSyncError(`Canonical generated dependency must remain ignored: ${file}`, "NEEDS_CHANGE");
        continue;
      }
      if (ignored && reportOutputs.has(file)) {
        const stat = lstatSync(join(root, file));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new MainSyncError(`Retained report must be a regular owned output: ${file}`, "NEEDS_CHANGE");
        continue;
      }
      if (ignored && file === GENERATED_BIOME_PATH) {
        verifyGeneratedBiomeInput(root, before.headSha);
        recognizedDerivative = true;
        continue;
      }
      if (file.split("/").at(-1)?.startsWith(GENERATED_BIOME_PATH)) {
        throw new MainSyncError(`Committed validation inputs differ from HEAD: unsupported generated-input path ${file}`, "NEEDS_CHANGE");
      }
      if (EXECUTABLE_INPUT.test(file)) throw new MainSyncError(`Committed validation inputs differ from HEAD: uncommitted executable ${file}`, "NEEDS_CHANGE");
    }
  }
  const plans = committedLocalPlans((args) => git(root, args));
  if (plans.length) throw new MainSyncError("Local technical plans are committed; publication is blocked");
  if (recognizedDerivative) {
    const after = trackedInputs(root);
    if (after.headSha !== before.headSha || after.treeSha !== before.treeSha || after.inputSha256 !== before.inputSha256) {
      throw new MainSyncError("Committed validation inputs changed during the read-only derivative probe", "NEEDS_CHANGE");
    }
  }
  const producers = presentProducers(root);
  let metadata: string | undefined;
  if (completion === "origin" && producers.length) metadata = verifyProducerInputsForOrigin(root, before.headSha, producers, untracked);
  else verifyProducerInputs(root, before.headSha, producers, untracked);
  return { inventory: { ...before, producers }, metadata };
}

/** Recovery may replace authenticated changed output bodies, never untouched bytes, package refs or evidence. */
export function verifyOriginProof(root: string, metadata: string, before: ReturnType<typeof inspectInputInventory>, proof: OriginProof,
  changed: ReadonlySet<string> = new Set()) {
  const writer = readWriterSummary(root);
  if (proof.headSha !== before.headSha || proof.treeSha !== before.treeSha || proof.trackedInputSha256 !== before.inputSha256
    || writer?.workerId !== proof.source.workerId || writer.runtime !== proof.source.runtime) {
    throw new MainSyncError("Canonical generated input origin is stale or belongs to another source actor", "NEEDS_CHANGE");
  }
  const files = before.producers.flatMap((producer) => changed.has(producer.id)
    ? proof.files.filter((file) => producer.roots.some((path) => file.path === path || file.path.startsWith(`${path}/`)))
    : producerFiles(root, producer, new Set(proof.files.map((file) => file.path))));
  if (!sameOriginFiles(files, proof.files) || originIdentity(before.inputSha256, files, proof.packages) !== proof.inputSha256
    || JSON.stringify(before.producers.map((producer) => producer.id)) !== JSON.stringify(proof.producers.map((producer) => producer.id))) {
    throw new MainSyncError("Generated dependency bytes or complete output set changed; SAME source input readiness required", "NEEDS_CHANGE");
  }
  if (new Set(proof.packages.map((owner) => owner.path)).size !== proof.packages.length
    || proof.packages.some((owner) => !proof.producers.some((producer) => producer.ownerPath === owner.path))) {
    throw new MainSyncError("Duplicate, conflicting or unreferenced canonical package owner", "NEEDS_CHANGE");
  }
  for (const producer of proof.producers) {
    const selected = before.producers.find((item) => item.id === producer.id)!;
    const currentOwner = producerPackage(root, selected);
    if (currentOwner) {
      const path = relative(root, currentOwner.directory);
      const owner = proof.packages.find((item) => item.path === path);
      if (producer.ownerPath !== path || !owner || owner.name !== selected.package?.name || owner.version !== currentOwner.version
        || packageTupleIdentity(producerOwnerInputs(root, selected, packageOwnerPaths(root, owner))) !== owner.sha256) {
        throw new MainSyncError("Selected canonical package ref, complete bytes or modes changed; source readiness required", "NEEDS_CHANGE");
      }
    } else if (producer.ownerPath) {
      throw new MainSyncError("Pure owner cannot borrow an installed package reference", "NEEDS_CHANGE");
    }
    const stat = lstatSync(producer.log);
    const name = producer.log.slice(metadata.length + 1);
    if (!producer.log.startsWith(`${metadata}/`) || !/^vibe-input-origin-[a-f0-9-]{36}\.json$/.test(name)
      || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024
      || digest(readFileSync(producer.log)) !== producer.logSha256) {
      throw new MainSyncError("Actual generated-origin execution evidence changed", "NEEDS_CHANGE");
    }
  }
}

/** Source parity stays absolute even while the same source writer prepares generated dependencies. */
export function trackedInputs(root: string) {
  const identity = committedIdentity(root);
  if (git(root, ["write-tree"]) !== identity.treeSha) throw new MainSyncError("Committed validation inputs differ from HEAD: staged source", "NEEDS_CHANGE");
  const hash = createHash("sha256");
  const entries = git(root, ["ls-tree", "-r", "-z", "HEAD"]);
  for (const entry of entries.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, kind, object] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    const target = join(root, file);
    if (kind !== "blob" || !existsSync(target)) throw new MainSyncError(`Committed validation inputs differ from HEAD: ${file}`, "NEEDS_CHANGE");
    const stat = lstatSync(target);
    if (stat.size > MAX_INPUT_BYTES) throw new MainSyncError(`Validation input exceeds the bounded file limit: ${file}`);
    const content = mode === "120000" && stat.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : stat.isFile() ? readFileSync(target) : undefined;
    const actual = content && createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    const executable = Boolean(stat.mode & 0o111);
    if (!content || actual !== object || (mode !== "120000" && executable !== (mode === "100755"))) {
      throw new MainSyncError(`Committed validation inputs differ from HEAD: ${file}; preserve localFix source and use the same-writer workaround flow`, "NEEDS_CHANGE");
    }
    hash.update(`${mode}\0${object}\0${file}\0`);
  }
  return { ...identity, inputSha256: hash.digest("hex") };
}

/** Existing fixed recipes are selected from actual feature scope, never caller-supplied commands or PASS bits. */
export function checkRecipe(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt) {
  const root = value.place.root;
  const files = git(root, ["diff", "--name-only", "--no-renames", receipt.mainSha, "HEAD"]).split("\n").filter(Boolean);
  const prototype = value.place.branch.startsWith("prototype/");
  const paths = files.filter((file) => SOURCE_PATH.test(file) && existsSync(join(root, file)));
  const commands: CheckCommand[] = [];
  const e2eLimitations: z.infer<typeof e2eLimitationSchema>[] = [];
  // operator ruling, 2026-10-13: a build-loop deploy runs only what the commit hooks run
  // (affected typecheck and Biome on the changed source); the test suites run at handoff.
  if (value.purpose === "build") {
    commands.push(...biomeCheckCommands(paths));
    commands.push({ argv: ["pnpm", "typecheck:affected"] });
    verifyReportRecipe(commands);
    const bound = bindCheckBudgets(commands);
    return { commands: bound, e2eLimitations, recovery: selectedRecoveryReserve(root, bound) };
  }
  if (prototype) {
    commands.push({ argv: ["pnpm", "--filter", "prototypes", "generate:registry"] },
      { argv: ["pnpm", "--filter", "prototypes", "typecheck"] },
      { argv: ["pnpm", "--filter", "prototypes", "test"] },
      { argv: ["pnpm", "exec", "biome", "check", "apps/prototypes"] },
      { argv: ["node", ".claude/skills/prototype-approve/scripts/read-decision-log.mjs", `apps/prototypes/app/p/${value.place.session.slug}/decisions.md`] });
  } else {
    // operator ruling, 2026-10-19: no broad or full local suite runs here. The verify worker runs the tests
    // closedloop-graph's code_tests_for selects per changed file, and CI runs the broad suites on the PR and after merge.
    commands.push(...biomeCheckCommands(paths));
    e2eLimitations.push(...discoverRequiredE2eLanes(root, receipt));
    commands.push({ argv: ["pnpm", "check:source-gates"] }, { argv: ["pnpm", "typecheck:affected"] });
  }
  const filter = `...[${receipt.validationSince}]`;
  commands.push({ argv: ["pnpm", "turbo", "typecheck", `--filter=${filter}`, "--concurrency=1"] });
  if (files.some((file) => file.includes(".stories.") || file.startsWith("apps/storybook/") || file.startsWith("packages/design-system/"))) {
    commands.push({ argv: ["pnpm", "--filter", "storybook", "validate:catalog"] });
  }
  commands.push({ argv: ["pnpm", "vibe", "storybook-diff"] });
  verifyReportRecipe(commands);
  const bound = bindCheckBudgets(commands);
  // operator ruling, 2026-10-16: a handoff failure is compared against the captured main; the reserve bounds that.
  return { commands: bound, e2eLimitations, recovery: selectedRecoveryReserve(root, bound),
    comparison: { timeoutMs: comparisonBudgetMs(bound.map((command) => ({ timeoutMs: command.timeoutMs ?? MAX_CHECK_MS }))) } };
}

/** Runs the fixed matrix; verified producer changes invalidate old evidence and get one bounded clean restart. */
export function executeChecks(value: ReturnType<typeof syncContext>, receipt: MainSyncReceipt,
  preparedRecipe?: ReturnType<typeof checkRecipe>) {
  let before = committedInputs(value.place.root);
  const recipe = preparedRecipe ?? checkRecipe(value, receipt);
  const spent = recipe.commands.map(() => 0);
  const drySpent = recipe.commands.map(() => 0);
  const main = value.purpose === "handoff" ? new CapturedMainComparison(value.place.root, value.place.dir, receipt) : undefined;
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
   const results = [];
   let restart = false;
   for (const [index, command] of recipe.commands.entries()) {
    assertIdentity(value.place.root, before);
    let selection: z.infer<typeof turboTasksSchema> | undefined;
    if (command.argv[1] === "turbo" || command.argv.join(" ") === "pnpm typecheck:affected") {
      const start = performance.now();
      selection = commandSelection(value.place.root, command, remainingBudget(MAX_CHECK_MS, drySpent[index]!));
      drySpent[index]! += performance.now() - start;
      // The affected wrapper's no-op is not coverage; the later deployment-pinned matrix still runs.
      if (command.argv[1] === "turbo" && !selection?.tasks.length
        && git(value.place.root, ["diff", "--name-only", receipt.validationSince, "HEAD"])) {
        throw new MainSyncError("Pinned validation selected no tasks for changed inputs; no executed coverage was established");
      }
      assertIdentity(value.place.root, before);
    }
    const env = { ...process.env, TURBO_CONCURRENCY: "2" };
    Reflect.deleteProperty(env, "AFFECTED_SCRIPT_SUITES");
    Object.assign(env, command.bindings);
    const start = performance.now();
    verifyReportExecution(value.place.root, value.place.root, ReportExecutionOwner.Check, command.argv,
      command.cwd ? join(value.place.root, command.cwd) : value.place.root, selection);
    const result = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: command.cwd ? join(value.place.root, command.cwd) : value.place.root, encoding: "utf8",
      timeout: remainingBudget(command.timeoutMs ?? MAX_CHECK_MS, spent[index]!), maxBuffer: 16 * 1024 * 1024,
      env });
    spent[index]! += performance.now() - start;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const prefix = join(value.place.dir, `vibe-main-sync-${receipt.transactionId}-${attempt}-${index}`);
    const log = `${prefix}.log`;
    writeFileSync(log, output, { mode: 0o600 });
    let evidence = { exitCode: 0, log, sha256: digest(output) };
    let comparison: MainComparison | undefined;
    if (result.error || result.status !== 0) {
      if (!main) throw new MainSyncError(`Required validation command failed: ${command.argv.join(" ")}; private log ${log}`);
      const failed = { ...evidence, exitCode: result.status ?? 1 };
      comparison = main.classify(command, selection, failed, prefix, env, (rerunLog) => {
        verifyReportExecution(value.place.root, value.place.root, ReportExecutionOwner.Check, command.argv,
          command.cwd ? join(value.place.root, command.cwd) : value.place.root, selection);
        const again = runBounded(command.argv, command.cwd ? join(value.place.root, command.cwd) : value.place.root, env,
          command.timeoutMs ?? MAX_CHECK_MS, rerunLog);
        return { exitCode: again.exitCode, log: again.log, sha256: again.sha256 };
      });
      if (comparison.classification === "session-caused") {
        recordFailedCheck(value, command, comparison);
        throw new MainSyncError(sessionCausedMessage(command, comparison));
      }
      evidence = comparison.classification === "flaky" ? comparison.sessionRuns[1]! : failed;
    }
    if (selection) {
      writeFileSync(`${log}.selection.json`, JSON.stringify(selection), { mode: 0o600 });
    }
    try { assertIdentity(value.place.root, before); }
    catch (error) {
      if (!(error instanceof MainSyncError) || error.status !== "NEEDS_CHANGE" || attempt !== 0) throw error;
      recheckSelectedProduction(value, receipt, command, selection, recipe.recovery.owners);
      before = committedInputs(value.place.root);
      restart = true;
      break;
    }
    results.push({ argv: command.argv, ...(command.bindings ? { bindings: command.bindings } : {}),
      ...(command.cwd ? { cwd: command.cwd } : {}), timeoutMs: command.timeoutMs ?? MAX_CHECK_MS,
      ...evidence, ...(comparison ? { comparison } : {}) });
   }
   if (restart) continue;
   assertIdentity(value.place.root, before);
   return { ...before, commands: results, checkedAt: new Date().toISOString(), e2eLimitations: recipe.e2eLimitations };
  }
  } finally { main?.dispose(); }
  throw new MainSyncError("Canonical outputs changed repeatedly; current validation remains incomplete", "NEEDS_CHANGE");
}

function remainingBudget(total: number, spent: number) {
  const remaining = Math.floor(total - spent);
  if (remaining <= 0) throw new MainSyncError("Fixed command execution budget exhausted; no validation receipt");
  return remaining;
}

function assertIdentity(root: string, expected: ReturnType<typeof committedInputs>) {
  const current = committedInputs(root);
  if (current.headSha !== expected.headSha || current.treeSha !== expected.treeSha || current.inputSha256 !== expected.inputSha256) {
    throw new MainSyncError("Committed validation inputs changed during the operation; same-writer recheck required", "NEEDS_CHANGE");
  }
}

/** A blocked handoff keeps its classification and evidence in the receipt it already owns, beside the phase it is in. */
function recordFailedCheck(value: ReturnType<typeof syncContext>, command: CheckCommand, comparison: MainComparison) {
  const state = mainSyncStateSchema.parse(readPrivateJson(join(value.place.dir, MAIN_SYNC_FILE)));
  const failedChecks = [{ argv: command.argv, ...(command.bindings ? { bindings: command.bindings } : {}),
    ...(command.cwd ? { cwd: command.cwd } : {}), comparison }];
  if (state.phase === "input-readiness") {
    if (state.previous) saveSyncReceipt(value.place.dir, { ...state, previous: { ...state.previous, failedChecks } });
  } else saveSyncReceipt(value.place.dir, { ...state, failedChecks });
}

function sessionCausedMessage(command: CheckCommand, comparison: MainComparison) {
  const check = command.argv.join(" ");
  const logs = comparisonLogs(comparison).map((item) => item.log).join(", ");
  if (comparison.main.outcome === "unrunnable") {
    return `Required validation command failed: ${check}; it could not run on captured main ${comparison.mainSha} (${comparison.main.reason}), so it is treated as session-caused; private logs ${logs}`;
  }
  return `Required validation command failed: ${check}; it passes on captured main ${comparison.mainSha} and failed again on a rerun of the session commit, so the session caused it (session-caused); private logs ${logs}`;
}

/**
 * Biome over the changed source, split so no command's argv passes the report-execution bound of 128 entries
 * (#8960: one Biome command per change set failed `schema: argv too_big` and forced the plain-push fallback).
 */
export function biomeCheckCommands(paths: string[]): CheckCommand[] {
  const commands: CheckCommand[] = [];
  for (let start = 0; start < paths.length; start += BIOME_PATHS_PER_COMMAND) {
    commands.push({ argv: ["pnpm", "exec", "biome", "check", ...paths.slice(start, start + BIOME_PATHS_PER_COMMAND)] });
  }
  return commands;
}
