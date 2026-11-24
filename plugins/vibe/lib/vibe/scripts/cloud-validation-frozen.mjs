import { toolingRoot, recipeProvider } from "./cloud-validation-recipes.mjs";
const TOOL_REPOSITORY = "closedloop-ai/claude-plugins";
export const CLOUD_FROZEN_LAUNCHER = `${toolingRoot}/lib/vibe/scripts/cloud-frozen-render.mjs`;
export const CLOUD_FROZEN_GATE = `${toolingRoot}/skills/handoff/scripts/frozen-render-gate.mjs`;
const PROVIDER_MANIFEST = `${toolingRoot}/provider/provider.json`;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const COMMAND = /^node scripts\/frozen-render-gate\.mjs --repo \. --base ([0-9a-f]{40})(?: --workers ([1-4]))?$/;
const fail = (message) => new Error(`CLOUD_FROZEN_UNAVAILABLE: ${message}`);

const safeRef = (value) => typeof value === "string" && REF.test(value) &&
  value.split("/").every((segment) => segment && !segment.startsWith(".") && !segment.endsWith(".lock")) && !value.includes("..") && !value.endsWith(".");

/** Verify the only accepted cloud freeze input format before interpolating values into its argv. */
export function frozenApplicationInput(application) {
  if (!application || Object.keys(application).sort().join(",") !== "base,baseRef,head,headRef,repository"
    || !REPO.test(application.repository ?? "") || !safeRef(application.baseRef) || !safeRef(application.headRef)
    || !SHA.test(application.base ?? "") || !SHA.test(application.head ?? "")) {
    throw fail("frozenRender requires explicit application repository, baseRef and headRef, and their full base and head commits");
  }
  return { repository: application.repository, baseRef: application.baseRef, base: application.base,
    headRef: application.headRef, head: application.head };
}

/** Resolve only the documented gate on the exact proof tooling revision; no mutable plugin path is accepted. */
export function resolveCloudFrozenLane(command, request, { readCommitted, currentHead }) {
  if (typeof command !== "string") return null;
  if (command.includes("cloud-frozen-render.mjs")) throw fail("submit the documented gate lane instead of invoking its private launcher");
  if (!command.includes("frozen-render-gate.mjs")) return null;
  if (!recipeProvider) throw fail("this install does not carry a frozen-render recipe");
  const match = COMMAND.exec(command.startsWith(`node ${CLOUD_FROZEN_GATE} `)
    ? command.replace(`node ${CLOUD_FROZEN_GATE} `, "node scripts/frozen-render-gate.mjs ") : command);
  if (!match) throw fail("use node scripts/frozen-render-gate.mjs --repo . --base <full app commit> [--workers 1-4]; other paths and flags are unsupported");
  if (String(request.repository ?? "").toLowerCase() !== TOOL_REPOSITORY || !SHA.test(request.commit ?? "") || currentHead() !== request.commit) {
    throw fail("check out the exact pushed claude-plugins tooling commit and name it as the validation repository and commit");
  }
  const application = frozenApplicationInput(request.frozenRender);
  if (match[1] !== application.base) throw fail("the documented gate base differs from the pinned application base");
  for (const file of [CLOUD_FROZEN_LAUNCHER, CLOUD_FROZEN_GATE, PROVIDER_MANIFEST]) {
    try { readCommitted(file); }
    catch { throw fail(`the exact tooling commit does not contain ${file}`); }
  }
  const invocation = { tooling: request.commit, application, workers: Number(match[2] ?? 2) };
  return `node ${CLOUD_FROZEN_LAUNCHER} '${JSON.stringify(invocation)}'`;
}
