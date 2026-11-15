# Provider text for skills/fleet-orchestrator/references/setup.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: graph-everywhere -->
- `codex`, `node`, `jq` and `gh` (authenticated) on every machine that hosts sessions or checks, and this plugin installed for Codex and Claude on every machine that hosts writers, since every writer is a vibe session; the closedloop-graph MCP server (from the closedloop-core plugin) connected on every machine that runs the orchestrator or writers; `jq` also where codex-fleet-monitor runs. `fleet.sh ... session` reads the plugin version with `jq` on the orchestrating machine, and for a remote session runs `codex plugin list --json | jq` in the remote host's `REMOTE_SHELL`, so both must be on that shell's PATH; a missing `codex` there stops the command with exit 127 naming the host.
<!-- end: graph-everywhere -->

<!-- block: graph-check -->
5. On each machine, check closedloop-graph answers (its `sync_status` tool) from Claude Code and from Codex.
<!-- end: graph-check -->
