# Prompt Overlays

Append-only amendments layered onto `plugins/code/prompts/prompt.md` (the
SSOT orchestrator prompt) at runtime. This directory exists so variants of
the base prompt do not require duplicating 500+ lines of identical
orchestration text.

## How assembly works

`plugins/code/scripts/setup-closedloop.sh` resolves `--prompt <name>` in
this order:

1. If `prompts/<name>.md` exists, use it directly (backward compatible).
2. Else if `prompts/overlays/<name>.overlay.md` exists, assemble
   `prompts/prompt.md` + blank line + overlay into
   `$CLOSEDLOOP_WORKDIR/.closedloop-ai/prompt-assembled.md` and point
   `CLOSEDLOOP_PROMPT_FILE` at that file.
3. Else, fail loud with "prompt not found".

The assembler is dumb concatenation — no frontmatter, no anchors, no
templating. If the overlay file exists, its bytes are appended verbatim.

Default behavior (`--prompt prompt`) is byte-identical to today: the base
is used directly with no overlay involved.

## When to use an overlay

If your variant only **adds** instructions that can be framed as
amendments to earlier phases, write an overlay. If you need to **change**
or **remove** base content, do not use an overlay — have a conversation
about forking or refactoring the base instead.

## Runtime contract — multi-repo overlay

The `multi-repo.overlay.md` overlay depends on env vars exported by
`setup-closedloop.sh` when `--add-dir` is passed to `run-loop.sh`:

- `CLOSEDLOOP_REPO_MAP` — pipe-separated `name=path` pairs of additional
  repositories.
- `CLOSEDLOOP_ADD_DIRS` — pipe-separated absolute paths of local peer
  repos.
- `CLOSEDLOOP_ADD_DIR_NAMES` — pipe-separated names matching
  `CLOSEDLOOP_ADD_DIRS` by index.

The overlay introduces the `@{repo-name}:path` file-reference convention
for secondary repos (primary-repo files need no prefix).

When `run-loop.sh --add-dir` is used without `--prompt`,
`setup-closedloop.sh` auto-selects the `multi-repo` overlay (see the
`PROMPT_NAME_EXPLICIT` branch in `setup-closedloop.sh`). `run-loop.sh`
itself performs no prompt resolution — it forwards `--add-dir` and
`--prompt` through the `/code:code` slash command, which invokes
`setup-closedloop.sh` as the single source of truth for overlay
selection.

## Debugging

- Inspect the assembled file at
  `$CLOSEDLOOP_WORKDIR/.closedloop-ai/prompt-assembled.md` after a run
  starts.
- To bypass the overlay, pass `--prompt prompt` — the base is used
  unchanged.
- If you see `ERROR: Prompt 'X' not found (no prompts/X.md, no
  prompts/overlays/X.overlay.md)`, the name you passed matches neither a
  direct base file nor an overlay.
