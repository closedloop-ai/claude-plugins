# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A monorepo of open-source Claude Code plugins by ClosedLoop. Six plugins — `bootstrap`, `code`, `code-review`, `judges`, `platform`, `self-learning` — each under `plugins/<name>/` with a standard layout: `.claude-plugin/plugin.json`, `agents/`, `commands/`, `skills/`, `hooks/`, `tools/python/`, `scripts/`.

## Commands

```bash
# Setup
python3.13 -m venv .venv && source .venv/bin/activate
pip install ruff pyright pytest
git config core.hooksPath .githooks

# Testing
pytest plugins/                          # all tests
pytest plugins/code/tools/python/        # single plugin's tests
pytest plugins/code/tools/python/test_count_tokens.py -k test_name  # single test

# Linting & type checking (match CI exactly — local-pyright vs uv-run-pyright
# divergence can mask reportOptionalMemberAccess and similar diagnostics)
uv run ruff check .
uv run pyright

# TypeScript tool scripts (toolchain lives at tools/design-inventory; bundles committed into plugin)
cd tools/design-inventory
npm ci             # once
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # rebuild committed dist/*.mjs (written to plugins/code/skills/design-inventory/scripts/dist/)
```

## Architecture

### Plugin Structure

Each plugin's manifest lives at `plugins/<name>/.claude-plugin/plugin.json` with `name`, `description`, `version`, and `author` fields. The `.claude-plugin/marketplace.json` at repo root registers all six plugins.

### Agent Definitions

Markdown files with YAML frontmatter specifying `name`, `description`, `model`, `tools`, and `skills`. Model selection convention: **opus** for creative/planning, **sonnet** for implementation, **haiku** for lightweight coordination. Only reference tools listed in frontmatter — no hallucinated tool calls.

### Skill Identifiers

Always use `plugin-name:skill-name` format (e.g., `self-learning:learning-quality`, not `learning-quality`).

### The `code` Plugin is the Hub

`code` depends on both `judges` and `self-learning`. `judges` depends back on `code` (circular). `bootstrap` depends on `code`. `code-review`, `platform`, and `self-learning` are standalone. See `docs/dependencies.md` for the full dependency map.

### Closed Loop (run-loop.sh)

The core orchestration loop in `plugins/code/scripts/run-loop.sh`. Drives fresh-context Claude iterations — each `claude -p` invocation gets a clean context window. The orchestrator prompt at `plugins/code/prompts/prompt.md` coordinates 8 workflow phases via subagent delegation. Post-iteration, `run-loop.sh` runs an 11-step pipeline calling Python scripts from `self-learning/tools/python/`. Multi-repo behavior lives in the agents themselves (`pre-explorer`, `plan-draft-writer`, `cross-repo-coordinator`, `cross-repo-prd-writer`), which read `CLOSEDLOOP_REPO_MAP`, `CLOSEDLOOP_ADD_DIRS`, and the `local` flag on peers — no orchestrator-level branching is required.

### Hooks

