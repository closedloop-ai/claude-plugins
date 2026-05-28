# Repo-level scripts

Standalone tooling for working with the claude-plugins monorepo. These scripts live outside `plugins/` and are explicitly excluded from `/update-documentation` and the root `CHANGELOG.md` (per the path-mapping rules in `.claude/commands/update-documentation.md`). Documentation for them lives here, manually maintained alongside the source.

| Script | Purpose |
|---|---|
| [`test-local-plugins.sh`](./test-local-plugins.sh) | Smoke-test locally-modified Claude Code plugins against the marketplace-installed versions. |

---

## `test-local-plugins.sh`

Smoke-test harness for plugin changes on the current branch — without manually fiddling with the marketplace cache, hand-rolling synthetic hook payloads, or burning Claude tokens on a multi-iteration loop.

### What it does

For every plugin changed on the current branch vs. the diff base (default: `origin/main`, with a best-effort `git fetch` first to avoid stale local mains):

1. **Redirects the marketplace cache to local source.** Backs up `~/.claude/plugins/cache/<owner>/<plugin>/<version>` to a `.bak-test-local-plugins` sibling and replaces it with a symlink to `plugins/<plugin>` so all `${CLAUDE_PLUGIN_ROOT}/...` paths in slash-commands and scripts resolve to local files. A sidecar `.test-local-plugins.prev` records prior state (`dir|<backup-path>` or `link|<old-target>`) so `--revert` restores cleanly even when the original was already a symlink to a different worktree.
2. **Runs the plugin's own test suites** if present: `hooks/tests/*.sh` and `pytest tools/python/`. If Python tests exist but `pytest` is unavailable, the Python test step is skipped with an explicit message.
3. **Smoke-tests each slash command** in `commands/`. Bootstrap commands (those whose body kicks off via a `!`-bash directive) get their bootstrap script executed against a tmp workdir; orchestrator commands (those that take over the running session as an orchestrator) and file-level commands (e.g. `/code:cancel-code`) are flagged as deferred to a fresh Claude Code session.
4. **If the plugin ships pre/post-tool-use hooks following the closedloop perf-event contract** — i.e. writes per-tool-call sentinels to `$WORKDIR/.tool-calls/<id>` and emits `tool` / `skill` / `spawn` events to `$WORKDIR/perf.jsonl` — runs synthetic hook payloads (`Bash`, `Skill` via `tool_input.skill`, `Skill` via `tool_input.command` fallback, `Agent`, and a failed `Read`) and dumps the emitted events. Asserts the fallback skill_name path fired and that all sentinels in `.tool-calls/` are cleaned up after the post-hook ran.

   This step is **specific to the `code` plugin's hook contract.** Other plugins shipping hooks with a different contract will hit false-negative noise here and should either narrow the harness or write their own hook tests.

### Out of scope

- **PRD / plan / spec-conformance checking.** A test harness shouldn't be in the business of scraping markdown for required-field lists — that couples it to a PRD writing convention and silently degrades when the convention drifts. Spec conformance belongs in a separate tool. Use the printed `perf.jsonl` events from step 4 as input to whatever spec checker you prefer.
- **Multi-iteration loop runs.** `/code:code` and similar are driven externally by `run-loop.sh` spawning fresh `claude -p` subprocesses; the script only verifies the bootstrap line runs cleanly.
- **Generic plugin-hook contracts.** The synthetic-payload assertions in step 4 are written against the closedloop perf-event contract; they're not a generic plugin-hook tester.

### Why a script instead of asking Claude

The discovery + symlink + synthetic-payload steps are deterministic — no LLM reasoning required. Running them as a shell script is faster, cheaper, and reproducible across CI and local. What the script can't fully exercise (multi-iteration loop runs, subagent-driven orchestration that needs Claude's Task tool) it explicitly defers and tells you to drive in a fresh Claude Code session after the symlink is in place.

### Constraints

1. **Hook scripts register at Claude Code session startup.** Even after the script symlinks the cache to local, any new hooks added by the branch will not register in your already-running Claude Code session. The synthetic-payload tests cover the hook script's emission logic; full hook-registration verification needs a fresh session.
2. **The cache stays redirected after the script exits.** This is intentional — the redirect needs to persist so you can restart Claude Code and get a session that loads the local hooks. The script prints a loud banner at the end of every run listing exactly which marketplace paths point at local source, plus the exact `--revert` command to restore them. Don't forget to revert when you're done.
3. **Don't run state-mutating commands in the worktree's own cwd.** The script uses `/tmp/test-local-plugins-$$/` for synthetic test workspaces.
4. **Interrupted and failed runs preserve their temp directory.** The log paths printed in failures remain inspectable after `Ctrl+C`, `SIGTERM`, or a failed check.

### Usage

```sh
# Test all plugins changed vs origin/main
scripts/test-local-plugins.sh

# Test only one plugin
scripts/test-local-plugins.sh --plugin code

# Diff against a different base (always resolved as origin/<base> first,
# falls back to local <base> with a warning if origin isn't reachable)
scripts/test-local-plugins.sh --base release/1.0

# Different marketplace owner
scripts/test-local-plugins.sh --owner my-org

# Run from outside the repo
scripts/test-local-plugins.sh --repo-root /path/to/checkout

# Verbose output (includes failed-bootstrap log heads)
scripts/test-local-plugins.sh --verbose

# Undo all symlinks created by a prior run
scripts/test-local-plugins.sh --revert
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All checks passed (or `--revert` succeeded). |
| 1 | At least one check failed (e.g. plugin test suite failed, hook emission empty, sentinel left behind, or `--plugin <name>` didn't resolve to an installed plugin). |
| 2 | Environment problem: missing `jq` / `python3` / `git`, no `~/.claude/plugins/installed_plugins.json`, or no `plugins/` directory. |

### Requirements

- `bash` 4+ (or `bash` 3.2 with the array idioms used here — tested on macOS default `bash`).
- `jq`, `python3`, `git` on `PATH`.
- `pytest` on `PATH` via `python3 -m pytest` to run plugin Python tests; otherwise those tests are skipped. Install each plugin's `tools/python/requirements.txt` before running this harness when its tests need runtime dependencies.
- `~/.claude/plugins/installed_plugins.json` (i.e. the closedloop-ai marketplace must be installed at least once).
- A git checkout of the closedloop-ai monorepo, with `plugins/` at the repo root.

### Reverting

Each invocation creates two artifacts per redirected plugin:

- `<install_path>.bak-test-local-plugins/` — the original cache directory contents, OR
- `<install_path>.test-local-plugins.prev` — sidecar describing prior state when the original was already a symlink (so revert can re-create that symlink instead of trying to restore a non-existent backup).

`scripts/test-local-plugins.sh --revert` reads the sidecar and restores the prior state. If the symlink exists with no sidecar, revert refuses to remove it (it would orphan the cache) — manually inspect with `ls -la <install_path>` and remove by hand.

### Documentation maintenance

This README is manually maintained. It is intentionally outside the scope of `/update-documentation`, which only manages plugin-scoped sections in the root `CHANGELOG.md` and the per-plugin `plugins/<name>/README.md` files. When changing the script, update this README in the same commit. There is no per-script changelog — git history is the source of truth.
