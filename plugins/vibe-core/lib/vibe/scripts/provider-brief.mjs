// The lead's provider binding as a writer brief carries it, so a writer works under the binding of the lead that
// briefed it. The Codex launcher (codex-session.mjs), the Claude launcher (claude-worker) and the Agent guard check it.

/** A writer brief: a Codex `$vibe` prompt or a Claude writer preamble that invokes `vibe:vibe`. */
export const WRITER_BRIEF = /^\s*\$vibe\b|\bInvoke vibe:vibe first\b|^\s*\/vibe:vibe\b/m;

/** The line a writer brief carries: the lead's own binding, `Provider: <name>` or `Provider: none`. */
export function providerLine(binding) {
  return `Provider: ${binding?.state === "bound" && binding.name ? binding.name : "none"}`;
}

/** The `Provider:` line a brief carries, trimmed, or null. */
export function briefProviderLine(prompt) {
  return String(prompt ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Provider:")) ?? null;
}

/**
 * Why a writer brief cannot start a writer under `binding` (the lead's): it must carry `providerLine(binding)` on
 * its own line. `required: false` checks only a line that is present, for a launch that is not always a fleet brief.
 */
export function briefProviderProblem(prompt, binding, { required = true } = {}) {
  const text = String(prompt ?? "");
  const named = briefProviderLine(text);
  if (!named && (!required || !WRITER_BRIEF.test(text))) return null;
  const expected = providerLine(binding);
  if (named === expected) return null;
  return named
    ? `the brief says "${named}" but this lead is bound as "${expected}"; a writer works under the lead's binding`
    : `a writer brief carries the lead's binding on its own line: "${expected}"`;
}
