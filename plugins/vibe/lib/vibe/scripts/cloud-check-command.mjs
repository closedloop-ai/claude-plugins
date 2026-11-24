import { toolingRoot } from "./cloud-validation-recipes.mjs";
import { looksLikeCloudE2E, pnpmContainerLane, resolveCloudE2ELane } from "./cloud-validation-e2e.mjs";
import { resolveCloudFrozenLane } from "./cloud-validation-frozen.mjs";

const CHECK_ENTRY_POINT = /^(?:uv run |node |pnpm |ruff |pyright|pytest )/;
const SHELL_CONTROL = /[;&|`$<>\n]/;
const INLINE_SHELL = /^(?:node\s+(?:-[ep](?:\s|$)|--(?:eval|print)(?:[=\s]|$))|pnpm\s+(?:exec\s+)?(?:\S*\/)?(?:ba|z|da)?sh\s)/;
export const CLOUD_CAPABILITIES_LANE = "cloud-capabilities";
const PROBE = `${toolingRoot}/lib/vibe/scripts/cloud-capability-probe.mjs`;
const ELECTRON_SMOKE = `${toolingRoot}/lib/vibe/scripts/cloud-capability-electron.cjs`;
export const CLOUD_CAPABILITIES_COMMAND = `node ${PROBE}`;
const capabilityMention = (command) => /cloud-capability-(?:probe\.mjs|electron\.cjs)/.test(command);

/** Cloud validation accepts documented direct checks and committed workflow recipes, never shell control. */
export function isCheckCommand(command) {
  if (typeof command !== "string") return false;
  if (capabilityMention(command)) return command === CLOUD_CAPABILITIES_COMMAND;
  return CHECK_ENTRY_POINT.test(command) && !SHELL_CONTROL.test(command) && !INLINE_SHELL.test(command);
}

function capabilityProbe(lane, request, readCommitted, currentHead) {
  if (lane.name !== CLOUD_CAPABILITIES_LANE && !capabilityMention(lane.command ?? "")) return null;
  if (lane.name !== CLOUD_CAPABILITIES_LANE || Object.keys(lane).some((key) => !["name", "command"].includes(key))
    || (lane.command !== undefined && lane.command !== CLOUD_CAPABILITIES_COMMAND)
    || String(request.repository ?? "").toLowerCase() !== "closedloop-ai/claude-plugins" || currentHead() !== request.commit) {
    throw new Error("CLOUD_CAPABILITY_UNAVAILABLE: use the exact cloud-capabilities lane and its fixed command on the pushed claude-plugins checkout; no caller arguments or steps");
  }
  for (const file of [PROBE, ELECTRON_SMOKE]) {
    try { readCommitted(file); }
    catch { throw new Error(`CLOUD_CAPABILITY_UNAVAILABLE: the exact proof commit does not contain ${file}`); }
  }
  return { name: lane.name, command: CLOUD_CAPABILITIES_COMMAND, capabilityProbe: true };
}

/** Resolve the direct validation lane allowlist and exact-commit prerequisites before routine creation. */
export function directValidationLanes(request, { readCommitted, currentHead }) {
  return request.lanes.map((lane) => {
    const probe = lane && capabilityProbe(lane, request, readCommitted, currentHead);
    if (probe) return probe;
    if (!/^[a-z0-9][a-z0-9:_-]*$/.test(lane?.name ?? "") || typeof lane.command !== "string" || lane.command.length > 1000) {
      throw new Error("each lane needs a name and a documented check entry point without shell control");
    }
    const cloudFrozen = resolveCloudFrozenLane(lane.command, request, { readCommitted, currentHead });
    if (cloudFrozen) return { name: lane.name, command: lane.command, cloudFrozen };
    const container = isCheckCommand(lane.command) && pnpmContainerLane(lane.command, readCommitted);
    if (container) return { name: lane.name, command: lane.command, cloudE2E: container, containerPnpm: true };
    const cloudE2E = resolveCloudE2ELane(lane.command, readCommitted);
    if (cloudE2E) return { name: lane.name, command: lane.command, cloudE2E };
    if (looksLikeCloudE2E(lane.command)) {
      throw new Error("Cloud E2E lanes need e2e/run-containerized.sh -- --list or the provider’s displayless Desktop spec command; run other E2E through the repository's hardware/CI route.");
    }
    if (!isCheckCommand(lane.command)) throw new Error("each lane needs a name and a documented check entry point without shell control");
    return { name: lane.name, command: lane.command };
  });
}
