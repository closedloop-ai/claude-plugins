// Select and validate the local E2E execution tier recorded in
// vibe-pr-evidence.json. Repository-owned lane tooling supplies the probe;
// this module only applies its documented thresholds and operator override.
import { spawnSync } from "node:child_process";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

// The repository's containerized E2E recipe (the provider's `recipes.e2e`): the authenticated inputs its runner
// needs, its machine slot wrapper and that wrapper's old usage line, and its Desktop spec folder. A repository
// with none needs no identity and has no slot or Desktop tier.
export const e2eRecipe = () => providerDataOr(sessionBinding(), "recipes", "e2e", null);
export const requiredContainerIdentity = () => Object.freeze([...(e2eRecipe()?.containerIdentity ?? [])]);
export const NO_DISPLAYLESS_ELECTRON = "no supported displayless Linux Electron harness";
const CAPABILITY_KIND = "selected-runner-desktop-capability/v2";
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const CAPABILITY_SCRIPT = [
  "const cp=require('node:child_process');",
  "const head=cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();",
  "const linuxHarness=process.platform==='linux'&&['xvfb-run','dbus-run-session','gnome-keyring-daemon'].every(tool=>cp.spawnSync('sh',['-c','command -v '+tool],{stdio:'ignore'}).status===0);",
  `console.log(JSON.stringify({kind:'${CAPABILITY_KIND}',head,worktree:process.cwd(),platform:process.platform,linuxHarness}));`,
].join("");
// The commit reaches a regular expression and the remote shell, so only a full SHA is accepted.
const SHA = /^[0-9a-f]{40}$/;

/** Re-probe the selected remote runner through its supported login-shell route. */
function runSelectedRemoteProbe({ host, command }) {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host,
    `zsh -lic ${shellQuote(command)}`], { encoding: "utf8", timeout: 60_000, maxBuffer: 2_000_000 });
  return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A caller-authored hash is only integrity metadata; the actual selected runner must execute now. */
function remoteDesktopProbe(capability, commit, runProbe = runSelectedRemoteProbe) {
  const recipe = e2eRecipe();
  const remote = capability.remote;
  const harness = remote?.desktopHarness;
  const host = remote?.runnerHost;
  const worktree = remote?.runnerWorktree;
  const owner = remote?.probeOwner;
  if (!SHA.test(commit ?? "") || typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)
    || typeof worktree !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(worktree)
    || worktree.split("/").includes("..")
    || typeof owner !== "string" || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(owner)
    || typeof remote?.command !== "string"
    || !recipe?.slotCommand || !remote.command.includes(recipe.slotCommand)
    || !new RegExp(`(?:^|\\s)--head\\s+${commit}(?:\\s|$)`).test(remote.command)
    || harness?.probedCommit !== commit) return null;
  const prefix = `cd ${shellQuote(worktree)} && test "$PWD" = ${shellQuote(worktree)}`
    + ` && test "$(git rev-parse HEAD)" = ${commit}`
    + ` && ${recipe.slotCommand} --head ${commit}`;
  const request = nativeDesktop => ({ host, head: commit, worktree, owner,
    selectedTier: "C", runnerCommand: remote.command, nativeDesktop,
    command: `${prefix}${nativeDesktop ? " --native-desktop" : ""} ${owner} node -e ${shellQuote(CAPABILITY_SCRIPT)}` });
  try {
    const native = runProbe(request(true));
    // Executing the read-only command through native Desktop is behavioral
    // proof of a supported route, regardless of how its shell source is written.
    if (native?.exitCode === 0) return null;
    if (native?.exitCode !== 2 || typeof native.output !== "string"
      || !recipe.slotUsage || !native.output.split("\n").includes(recipe.slotUsage) || native.output.includes("[--native-desktop]")) return null;
    const generic = runProbe(request(false));
    if (generic?.exitCode !== 0 || typeof generic.output !== "string") return null;
    const reports = generic.output.split(/\r?\n/).flatMap(line => {
      try { const parsed = JSON.parse(line); return parsed?.kind === CAPABILITY_KIND ? [parsed] : []; }
      catch { return []; }
    });
    const report = reports.length === 1 ? reports[0] : null;
    return report?.head === commit && report.worktree === worktree
      && ["darwin", "linux"].includes(report.platform) && report.linuxHarness === false
      ? report : null;
  } catch { return null; }
}

/** Return the strongest available E2E tier, or null when CI must cover it. */
export function selectE2eTier(capability = {}) {
  const container = capability.container ?? {};
  const finite = (...values) => values.every(Number.isFinite);
  const containerReady = container.dockerPresent === true && container.dockerReachable === true
    && finite(container.memoryGiB, container.diskGiB, container.minimumMemoryGiB, container.minimumDiskGiB)
    && container.memoryGiB >= container.minimumMemoryGiB && container.diskGiB >= container.minimumDiskGiB;
  if (containerReady) return { tier: "A", reason: "the repository capability probe passed" };
  if (capability.native?.available === true && capability.native?.forbidden !== true) {
    return { tier: "B", reason: "the container probe failed and native headless E2E is allowed" };
  }
  if (capability.remote?.available === true) return { tier: "C", reason: "a configured remote runner is available" };
  return { tier: null, reason: "no permitted local or remote E2E tier is available" };
}

