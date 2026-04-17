# Repository Guidelines

## Project Structure & Module Organization
This repository is a plugin monorepo under `plugins/`.

- `plugins/code`, `plugins/code-review`, `plugins/judges`, `plugins/bootstrap`, `plugins/platform`, `plugins/self-learning`
- Each plugin typically contains `.claude-plugin/` (manifest), `agents/`, `commands/`, `skills/`, `tools/`, `prompts/`, `scripts/`, `schemas/`, and plugin-specific docs or resources.
- Shared docs are in `docs/` (glossary, dependency map), and repository-wide guidance is in `README.md`, `CONTRIBUTING.md`, and `CHANGELOG.md`.
- Plugin Python code/tests live under plugin subdirectories, e.g. `plugins/code/tools/python/` and `plugins/code-review/tools/python/`.

## Build, Test, and Development Commands
- `python3.13 -m venv .venv && source .venv/bin/activate`  
  Create an isolated environment for local development.
- `pip install ruff pyright pytest`  
  Install core developer tooling.
- `pip install -r plugins/code/tools/python/requirements.txt -r plugins/self-learning/tools/python/requirements.txt`  
  Install runtime dependencies used by Python tools.
- `git config core.hooksPath .githooks`  
  Enable repo hooks (required for contributor checks).
- `./plugins/code/scripts/install-dependencies.sh`  
  Install system/Python dependencies used by the `code` and `self-learning` toolchain.
- `ruff check .`  
  Lint repository Python-style issues.
- `pyright`  
  Run static type checks.
- `pytest plugins/`  
  Run all test modules (e.g., `test_amend_state.py`, `test_code_review_helpers.py`).

## Coding Style & Naming Conventions
- Python: 4-space indentation, explicit type annotations for public APIs.
- Test files use `test_<name>.py`; functions use `snake_case`.
- Plugin artifacts are explicit and frontmatter-driven (`agents`, `commands`, `skills` definitions in Markdown).
- Use existing conventions in each plugin; avoid changing naming style in adjacent files (for example, slash command names and agent IDs remain kebab-case, e.g. `code-review`).

## Testing Guidelines
- Framework: `pytest`.
- Test files should live with their implementation area and follow `test_*.py`.
- Command examples:  
  - `pytest plugins/self-learning/tools/python/`  
  - `pytest plugins/code/tools/python/`  
  - `pytest plugins/code-review/tools/python/`
- Keep PRs focused and include targeted test runs for changed plugin paths.

## Commit & Pull Request Guidelines
- Follow conventional commits (`feat(code): ...`, `fix(platform): ...`) and preserve repo scope style (`AI-####:` style tags are present in history).
- Use the repository `.gitmessage` template for all new commits and amended commit messages.
- Recommended branches: `feat/*`, `fix/*`, `docs/*`, `refactor/*`.
- PR workflow: fork, create topic branch from `main`, rebase onto upstream, then open PR from your fork.
- PR description should include purpose, affected plugins/files, and exact commands run.
- Update relevant changelog entries before pushing plugin edits (`.githooks/pre-push` enforces this expectation).

## Security & Configuration Tips
- Keep secrets and keys out of version control (`.env`, tokens, credentials).
- The stack expects Python 3.11+ (3.13 recommended) and `jq`; `CLOSEDLOOP_*` environment/config values are used by agent workflows.
- Prefer absolute plugin paths when invoking scripts in docs or debug sessions to avoid workspace ambiguity.
