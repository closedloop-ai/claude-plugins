import { bootstrapCommand, cloudRecipe, recipeProvider, toolingRoot } from "./cloud-validation-recipes.mjs";
import { capturedJson } from "./captured-json.mjs";
import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { recoverValidationReservation, withCloudValidationAdmission } from "./cloud-validation-admission.mjs";
import { withValidationReportLock } from "./cloud-validation-report.mjs";
import { TERMINAL } from "./cloud-receipts.mjs";
import { canonicalCloudArgv, cloudTurboTasks, cloudTypecheckArgv, cloudApiEnvironment, routeArgv } from "./cloud-validation-host.mjs";
import { restoreValidationRun } from "./cloud-routines.mjs";
import { CLOUD_CAPABILITIES_LANE, CLOUD_CAPABILITIES_COMMAND } from "./cloud-check-command.mjs";
import { checkEnvironmentPin } from "./cloud-account-pin.mjs";
import { cloudcheckProofIdentity } from "./cloudcheck-proof.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

const PROOF_SCHEMA = "vibe.cloud-runtime-proof/1";
const PROOF_MAX_MS = 30 * 60_000;
const SHA = /^[a-f0-9]{40}$/;
const PROOF_KEYS = ["workspace", "nonRoot", "ports", "chromium", "gitUtc"];
const OPTIONAL_PROOF_KEYS = ["controlNamespace", "chromium1254", "docker", "dockerBootstrap", "display", "zsh", "uv", "python313", "node24", "pnpm"];
const API_TEST = cloudRecipe.apiTestPattern ? new RegExp(cloudRecipe.apiTestPattern) : null;
const TOOL_REPO = "https://github.com/closedloop-ai/claude-plugins.git";
const RUNNER = `${toolingRoot}/lib/vibe/scripts/cloud-validation-host.mjs`;
const SAFE_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9_.\/-]+$/;
const CONTROL_PORTS = /(?:--filter(?:=|\s+)|-F\s+)(?:@repo\/)?control\b|\bpkgs-a\b|\bweb-stack-env\b/i;
const AFFECTED = new Map([
  ["controlNamespace", CONTROL_PORTS],
  ["workspace", /(?:\bdesktop\b|\btest:renderer\b|renderer-tests)/i],
  ["nonRoot", /(?:\bpnpm\s+typecheck\b|upload-sourcemaps|--filter(?:=|\s+)(?:@repo\/)?(?:app|control)\b|\bturbo\s+(?:run\s+)?typecheck\b|\bpkgs-a\b|\btest:lint\b|\bweb-stack-env\b)/i],
  ["ports", /(?:--filter(?:=|\s+)(?:@repo\/)?control\b|\bpkgs-a\b|\bweb-stack-env\b|\bdesktop\b)/i],
  ["chromium", /(?:\bbranches-plays\b|test:storybook|playwright|\bdesktop\b)/i],
  ["gitUtc", /(?:test:gardener|\bgardener\b)/i],
]);

const quoted = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function proofPath(home, pin) {
  return path.join(home, ".codex", "vibe", "cloud", "runtime-proof", `${digest(`${pin.environmentId}\0${pin.accountUuid}`)}.json`);
}

function validTool(tool) {
  return SHA.test(tool?.commit ?? "") && SAFE_REF.test(tool?.ref ?? "") &&
    !tool.ref.includes("..") && !tool.ref.includes("//") && !tool.ref.endsWith(".lock");
}

function matchingProof(home, pin, tool, now) {
  const file = proofPath(home, pin);
  if (!existsSync(file)) return null;
  let record;
  try { record = regularJson(file); } catch { return null; }
  if (record?.schema !== PROOF_SCHEMA || record.environmentId !== pin.environmentId || record.accountUuid !== pin.accountUuid ||
    !validTool(record.tool) || (tool && (record.tool.commit !== tool.commit || record.tool.ref !== tool.ref)) || typeof record.sessionId !== "string" || !record.sessionId ||
    !Number.isFinite(record.at) || record.at > now || now - record.at > PROOF_MAX_MS) return null;
  return record;
}

/** Read a fresh capability measurement for this exact environment and signed-in account. */
export function measuredSetupTools(home, pin, accountUuid, environmentId, now = Date.now()) {
  if (!pin || pin.environmentId !== environmentId || pin.accountUuid !== accountUuid) return null;
  return matchingProof(home, pin, null, now)?.checks ?? null;
}

