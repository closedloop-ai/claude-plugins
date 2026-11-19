# vibe-core Plugin

The hook registrations behind vibe sessions, released apart from the `vibe`
plugin so Codex's approval of them lasts across vibe releases.

## Why it is separate

Codex ties approval of a plugin's hooks to a hash of every file in the plugin.
vibe-core holds only a small loader, so a vibe release leaves that hash, and
the approval, unchanged.

## How it works

`hooks/hooks.json` registers one command per event. Each finds the `vibe` or
`vibe-generic` install the session uses and runs that install's guards
(`hooks/runtime.mjs` in vibe). Codex's approval covers the loader, not the
guard code it loads from vibe.

The hooks do nothing when vibe is not installed or is disabled, or while the
installed vibe still registers its own hooks. When vibe's guards cannot load,
nothing is refused: the work continues and the agent is told how to update
vibe.

## Installation

Claude Code installs `vibe-core` through the dependency of the `vibe` or
`vibe-generic` plugin.
Codex installs no plugin dependency, so install it explicitly, then approve
vibe-core's hooks: in the ChatGPT app, open Settings > Hooks > From Plugins,
choose vibe-core's entry, trust each of its hooks, then start a new session (in
the Codex CLI, run /hooks instead):

```bash
codex plugin add vibe-core@closedloop-ai
```

Each vibe-core release asks for that approval again; a vibe release does not.
