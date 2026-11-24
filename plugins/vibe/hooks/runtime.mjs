// The hook runtime vibe-core's loader calls (vibe-core hooks/vibe-runtime.mjs). For every hook event, vibe-core
// finds the vibe the session uses, imports this file from it, picks the highest contract both sides know, and calls
// runHook; this file then runs the same per-event dispatch the entry modules beside it run when started directly.
//
// Contract 1: runHook({ event, input, core, report }) where `event` is the hook event name ("PreToolUse",
// "PostToolUse", "PreCompact", "UserPromptSubmit", "SessionStart"), `input` the parsed stdin object, `core`
// { root, version, contract } of the calling vibe-core, and `report(line)` the stderr writer. It returns what the
// loader prints: a string as plain text (PreCompact's compaction instructions), an object as JSON, or null for
// nothing, as a promise. It never throws for a guard's failure (hook-dispatch.mjs runs each guard fail-open); an unknown event
// returns null. A change to that shape is a new contract number, added here beside the old one.

/** The hook contracts this vibe serves, oldest first. */
export const CONTRACTS = Object.freeze([1]);

// Each event loads only its own module graph, so a PostToolUse call never pays for PreToolUse's guards.
const DISPATCH = Object.freeze(Object.assign(Object.create(null), {
  PreToolUse: async () => (await import("./pre-tool-use.mjs")).preToolUse,
  PostToolUse: async () => (await import("./post-tool-use.mjs")).postToolUse,
  PreCompact: async () => { const { compactionInstructions } = await import("./context-guard.mjs"); return (input) => compactionInstructions(input); },
  UserPromptSubmit: async () => (await import("./user-prompt-submit.mjs")).userPromptSubmit,
  SessionStart: async () => (await import("./session-start.mjs")).sessionStart,
}));

/** Contract 1 output. Capable writers accept an optional afterOutput callback registration for pending receipts. */
export async function runHook({ event, input, report = (line) => process.stderr.write(`${line}\n`), afterOutput }) {
  const load = DISPATCH[event];
  return load ? (await load())(input ?? {}, report, afterOutput) ?? null : null;
}
