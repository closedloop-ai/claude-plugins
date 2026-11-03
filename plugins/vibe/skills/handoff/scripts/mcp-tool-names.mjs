// Runtime-neutral MCP names for a recorded capability. Keep this payload-side
// adapter aligned with tools/vibe-workers/src/contracts.ts.
const NAME = /^mcp__[A-Za-z0-9_.:-]+__[A-Za-z0-9_-]+$/;

/** Canonical operation spelling shared by Claude and Codex aliases. */
export function mcpToolIdentity(name) {
  if (!NAME.test(name ?? "")) return null;
  const boundary = name.lastIndexOf("__");
  return `${name.slice(0, boundary)}__${name.slice(boundary + 2).replaceAll("-", "_")}`;
}

/** Concrete names a runtime may report for one capability. */
export function mcpToolAliases(name) {
  const identity = mcpToolIdentity(name);
  if (!identity) return [name];
  const boundary = identity.lastIndexOf("__");
  return [...new Set([name, identity, `${identity.slice(0, boundary)}__${identity.slice(boundary + 2).replaceAll("_", "-")}`])];
}

/** Exact graph aliases derived only from recorded read capabilities. */
export function graphAliases(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.some(capability => typeof capability?.name !== "string"
    || !["graph", "closedloop"].includes(capability.service) || !["read", "write"].includes(capability.access)
    || !mcpToolIdentity(capability.name))) throw new Error("capability record is malformed");
  return [...new Set(capabilities.filter(capability => capability.service === "graph" && capability.access === "read")
    .flatMap(capability => mcpToolAliases(capability.name)))];
}
