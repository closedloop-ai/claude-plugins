#!/usr/bin/env node
import { capturedJson } from "./captured-json.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadChromium } from "../../../skills/handoff/scripts/frozen-render.mjs";
import { emitFrozenVerdict, frozenGate } from "../../../skills/handoff/scripts/frozen-render-gate.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";
import { CLOUD_FROZEN_LAUNCHER, frozenApplicationInput } from "./cloud-validation-frozen.mjs";
import { optInPath, recipeProvider, toolingRoot } from "./cloud-validation-recipes.mjs";
import { bindForRepository, readContract, useLeadBinding } from "./provider.mjs";

const PREFLIGHT_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 600_000;

const fail = (message) => new Error(`CLOUD_FROZEN_UNAVAILABLE: ${message}`);

function exec(command, args, { cwd, timeout = SETUP_TIMEOUT_MS } = {}) {
  return execFileSync(command, args, { cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Prove the immutable tooling checkout and the exact two application refs before any dependency or browser command. */
export function frozenCloudCheckouts({ request, root, script, run = exec }) {
  const { tooling, workers } = request;
  const application = frozenApplicationInput(request.application);
  if (!/^[0-9a-f]{40}$/.test(tooling ?? "") || !Number.isSafeInteger(workers) || workers < 1 || workers > 4
    || script !== path.join(root, CLOUD_FROZEN_LAUNCHER) || run("git", ["rev-parse", "HEAD"], { cwd: root }) !== tooling
    || run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root })) {
    throw fail("run the committed launcher from the exact clean pushed claude-plugins tooling checkout");
  }
  const gitDir = run("git", ["rev-parse", "--absolute-git-dir"], { cwd: root });
  const work = mkdtempSync(path.join(gitDir, "vibe-cloud-frozen-"));
  const head = path.join(work, "application");
  const base = path.join(work, "base");
  mkdirSync(head);
  const git = (...args) => run("git", args, { cwd: head });
  git("init", "--quiet");
  try {
    git("fetch", "--no-tags", `https://github.com/${application.repository}.git`,
      `${application.baseRef}:refs/vibe-cloud/base`, `${application.headRef}:refs/vibe-cloud/head`);
  } catch {
    throw fail("could not fetch the pinned application refs with this cloud checkout's Git access");
  }
  if (git("rev-parse", "refs/vibe-cloud/base^{commit}") !== application.base
    || git("rev-parse", "refs/vibe-cloud/head^{commit}") !== application.head) {
    throw fail("an application ref no longer points to the requested exact base or head");
  }
  git("checkout", "--quiet", "--detach", application.head);
  git("worktree", "add", "--quiet", "--detach", base, application.base);
  for (const revision of [application.head, application.base]) {
    let file;
    try { file = git("show", `${revision}:${optInPath}`); }
    catch { throw fail("the application base and head must both commit the Vibe recipe opt-in"); }
    let provider;
    try { provider = capturedJson(file)?.provider; } catch { throw fail("the committed application recipe opt-in is not JSON"); }
    if (!recipeProvider || provider !== recipeProvider) throw fail("the committed application recipe provider is unsupported");
  }
  return { head, base, out: path.join(work, "results"), application, workers };
}

/** Use the bundled official recipe but grant no tracker, graph, or other connection capabilities to this run. */
export function cloudFrozenRecipeBinding(providerRoot, applicationRoot) {
  const contract = readContract(providerRoot);
  if (!recipeProvider || contract?.name !== recipeProvider) throw fail("the exact tooling commit does not contain the required provider recipe");
  const missing = Object.keys(contract.connections ?? {}).map((key) => `connection:${key}`);
  const binding = bindForRepository({ state: "bound", name: contract.name, root: providerRoot, capabilities: [], missing }, applicationRoot);
  if (!binding.capabilities.includes("recipes")) throw fail("the application does not opt in to the bundled Vibe recipe");
  return { ...binding, capabilities: ["recipes"] };
}

/** Run the exact committed gate after proving a real headless Chromium launch in the pinned application. */
export async function runCloudFrozen({ request, root, script, run = exec, launch = (repo, options) => loadChromium(repo).launch(options), gate = frozenGate }) {
  const inputs = frozenCloudCheckouts({ request, root, script, run });
  const providerRoot = path.join(root, toolingRoot, "provider");
  const headBinding = cloudFrozenRecipeBinding(providerRoot, inputs.head);
  cloudFrozenRecipeBinding(providerRoot, inputs.base);
  for (const dir of [inputs.head, inputs.base]) {
    try { run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir }); }
    catch { throw fail("application dependency installation failed with the committed lockfile"); }
    if (run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir })) {
      throw fail("application setup changed tracked inputs");
    }
  }
  try {
    run("pnpm", ["exec", "playwright", "install", "chromium"], { cwd: inputs.head, timeout: PREFLIGHT_TIMEOUT_MS });
    const probe = await launch(inputs.head, { headless: true, timeout: PREFLIGHT_TIMEOUT_MS });
    await probe.close();
  } catch { throw fail("the VM could not install or launch headless Chromium with the provisioned dependencies"); }
  useLeadBinding(headBinding);
  try {
    return await gate({ repo: inputs.head, base: inputs.application.base, baseDir: inputs.base, out: inputs.out,
      changeLog: path.join(path.dirname(inputs.out), "vibe-changes.md"), workers: inputs.workers });
  } finally { useLeadBinding(null); }
}

if (isEntryPoint(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw fail("one validated frozen lane request is required");
    const root = realpathSync(process.cwd());
    const script = realpathSync(fileURLToPath(import.meta.url));
    const result = await runCloudFrozen({ request: JSON.parse(process.argv[2]), root, script });
    process.exitCode = emitFrozenVerdict(result);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 78;
  }
}
