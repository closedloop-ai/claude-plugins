// The lead's provider binding as a writer brief carries it, so a writer works under the binding of the lead that
// briefed it. The Codex launcher (codex-session.mjs), the Claude launcher (claude-worker) and the Agent guard check it.

/** A writer brief: a Codex `$vibe` prompt or a Claude writer preamble that invokes `vibe:vibe`. */
export const WRITER_BRIEF = /^\s*\$vibe\b|\bInvoke vibe:vibe first\b|^\s*\/vibe:vibe\b/m;
const TRAILING_SPACE = /\s+$/;

/** The line a writer brief carries: the lead's own binding, `Provider: <name>` or `Provider: none`. */
export function providerLine(binding) {
  return `Provider: ${binding?.state === "bound" && binding.name ? binding.name : "none"}`;
}

/** The `Provider:` line a brief carries, trimmed, or null. */
export function briefProviderLine(prompt) {
  return String(prompt ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Provider:")) ?? null;
}

/**
 * Why a writer brief cannot start a writer under `binding` (the lead's): only a `Provider:` line naming another
 * binding. A brief with no such line inherits the lead's binding (`briefWithProviderLine`).
 */
export function briefProviderProblem(prompt, binding) {
  const named = briefProviderLine(prompt);
  if (!named) return null;
  const expected = providerLine(binding);
  return named === expected
    ? null
    : `the brief says "${named}" but this lead is bound as "${expected}"; a writer works under the lead's binding`;
}

/** `prompt` as the writer receives it: a writer brief with no `Provider:` line gains the lead's, so it inherits it. */
export function briefWithProviderLine(prompt, binding) {
  const text = String(prompt ?? "");
  if (briefProviderLine(text) || !WRITER_BRIEF.test(text)) return text;
  return `${text.replace(TRAILING_SPACE, "")}\n${providerLine(binding)}\n`;
}