/**
 * Why one spec cannot execute on the selected runtime tier. Runtime presence
 * (Docker, memory and disk) is distinct from the secrets or display harness
 * that an authenticated scenario consumes. Returns null when execution is
 * possible or the claimed limitation has no complete probe evidence.
 */
export function specExecutionLimitation(capability, spec, commit, runProbe) {
  if (!capability || capability.selectedTier !== selectE2eTier(capability).tier) return null;
  if (capability.selectedTier === null) return { tier: null, kind: "no-tier" };
  if (!["A", "C"].includes(capability.selectedTier) || !SHA.test(commit ?? "") || capability.probedCommit !== commit
    || typeof capability.container?.command !== "string" || !capability.container.command.trim()) return null;
  if (capability.selectedTier === "C" && (typeof capability.remote?.command !== "string"
    || !new RegExp(`(?:^|\\s)--head\\s+${commit}(?:\\s|$)`).test(capability.remote.command)
    || typeof capability.remote?.source !== "string" || !capability.remote.source.trim())) return null;
  const desktopHarness = capability.selectedTier === "C" ? capability.remote?.desktopHarness : capability.desktopHarness;
  const desktopSpecs = e2eRecipe()?.desktopSpecs;
  if (desktopSpecs && spec.startsWith(desktopSpecs) && desktopHarness?.available === false
    && desktopHarness.reason === NO_DISPLAYLESS_ELECTRON
    && (capability.selectedTier !== "C" || desktopHarness.probedCommit === commit)
    && typeof desktopHarness.probe === "string" && desktopHarness.probe.trim()) {
    if (capability.selectedTier === "C" && !remoteDesktopProbe(capability, commit, runProbe)) return null;
    return { tier: capability.selectedTier, kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON };
  }
  if (capability.selectedTier !== "A") return null;
  const container = capability.container;
  const secrets = container?.secretsSet;
  if (container?.runnable !== false || !secrets || !requiredContainerIdentity().every((key) => typeof secrets[key] === "boolean")) return null;
  const missingPrerequisites = requiredContainerIdentity().filter((key) => secrets[key] === false);
  if (missingPrerequisites.length === 0 || typeof container.notRunnableReason !== "string"
    || !missingPrerequisites.every((key) => container.notRunnableReason.includes(key))) return null;
  return { tier: "A", kind: "missing-prerequisites", missingPrerequisites };
}

/** Problems in the recorded capability probe and chosen tier. */
export function tierEvidenceProblems(capability, e2eSpecs = [], runProbe) {
  if (!capability || typeof capability !== "object") return ["E2E capability probe and tier are missing"];
  const problems = [];
  const container = capability.container ?? {};
  for (const key of ["dockerPresent", "dockerReachable", "memoryGiB", "diskGiB", "minimumMemoryGiB", "minimumDiskGiB", "command"]) {
    if (container[key] === undefined || container[key] === "") problems.push(`E2E container probe is missing ${key}`);
  }
  const expected = selectE2eTier(capability).tier;
  if ((capability.selectedTier ?? null) !== expected) {
    problems.push(`E2E tier ${capability.selectedTier ?? "none"} does not match selected tier ${expected ?? "none"}`);
  }
  if (expected === "B") {
    if (capability.native?.headless !== true || capability.native?.localStack !== true) problems.push("native E2E must be headless against the local stack");
    if (capability.native?.retries !== 0) problems.push("native E2E must run with retries off");
    if (capability.native?.quarantineExcluded !== true) problems.push("native E2E must record the CI quarantine exclusion");
    if (!capability.native?.sandboxIdentity && !capability.native?.sandboxIdentityNotRequired) {
      problems.push("native E2E must name the CI sandbox identity or why the repository needs none");
    }
    const visual = e2eSpecs.filter((spec) => /visual[-_.]?regression|screenshots?/i.test(spec));
    const held = new Set(capability.notRunLocally ?? []);
    for (const spec of visual.filter((spec) => !held.has(spec))) {
      problems.push(`${spec}: visual-regression coverage must be listed as not run locally, covered by CI`);
    }
    if (visual.length > 0 && (!Array.isArray(capability.ciCoverage) || capability.ciCoverage.length === 0)) problems.push("native visual-regression gaps need the CI job that covers them");
  }
  if (capability.native?.forbidden === true && !capability.native?.forbiddenSource) problems.push("the native E2E operator override needs its configured source");
  if (expected === "C" && !capability.remote?.command) problems.push("remote E2E tier needs its configured runner command");
  if (expected === null && e2eSpecs.length > 0) {
    const unavailable = new Set(capability.unavailableSpecs ?? []);
    for (const spec of e2eSpecs.filter((spec) => !unavailable.has(spec))) problems.push(`${spec}: unavailable E2E spec is not left explicitly for CI`);
    if (!Array.isArray(capability.ciCoverage) || capability.ciCoverage.length === 0) problems.push("unavailable E2E needs the CI jobs that cover it");
  }
  if (["A", "C"].includes(expected) && Array.isArray(capability.unavailableSpecs)) {
    for (const spec of e2eSpecs.filter((file) => capability.unavailableSpecs.includes(file))) {
      if (!specExecutionLimitation(capability, spec, capability.probedCommit, runProbe)) {
        problems.push(`${spec}: Tier ${expected} is selected but no exact prerequisite or displayless limitation proves it cannot run`);
      }
    }
  }
  return problems;
}
