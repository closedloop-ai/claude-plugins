# Contributing to ClosedLoop

We welcome contributions! This guide covers everything you need to get started.

## Getting Started

### Prerequisites

- Python 3.11+ (3.13 recommended)
- [jq](https://jqlang.github.io/jq/)
- [Claude Code](https://claude.ai/code) with the closedloop plugin installed

### Setup

```bash
# Fork on GitHub, then clone your fork
git clone git@github.com:YOUR_USERNAME/claude-plugins.git
cd claude-plugins
git remote add upstream git@github.com:closedloop-ai/claude-plugins.git

# Create virtual environment
python3.13 -m venv .venv
source .venv/bin/activate

# Install dev dependencies
pip install ruff pyright pytest

# Set up git hooks (required)
git config core.hooksPath .githooks
```

### Verify

```bash
source .venv/bin/activate

# Run tests
pytest plugins/

# Run linting
ruff check .

# Run type checking
pyright
```

## Development Workflow

All contributions come through forks. External contributors do not have push access to the main repository.

### Fork & Branch

1. [Fork](https://github.com/closedloop-ai/claude-plugins/fork) the repository on GitHub
2. Clone your fork and add the upstream remote:
   ```bash
   git clone git@github.com:YOUR_USERNAME/claude-plugins.git
   cd claude-plugins
   git remote add upstream git@github.com:closedloop-ai/claude-plugins.git
   ```
3. Create a feature branch from `main`:
   ```bash
   git fetch upstream
   git checkout -b feat/my-change upstream/main
   ```

### Branch Naming

- `feat/*` — New features or agents
- `fix/*` — Bug fixes
- `docs/*` — Documentation changes
- `refactor/*` — Code restructuring

### Keeping Your Fork Up to Date

```bash
git fetch upstream
git rebase upstream/main
```

### Pull Request Process

1. Push your branch to **your fork** (not the upstream repo)
2. Open a PR from your fork's branch to `closedloop-ai/claude-plugins:main`
3. Include a description of what changed and why
4. Update `CHANGELOG.md` in the affected plugin directory (enforced by pre-push hook when modifying `plugins/` files)
5. Address review feedback with additional commits (don't force-push during review)
6. A maintainer will squash merge to `main` after approval

## Design Philosophy

### Agent-First Development

- Each agent has a single, well-defined responsibility
- Agent descriptions are callable by the orchestrator — keep them precise
- Model selection: **opus** for creative/planning tasks, **sonnet** for implementation, **haiku** for lightweight coordination
- Skills encapsulate reusable instruction sets; prefer skills over duplicating instructions across agents

### Self-Learning Integration

- When adding new agents, consider what patterns should be captured
- The `learning-capture` agent looks for patterns tagged with context fields
- Contribute quality patterns via `/push-learnings` if they generalize across projects

### Minimal Surface Area

- Prefer extending existing agents over creating new ones
- Add hooks only when lifecycle integration genuinely improves outcomes
- Python tools should be standalone scripts with no internal dependencies

## Code Style

### Python

- **Ruff** for linting (config in `pyproject.toml`)
- **Pyright** for type checking
- All public functions typed with annotations
- Test every new Python tool with pytest

### Agent Definitions (Markdown)

- YAML frontmatter: `name`, `description`, `model`, `tools`, `skills` (only what's needed)
- System prompt: concise, role-first, constraint-driven
- No hallucinated tool calls in prompts — only tools listed in frontmatter
- Skill identifiers must include plugin-name prefix (e.g., `self-learning:toon-format`, not `toon-format`)

### TOON Format

- Use TOON for learning pattern files (`*.toon`)
- Follow syntax from the `self-learning:toon-format` skill
- ~40% token reduction vs JSON while maintaining lossless round-trip compatibility

## Testing Requirements

- **Python tools**: pytest with good coverage on new code
- **Agent changes**: manual smoke test with `/code` on a representative task
- **Hook changes**: test all 5 lifecycle events (`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`)

## Commit Standards

Use conventional commits:

```
feat(code): add visual-qa-subagent for screenshot review
fix(platform): correct fastapi-router-specialist tool list
docs(judges): update AGENTS.md with new judge
refactor(code): simplify plan-writer merge mode
```

Scopes: `bootstrap`, `code`, `code-review`, `judges`, `platform`, `self-learning`

## Creating Booster Packs

Booster packs are optional bundles of skills that extend the orchestration loop with specialist workflows. They live under `boosters/<name>/` and are activated with `--booster <name>`.

### Directory Structure

```
boosters/
  <name>/
    booster.json        # manifest (required)
    skills/
      <skill-name>.md   # one file per skill (required if referenced in manifest)
  registry.json         # global booster registry
```

Naming conventions:
- Use lowercase kebab-case for the booster directory name and skill names (e.g., `my-booster`, `verify-state`)
- The directory name must match the `name` field in `booster.json` and the `name` field in `registry.json`

### `booster.json` Manifest Schema

Every booster must include a `booster.json` at `boosters/<name>/booster.json`:

```json
{
  "name": "my-booster",
  "version": "1.0.0",
  "description": "Short description of what the booster provides.",
  "skills": [
    {
      "name": "my-skill",
      "path": "skills/my-skill.md",
      "description": "What this skill does and when it is invoked.",
      "requiresBrowser": false
    }
  ]
}
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Booster identifier (matches directory name and registry entry) |
| `version` | string | Semver version string (e.g., `"1.0.0"`) |
| `description` | string | Human-readable summary of the booster's purpose |
| `skills` | array | List of skill objects (may be empty `[]`) |

Each entry in `skills` requires:

| Field | Type | Description |
|---|---|---|
| `name` | string | Skill identifier used when referencing the skill |
| `path` | string | Relative path from the booster directory to the skill Markdown file |
| `description` | string | What the skill does and when it is used |
| `requiresBrowser` | boolean | `true` if the skill needs Playwright / a headless browser |

### Registering in `boosters/registry.json`

After creating the booster directory and manifest, add an entry to `boosters/registry.json`:

```json
{
  "boosters": [
    {
      "name": "my-booster",
      "description": "One-line summary shown to users when listing available boosters.",
      "manifestPath": "boosters/my-booster/booster.json",
      "featureFlag": "my-booster-pack"
    }
  ]
}
```

Required fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Must match the `name` in `booster.json` and the directory name |
| `description` | string | User-facing description (shown in marketplace / help output) |
| `manifestPath` | string | Relative path from the repo root to `booster.json` |
| `featureFlag` | string | Identifier used to gate the booster behind a feature flag |

### Testing a New Booster

Pass `--booster <name>` when invoking the runner to verify that your skills are injected correctly:

```bash
# Smoke-test skill injection with your booster active
claude -p "describe what you can do" --booster my-booster
```

Confirm that the skills listed in `booster.json` appear in the agent's available skill set before opening a PR.

## Plugin Version Management

When modifying agents, skills, hooks, commands, or any file under `plugins/{plugin-name}/`:

1. **Update the version** in the plugin's manifest file:
   - `plugins/code/.claude-plugin/plugin.json`
   - `plugins/code-review/.claude-plugin/plugin.json`
   - `plugins/judges/.claude-plugin/plugin.json`
   - `plugins/self-learning/.claude-plugin/plugin.json`
   - `plugins/platform/.claude-plugin/plugin.json`

2. **Follow semantic versioning** (MAJOR.MINOR.PATCH):
   - **PATCH**: Bug fixes, wording corrections in agent prompts
   - **MINOR**: New agents, skills, commands, hooks; backward-compatible changes
   - **MAJOR**: Breaking changes to orchestration flow, hook API, or skill interface

3. **Update `CHANGELOG.md`** in the affected plugin directory (required by pre-push hook)

4. After merging, users must run `/plugin marketplace update closedloop && /exit` to reload