function laneCommands(lane) {
  if (!lane.workflow) return [lane.command];
  const { workflow, job } = JSON.parse(lane.command);
  return job.steps.flatMap((step) => {
    if (!step.run) return [];
    const directory = step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? workflow.defaults?.run?.["working-directory"];
    return directory && directory === cloudRecipe.apiDirectory ? [step.run.replace(/(^|\n)(\s*)pnpm\s+/g, `$1$2pnpm --dir ${directory} `)] : [step.run];
  });
}

/** A syntax-only Node check reads the source as input without loading the package or its runtime. */
export function syntaxOnlyLane(command) {
  if (typeof command !== "string" || !/^node\s+(?:--check|-c)\s/.test(command)) return false;
  try { return routeArgv(command).length === 3; } catch { return false; }
}

function commandScope(command, read) {
  let argv;
  try { argv = routeArgv(command,bootstrapCommand); } catch { return command; }
  const operation = cloudTypecheckArgv(argv,read);
  const end = operation.indexOf("--");
  argv = canonicalCloudArgv(operation.slice(0,end < 0 ? undefined : end));
  if (syntaxOnlyLane(command)) return "";
  // Package names and arbitrary input paths do not turn syntax, lint or Python commands into browser runs.
  if (argv[0] !== "pnpm") return argv[0] === "node" && argv[1] === "--test" ? argv.slice(2).map(file=>path.basename(file)).join(" ") : argv[0];
  const scopes = [], operations = [];
  for (let i=1;i<argv.length;i++) {
    const match = /^(--filter|--dir|-C)(?:=(.*))?$/.exec(argv[i]);
    if (!match) { operations.push(argv[i]); continue; }
    const value = match[2] ?? argv[++i];
    if (!value) continue;
    let target = value;
    if (match[1] !== "--filter" && read && /^(?:\.\/)?[\w.-]+(?:\/[\w.-]+)*$/.test(value) && !value.split("/").includes("..")) {
      try { target = JSON.parse(read(value.replace(/^\.\//,"")+"/package.json"))?.name ?? value; } catch { /* Unresolved selectors retain their original meaning. */ }
    }
    scopes.push("--filter",target);
  }
  if (operations[0] === "run" || operations[0] === "exec") operations.shift();
  const turboTasks=cloudTurboTasks(operation,read);
  const typecheck = operations[0] === "typecheck" || turboTasks.includes("typecheck");
  const runnable = operations[0] === "turbo" ? turboTasks : operations.slice(0,1);
  const exercisesPackage = runnable.some(task => /^(?:test(?:$|:)|playwright|vitest|renderer-tests|branches-plays|web-stack-env)/.test(task));
  return [typecheck ? "pnpm typecheck" : "pnpm",...(exercisesPackage ? scopes : []),...runnable].join(" ");
}

/** Declare prerequisites for each lane from its resolved command and pinned repository files. */
export function describeCloudLanes(lanes, { read, commit } = {}) {
  const packages = lanes.flatMap(({ command, prerequisite }) =>
    prerequisite ? [/^pnpm --filter (\S+) build$/.exec(command)?.[1]].filter(Boolean) : []);
  const requiresSetup = lanes.some(({ prerequisite }) => prerequisite);
  return lanes.map((lane) => {
    const ordinary = !lane.prerequisite && !lane.capabilityProbe && !lane.cloudFrozen;
    const steps = laneCommands(lane);
    const commands = steps.map(command => {
      try { return canonicalCloudArgv(routeArgv(command, bootstrapCommand)).join(" "); } catch { return command; }
    });
    // Only committed workflow job identities carry execution semantics in their names.
    const operations = steps.map(command => commandScope(command,read));
    const scope = (lane.workflow ? [lane.name, ...operations] : operations).join(" ");
    const capabilities = ordinary ? [...AFFECTED].filter(([, pattern]) => pattern.test(scope)).map(([kind]) => kind) : [];
    if (capabilities.includes("controlNamespace")) capabilities.push("nonRoot","ports");
    if (capabilities.includes("chromium")) capabilities.push("chromium1254");
    if (ordinary && requiresSetup && !syntaxOnlyLane(lane.command) && !lane.command.startsWith("e2e/")) capabilities.push("workspace");
    if (lane.cloudE2E && lane.command.startsWith("e2e/")) capabilities.push("docker");
    if (lane.containerPnpm) capabilities.push("dockerBootstrap");
    else if (lane.cloudE2E && lane.command.startsWith("pnpm")) capabilities.push("display");
    const needsEnv = ordinary && commands.some((command) => API_TEST?.test(command));
    if (needsEnv) capabilities.push("nonRoot");
    return { ...lane, prerequisites: { packages: ordinary ? packages : [], capabilities: [...new Set(capabilities)],
      env: needsEnv ? { kind: "api-test", source: typeof read === "function" ? cloudApiEnvironment(read, commit, cloudRecipe) : null } : null } };
  });
}

/** Select typed host requirements, preserving special exact-tooling and independent probe paths. */
export function requiredCloudEnvironment(lanes) {
  const described = lanes.every(({ prerequisites }) => prerequisites) ? lanes : describeCloudLanes(lanes);
  return described.filter(({ prerequisites }) => prerequisites.capabilities.length || prerequisites.env)
    .map(({ name, prerequisites }) => ({ name, ...prerequisites }));
}

/** Reject dependent lanes before provider I/O until the exact account image and committed host runner are proven. */
export function admitCloudEnvironment(lanes, { home, environmentId, pin, currentAccount, tool, now = Date.now() }) {
  const affected = requiredCloudEnvironment(lanes);
  if (affected.length === 0) return null;
  const usable = pin?.environmentId === environmentId && pin?.accountUuid === currentAccount && validTool(tool);
  const proof = usable ? matchingProof(home, pin, tool, now) : null;
  const problems = affected.flatMap(({ name, capabilities, env }) => {
    const missing = capabilities.filter((key) => proof?.checks?.[key] !== true);
    if (env && !env.source) missing.unshift("approved committed non-secret API test fixture");
    const lane = lanes.find((entry) => entry.name === name);
    if (lane.workflow) missing.unshift("non-root workflow step execution");
    return missing.length ? [`${name} (${missing.join(", ")})`] : [];
  });
  if (problems.length) {
    throw new Error(`CLOUD_LANES_UNAVAILABLE: ${problems.join("; ")} have no current exact environment, account and tooling proof; run on L2 (remote slot heavy)`);
  }
  const container = (lane) => lane.containerPnpm || (lane.cloudE2E && lane.command.startsWith("e2e/"));
  const setup = (lane) => lane.prerequisite === true;
  if (lanes.every((lane) => container(lane) || setup(lane))) return null;
  if (lanes.some((lane) => lane.capabilityProbe || lane.cloudFrozen || container(lane))) {
    throw new Error("submit frozen-render, containerized E2E or exact-tooling capability probes separately from non-root application lanes");
  }
  for (const lane of lanes) routeArgv(lane.command, bootstrapCommand);
  return { tool, affected };
}

/** Recheck live account and exact runtime proof before using a protected lane. */
export function validationRuntimeAdmission(lanes, { home, env, ledger, currentAccount, tool }) {
  if (requiredCloudEnvironment(lanes).length === 0) return null;
  const pin = ledger().environmentPin;
  let account;
  if (pin) {
    try { account = currentAccount({ home }); } catch { /* Match no account; refuse by lane name. */ }
  }
  return admitCloudEnvironment(lanes, { home, environmentId: env.id, pin, currentAccount: account, tool });
}

/** Persist only a canonical completed capability lane's exact tool, performing account and observed checks. */
export function confirmCloudEnvironment({ home, pin, environmentId, tool, sessionId, completed, outcome, now = Date.now() }) {
  if (!pin || pin.environmentId !== environmentId || !validTool(tool) || typeof sessionId !== "string" || !sessionId || !completed) return false;
  let evidence = null;
  if (outcome?.name === "cloud-capabilities" && outcome.exitCode === 0) {
    const lines = String(outcome.stdoutTail ?? "").split("\n").filter((line) => line.startsWith("CLOUD_HOST_RUNTIME "));
    if (lines.length === 1) {
      try { evidence = capturedJson(lines[0].slice("CLOUD_HOST_RUNTIME ".length)); } catch { /* A malformed report expires its prior proof. */ }
    }
  }
  const valid = evidence?.commit === tool.commit && evidence.checks
    && Object.keys(evidence.checks).every((key) => [...PROOF_KEYS, ...OPTIONAL_PROOF_KEYS].includes(key) && typeof evidence.checks[key] === "boolean")
    && PROOF_KEYS.every((key) => typeof evidence.checks[key] === "boolean");
  const checks = valid ? evidence.checks : Object.fromEntries([...PROOF_KEYS, ...OPTIONAL_PROOF_KEYS].map((key) => [key, false]));
  writeAtomic(proofPath(home, pin), { schema: PROOF_SCHEMA, ...pin, tool, sessionId, at: now, checks });
  return Boolean(valid);
}

function canonicalProbe(lanes) {
  return lanes?.some(lane => lane.capabilityProbe === true && !lane.workflow &&
    lane.name === CLOUD_CAPABILITIES_LANE && lane.command === CLOUD_CAPABILITIES_COMMAND);
}

/** Save measured capability output in the current account without treating a different login as evidence. */
export function recordRuntimeFromValidation({ lanes, ledger, currentAccount, home, branch }, result, finished) {
  if (!canonicalProbe(lanes)) return;
  const outcome = result.lanes.find(({ name }) => name === "cloud-capabilities");
  if (!outcome) return;
  const { environmentPin: pin, runs } = ledger();
  const launch = runs.find((run) => run.runId === finished.runId && run.routineId === finished.routineId);
  const at = Date.parse(launch?.startedAt);
  if (!pin || launch?.accountUuid !== pin.accountUuid || launch?.environmentId !== pin.environmentId ||
    finished.status !== "completed" || (launch.sessionId && launch.sessionId !== finished.sessionId) ||
    !Number.isFinite(at) || currentAccount({ home }) !== pin.accountUuid) return;
  confirmCloudEnvironment({ home, pin, environmentId: finished.environment?.id, sessionId: finished.sessionId, completed: true, now: at,
    tool: { commit: result.commit, ref: finished.proof?.ref ?? `refs/heads/${branch}` }, outcome });
}

/** Render the fixed immutable runtime plan with no caller-supplied shell commands. */
export function cloudHostInstruction({ tool, affected }, { lanes, commit, reporter = null }) {
  const capability = (name, kind) => affected.some((entry) => entry.name === name && entry.capabilities.includes(kind));
  const plan = {
    commit,
    lanes: lanes.map((lane) => ({ name: lane.name, command: lane.command, prerequisite: lane.prerequisite === true,
      browser: capability(lane.name, "chromium"), isolateControlPorts: capability(lane.name,"controlNamespace"), envSource: affected.find(({ name }) => name === lane.name)?.env?.source ?? null, displayless: Boolean(lane.cloudE2E && capability(lane.name, "display")) })),
    ...(reporter ? { reporter: { tool: tool.commit, root: toolingRoot, files: reporter.files, spec: reporter.spec } } : {}),
  };
  const target = `.git/vibe-validation-host-${tool.commit}.mjs`;
  return [
    "This request uses the verified non-root lane runner. Execute the following commands once, in order. If setup cannot complete, report the exact failure and mark the lanes unrun.",
    `git fetch --no-tags ${TOOL_REPO} ${tool.ref} && git merge-base --is-ancestor ${tool.commit} FETCH_HEAD && git show ${tool.commit}:${RUNNER} > ${target}`,
    ...(recipeProvider ? [`git show ${tool.commit}:${toolingRoot}/provider/provider.json > ${target}.provider.json`] : []),
    // Run as its own call with its output visible. It writes its own output and exit files, since it usually outlasts the
    // Bash tool's 10-minute wait, and a shell redirect that hid a fetched runner's output was refused as undermining oversight.
    `node ${target} ${quoted(JSON.stringify(plan))}`,
    `Run each command above as its own Bash call. The runner prints its result lines and also writes them to ${target}.out, then its exit code to ${target}.exit. When the Bash tool moves the runner to the background, keep waiting in this turn: poll ${target}.exit with a foreground \`until\` loop in later calls until it exists, then read ${target}.out. Never end the turn, rerun the runner or report lanes unrun while ${target}.exit is missing.`,
    "CLOUD_HOST_LANES gives a private directory and count. Read each zero-based <index>.json file separately, preserving exitCode, stdoutTail, stderrTail and diagnosis in the indexed report parts. Keep the private files in this provider session. Include only each privateStreams locator, byte count and SHA-256 with its lane. Never publish or emit full stream contents. Do not run a requested command a second time.",
  ].join("\n");
}


function receiptBinding(receipt, state) {
  const launch = state.runs.find(run => run.runId === receipt.runId && run.routineId === receipt.routineId && run.requestKey === receipt.requestDigest);
  const accountUuid = receipt.accountUuid ?? launch?.accountUuid;
  const environmentId = receipt.environment?.id ?? launch?.environmentId;
  return accountUuid && environmentId ? {accountUuid, environmentId} : null;
}

/** Scope canonical probes to the measured account and environment, retaining verifiably owned legacy receipts. */
export function boundProbeReceipt(file, lanes, state, env) {
  const pin = state.environmentPin;
  if (!canonicalProbe(lanes)) return file;
  if (!pin) throw new Error("Capability validation requires a verified account and environment pin; run cloud-worker.mjs pin, then check");
  if (existsSync(file)) {
    const old = receiptBinding(regularJson(file), state);
    if (old?.accountUuid === pin.accountUuid && old.environmentId === env.id) return file;
  }
  return file + "." + digest(pin.accountUuid + "\0" + env.id) + ".json";
}

/** Keep one exact validation request and its account reservation coherent through launch, poll and import. */
export async function executeCloudValidation({ file, digest, request, env, lanes, laneKeys, home, ledger, currentAccount, signal, remote, timeoutMs,
  start, poll, archiveProblem, mark, parse, endedDetail, artifactReader, onReport }) {
  const state = ledger();
  const pin = state.environmentPin;
  const account = pin?.accountUuid ?? "unbound-validation";
  file = boundProbeReceipt(file, lanes, state, env);
  const verifyAccount = () => {
    if (!pin) {
      if (ledger().environmentPin) throw new Error("validation account was pinned during admission; retry the exact request");
      return;
    }
    const problem = checkEnvironmentPin(env, pin, currentAccount({home}));
    if (problem) throw problem;
    const latest = ledger().environmentPin;
    if (latest?.accountUuid !== pin.accountUuid || latest?.environmentId !== pin.environmentId) throw new Error("validation account or environment changed during admission");
  };
  verifyAccount();
  const enter = (action) => withCloudValidationAdmission({ home, account, key: digest, receipt: file, signal,
    metadata: { commit: request.commit, environment: env, laneKeys, ...(request.cloudProof ? { proof: cloudcheckProofIdentity(request.commit, digest) } : {}) }, timeoutMs,
    recover: async entry => {
      const disposition = recoverValidationReservation(entry,{ledger:ledger(),remote});
      if (disposition !== "unknown" && existsSync(entry.receipt)) {
        await restoreValidationRun(home,entry,regularJson(entry.receipt),timeoutMs);
      }
      return disposition;
    } }, action);
  return withValidationReportLock(file, () => enter(async ({ launching }) => {
    verifyAccount();
    let started;
    if (existsSync(file)) {
      started = regularJson(file);
      if (started.requestDigest !== digest) throw new Error("validation receipt belongs to another request; refusing replay");
      const owner = receiptBinding(started, ledger());
      if ((pin || owner || requiredCloudEnvironment(lanes).length) && (!pin || owner?.accountUuid !== pin.accountUuid || owner.environmentId !== env.id)) {
        throw new Error("validation receipt account or environment differs from the current verified pin");
      }
      if (TERMINAL.has(started.status) && started.status !== "completed") throw new Error(`cloud validation already ended: ${endedDetail(started)}`);
      if (canonicalProbe(lanes) && started.status === "completed" && started.validationReport &&
          !(Date.parse(started.startedAt) >= Date.now()-PROOF_MAX_MS)) {
        renameSync(file,file+".previous");
        started = undefined;
      }
    }
    if (!started) {
      started = await start((launch,requirements) => {
        // The provider builds this binding under its routine lock. A repin while queued cannot move the run.
        if (pin ? launch?.accountUuid !== pin.accountUuid || launch?.environmentId !== env.id : launch?.accountUuid !== undefined) {
          throw new Error("validation account or environment changed before launch");
        }
        return launching(launch,requirements);
      });
      started = { ...started, ...(pin ? {accountUuid: pin.accountUuid} : {}), requestDigest: digest, commit: request.commit, laneKeys };
      // The provider has acknowledged the run. Keep its nonce even if local persistence fails.
      try { writeAtomic(file, started); } catch (error) { error.launchUncertain = true; throw error; }
    }
    const finished = started.status === "completed" ? started : await poll(started);
    if (finished.status === "archived" && finished.sessionId && finished.initError === undefined) finished.initError = archiveProblem(finished.sessionId);
    writeAtomic(file, { ...finished, laneKeys });
    if (started.status !== finished.status) await mark(finished);
    if (finished.status !== "completed") throw new Error(`cloud validation ended ${endedDetail(finished)}`);
    let result = finished.validationReport;
    if (!result) {
      result = await parse(finished);
      await onReport(result, finished);
      writeAtomic(file, { ...finished, laneKeys, validationReport: result });
    }
    const artifact = result.artifact ? artifactReader(request, result.artifact) : null;
    return { ...result, ...(artifact ? { artifact } : {}), provider: "claude", taskId: finished.taskId,
      sessionId: finished.sessionId, wallMs: finished.wallMs, receipt: file, ...(finished.proof ? { proof: finished.proof } : {}) };
  }));
}
