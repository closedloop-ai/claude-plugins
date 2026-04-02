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

# Linting & type checking
ruff check .
pyright
```

## Architecture

### Plugin Structure

Each plugin's manifest lives at `plugins/<name>/.claude-plugin/plugin.json` with `name`, `description`, `version`, and `author` fields. The `.claude-plugin/marketplace.json` at repo root registers all six plugins.

### Agent Definitions

Markdown files with YAML frontmatter specifying `name`, `description`, `model`, `tools`, and `skills`. Model selection convention: **opus** for creative/planning, **sonnet** for implementation, **haiku** for lightweight coordination. Only reference tools listed in frontmatter — no hallucinated tool calls.

### Skill Identifiers

Always use `plugin-name:skill-name` format (e.g., `self-learning:learning-quality`, not `learning-quality`).

### The `code` Plugin is the Hub

`code` depends on both `judges` and `self-learning`. `judges` depends back on `code` (circular). `code-review` depends on `code` and `judges`. `bootstrap` depends on `code`. `platform` and `self-learning` are standalone. See `docs/dependencies.md` for the full dependency map.

### Closed Loop (run-loop.sh)

The core orchestration loop in `plugins/code/scripts/run-loop.sh`. Drives fresh-context Claude iterations — each `claude -p` invocation gets a clean context window. The orchestrator prompt at `plugins/code/prompts/prompt.md` coordinates 8 workflow phases via subagent delegation. Post-iteration, `run-loop.sh` runs an 11-step pipeline calling Python scripts from `self-learning/tools/python/`.

### Hooks

Registered in `plugins/code/hooks/hooks.json` across 5 lifecycle events: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`. `SubagentStart` injects environment variables and relevant learning patterns. `SubagentStop` logs outcomes and telemetry. `PreToolUse` fires on `Read|Bash|Write|Edit` for just-in-time pattern injection.

### TOON Format

Token-Oriented Object Notation — ~40% token reduction vs JSON, used for `org-patterns.toon` learning store. See the `self-learning:toon-format` skill for syntax rules.

### Python Tools

Standalone scripts with no cross-tool imports within a plugin. Each lives in `plugins/<name>/tools/python/`. Tests are co-located (`test_*.py`).

## Conventions

### Commits

All commits MUST follow the conventions in `CONTRIBUTING.md`. Specifically:

- Use conventional commit format: `type(scope): description`
- Valid types: `feat`, `fix`, `docs`, `refactor`
- Valid scopes: `bootstrap`, `code`, `code-review`, `judges`, `platform`, `self-learning`
- Examples: `feat(code): add visual-qa-subagent`, `fix(platform): correct tool list`

### Version Bumps (Required)

**Any change to a plugin's files MUST include a version bump in that plugin's `plugin.json`.** This is not optional -- the version must be updated in the same commit as the code change. Semver rules: PATCH for bug fixes/prompt wording, MINOR for new agents/skills/commands, MAJOR for breaking changes to orchestration/hook API/skill interfaces.

### Documentation (CHANGELOG.md, README.md)

**Do NOT manually edit `CHANGELOG.md` or `README.md`.** After all code changes are finalized, run `/update-documentation` to generate documentation updates. The `.githooks/pre-push` hook blocks pushes that modify files under `plugins/` without a `CHANGELOG.md` update, so always run `/update-documentation` before pushing. The CHANGELOG lives at the **repo root** (`CHANGELOG.md`), NOT inside individual plugin directories. Never create `plugins/<name>/CHANGELOG.md`.

### Branching

`feat/*`, `fix/*`, `docs/*`, `refactor/*` from `main`.
