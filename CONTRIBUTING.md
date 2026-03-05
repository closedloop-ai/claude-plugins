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
