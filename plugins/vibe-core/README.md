# vibe-core Plugin

The hooks behind vibe sessions, and every module those hooks run, released
apart from the `vibe` plugin.

## Why it is separate

Codex ties approval of a plugin's hooks to a hash of the whole plugin bundle.
While the hooks shipped inside `vibe`, every vibe release changed that bundle,
so Codex reported every vibe hook as modified and skipped them all until a
person approved them again. A vibe release that does not touch the hook code
now leaves this plugin, and Codex's approval of its hooks, unchanged.

## Installation

Claude Code installs `vibe-core` through the `vibe` plugin's dependency.
Codex installs no plugin dependency, so install it explicitly, then open Codex
once and approve vibe-core's hooks in /hooks:

```bash
codex plugin add vibe-core@closedloop-ai
```

Each vibe-core release asks for that approval again; a vibe release does not.
vibe's Codex preflight, its version check and the fleet writer launch check
each name the fix when vibe-core is missing or its hooks are not approved.

## Contents

- `hooks/hooks.json` registers one command per event: PreToolUse, PostToolUse,
  PreCompact, UserPromptSubmit and SessionStart (after a compaction). Each runs
  the guards routed to it in one process (`hooks/hook-dispatch.mjs`).
- `lib/<skill>/scripts/` holds the vibe skill modules those guards run, under
  the skill they serve. vibe loads them from here through
  `plugins/vibe/shared/vibe-core.mjs`; a command among them keeps a thin
  wrapper at its old vibe path.
- `shared/plugin-roots.mjs` finds a sibling plugin's install in a repository
  checkout, the Claude Code install and the Codex install. vibe carries a
  byte-identical copy so it can find vibe-core before loading anything from it.
- `shared/vibe-install.mjs` is how the guards read vibe's install (its
  version, skill definitions and scripts) as data. vibe-core never imports or
  runs a file from vibe's install.

The hooks do nothing when vibe is not installed, or while the installed vibe
still registers its own hooks (vibe 1.1.70 and older), so no guard runs twice.