Registered in `plugins/code/hooks/hooks.json` across 5 lifecycle events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`. `SubagentStart` injects environment variables and relevant learning patterns. `SubagentStop` logs outcomes and telemetry. `PreToolUse` fires on `Read|Bash|Write|Edit` for just-in-time pattern injection.

### TOON Format

Token-Oriented Object Notation — ~40% token reduction vs JSON, used for `org-patterns.toon` learning store. See the `self-learning:toon-format` skill for syntax rules.

### Tool Scripts (TypeScript policy)

**Team policy: no new Python.** New tool scripts are TypeScript; existing Python tools remain until ported. The reference TS toolchain lives at `tools/design-inventory/`: strict `tsconfig` (`noUncheckedIndexedAccess`), sources in `src/` with co-located vitest suites (`*.test.ts`), esbuild-bundled CLIs committed under the owning plugin at `plugins/code/skills/design-inventory/scripts/dist/*.mjs` so consumers need only Node 18+ (runtime deps like fflate are bundled; prefer node stdlib). After editing sources run `npm run build` from `tools/design-inventory` and commit `dist/` — CI fails on stale bundles. CLI entries use `parseArgs` + the shared `runWhenMain` helper; shared wire-format contracts live in a schema module (`design-findings-schema.ts`) that tool scripts may import but which never calls into a tool script.

**Plugin payload rule (official-repo pattern): plugins ship ONLY runtime payload.** A plugin directory must NEVER contain `package.json`, `package-lock.json`, `node_modules/`, or TypeScript sources — the plugin installer runs `npm install` when it finds a `package.json` plus lockfile anywhere inside the plugin tree, which dumps a large `node_modules` into every user's plugin cache. Dev toolchains (sources, tests, lockfiles, `node_modules`) live OUTSIDE the plugin tree (e.g. `tools/<name>/`); only the committed build output (e.g. `dist/*.mjs`) lives inside the plugin.

### Python Tools (legacy)

Existing tool scripts in `plugins/<name>/tools/python/` are standalone CLIs — they do not import each other. The one exception is a **shared schema/library module** that defines wire-format contracts (e.g. `plugins/code-review/tools/python/code_review_schema.py`): tool scripts within the same plugin may import canonical types, constants, and validators from such a module. The shared module itself must not call into any tool script. Tests are co-located (`test_*.py`); shared test factories belong in `conftest.py`. Do not add new Python tools; port opportunistically when touching an area.

## Conventions

### Commits

All commits MUST follow the conventions in `CONTRIBUTING.md`. Specifically:

- Use conventional commit format: `type(scope): description`
- Valid types: `feat`, `fix`, `docs`, `refactor`
- Valid scopes: `bootstrap`, `code`, `code-review`, `judges`, `platform`, `self-learning`
- Examples: `feat(code): add visual-qa-subagent`, `fix(platform): correct tool list`

### Version Bumps (Required)

**Any branch that changes a plugin's files MUST bump that plugin's `plugin.json` version exactly ONCE relative to `main`.** Bump once per branch/PR, not once per commit: pick the right semver level for the branch's overall change and keep it for the life of the branch (CI compares base vs HEAD). Semver rules: PATCH for bug fixes/prompt wording, MINOR for new agents/skills/commands, MAJOR for breaking changes to orchestration/hook API/skill interfaces.

### Documentation (CHANGELOG.md, README.md)

**Do NOT manually edit `CHANGELOG.md` or `README.md`.** After all code changes are finalized, run `/update-documentation` to generate documentation updates. The `.githooks/pre-push` hook blocks pushes that modify files under `plugins/` without a `CHANGELOG.md` update, so always run `/update-documentation` before pushing. The CHANGELOG lives at the **repo root** (`CHANGELOG.md`), NOT inside individual plugin directories. Never create `plugins/<name>/CHANGELOG.md`.

### Branching

`feat/*`, `fix/*`, `docs/*`, `refactor/*` from `main`.

## Learned Patterns

### Testing
- **[mistake]**: Extract test helpers (data factories, env setup, assertion helpers) into shared modules (`conftest.py`, `test_helpers.sh`) when used by 2+ test files — never inline logic that a helper already provides. (context: tests|duplication|helpers)
- **[mistake]**: When adding a test alongside existing sibling tests, match their assertion coverage (cleanup checks, side-effect assertions) and env-var isolation (clear ambient env vars that could leak into assertions). (context: tests|isolation|assertions)

### Code Quality
- **[mistake]**: When modifying behavior, audit adjacent comments and docstrings for accuracy — remove or update references to non-existent files, incomplete field lists, or scope descriptions narrower than actual behavior. (context: comments|docstrings|accuracy)
- **[mistake]**: Before adding helper logic, grep for adjacent helpers with the same responsibility and delegate instead of duplicating membership checks or fixture factories. (context: duplication|helpers|tests|shell)
- **[mistake]**: When narrowing an `Any`-typed value with `isinstance`, bind it to a local first; calling the source twice in one expression (e.g. `d.get(k) if isinstance(d.get(k), dict) else {}`) makes pyright treat the two calls as separate evaluations so the narrowing doesn't carry to downstream `.get()` accesses — `reportOptionalMemberAccess` fires under stricter CI pyright settings even when local pyright misses it. (context: pyright|narrowing|ci-divergence)

### Orchestration & State
- **[mistake]**: When changing run-loop or self-learning resume/rate-limit logic, preserve persisted state contracts: iteration rows, session IDs, success counts, and terminal statuses. (context: run-loop|resume|state|rate-limit)

### Correctness & Data Invariants
- **[mistake]**: Guard boundary data before narrowing filters or status checks; failed reads, malformed entries, and defaulted fields can invert success/failure handling. (context: invariants|filters|error-handling)

### Documentation & Versioning
- **[mistake]**: Never hand-write CHANGELOG entries for plugin changes; when reviewing generated release notes, verify the version heading matches `plugin.json` and every `Fixed`/`Replaces` claim maps to behavior that existed before the PR. (context: changelog|versioning|hallucination|verification)
