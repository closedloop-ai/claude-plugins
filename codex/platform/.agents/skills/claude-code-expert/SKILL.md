---
name: claude-code-expert
description: This skill should be used when working with Claude Code infrastructure including agents, skills, slash commands, hooks, plugins, settings.json, or CLAUDE.md files. Triggers on YAML frontmatter, .claude/ directory files, Task tool configuration, or hook debugging. Do NOT use for creating NEW skills from scratch - use claude-creator instead.
---

# Claude Code Expert

Comprehensive quick-reference for Claude Code extensibility. For detailed examples, see the reference files linked at the end.

## When to Use

- Updating existing skills, agents, slash commands, or plugins
- Creating new agents, slash commands, or plugins (NOT new skills)
- Debugging hook configurations or integration issues
- Reviewing Claude Code file formats for correctness

**Do NOT use for:** Creating NEW skills from scratch (use `claude-creator` instead), general coding tasks, or CI/CD unrelated to Claude Code.

## Core Concepts

### The Four Extension Types

| Type | Invocation | Purpose | Location |
|------|------------|---------|----------|
| **Skills** | Auto (model-invoked) | Persistent context/knowledge | `~/.claude/skills/`, `.claude/skills/`, `<plugin>/skills/` |
| **Agents** | Explicit (`@agent-name`) | Multi-step workflows | `.claude/agents/`, `<plugin>/agents/` |
| **Commands** | User (`/command`) | Saved prompts/shortcuts | `~/.claude/commands/`, `.claude/commands/`, `<plugin>/commands/` |
| **Plugins** | Package | Bundled distribution | `.claude-plugin/plugin.json` |

### Decision Framework

1. **Should Claude remember X automatically?** → Skill
2. **Should Claude follow workflow Y step-by-step?** → Agent
3. **Do users need shortcut to Z?** → Command
4. **Should setup be shared/distributed?** → Plugin

## File Formats Quick Reference

### Skill Frontmatter

```yaml
---
name: skill-name                          # Required: lowercase, hyphens, max 64 chars
description: This skill should be used when [triggers]. It provides [capabilities].  # Required: max 1024 chars
allowed-tools: Read, Grep, Glob           # Optional: tool restrictions
context: fork                             # Optional: run in forked sub-agent
agent: my-agent                           # Optional: use agent's config
hooks:                                    # Optional: component-scoped hooks
  PreToolUse: [...]
  PostToolUse: [...]
  Stop: [...]
---
```

Skills hot-reload when modified. See [references/skill-triggers.md](references/skill-triggers.md) for trigger optimization.

### Agent Frontmatter

```yaml
---
name: agent-name                          # Required: kebab-case, match filename
description: What agent does and when to use it.  # Required
model: opus                               # Optional: sonnet, opus, haiku
color: blue                               # Optional: visual identifier
tools: Read, Grep, Glob, Bash             # Optional: tool restrictions
hooks:                                    # Optional: component-scoped hooks
  PreToolUse: [...]
  PostToolUse: [...]
  Stop: [...]
---
```

Disable agents: `"disallowed-tools": ["Task(agent-name)"]` in settings.json.

### Command Frontmatter

```yaml
---
description: Brief description for autocomplete  # Optional
argument-hint: [file] [options]           # Optional: shown in picker
model: opus                               # Optional: override model
allowed-tools: Bash(git *), Read, Grep    # Optional: tool restrictions
disable-model-invocation: false           # Optional: prevent Skill tool calling
hooks:                                    # Optional: component-scoped hooks
  PreToolUse: [...]
  Stop: [...]
---
```

**Special syntax:** `$ARGUMENTS`, `$1`/`$2`, inline bash with exclamation prefix (requires `allowed-tools`), `@path/file`

See [references/command-patterns.md](references/command-patterns.md) for patterns and examples.

### Plugin Manifest

```json
{
  "name": "plugin-name",
  "description": "What this plugin provides",
  "version": "1.0.0",
  "author": "Author Name"
}
```

## Hooks Quick Reference

**Locations:** `settings.json` (global) or frontmatter (component-scoped)

| Hook | Timing | Frontmatter | settings.json |
|------|--------|-------------|---------------|
| `PreToolUse` | Before tool runs | ✅ | ✅ |
| `PostToolUse` | After tool completes | ✅ | ✅ |
| `Stop` | When component/agent finishes | ✅ | ✅ |
| `UserPromptSubmit` | When user sends message | ❌ | ✅ |
| `PermissionRequest` | When permission requested | ❌ | ✅ |
| `SessionStart` | Session starts/resumes | ❌ | ✅ |
| `SessionEnd` | Session ends | ❌ | ✅ |
| `SubagentStart/Stop` | Subagent lifecycle | ❌ | ✅ |
| `Notification` | Notification sent | ❌ | ✅ |
| `PreCompact` | Before context compact | ❌ | ✅ |

**Matcher patterns:** `Bash(git commit:*)`, `Write(*.py)`, `Edit(src/**/*.ts)`, `mcp__server_*`, `*`

**Hook options:** `matcher`, `command`, `once` (run only once per session)

See [references/hook-recipes.md](references/hook-recipes.md) for complete schemas and recipes.

## Settings & CLI

**Location:** `.claude/settings.json` or `~/.claude/settings.json`

| Setting | Description |
|---------|-------------|
| `agent` | Use agent's system prompt, tools, model for main thread |
| `language` | Response language (e.g., "japanese") |
| `disallowed-tools` | Disable tools: `Task(AgentName)`, `mcp__server_*` |

**CLI flags:** `--agent`, `--tools`, `--disable-slash-commands`, `--session-id`, `--system-prompt`

## CLAUDE.md & Rules

**CLAUDE.md:** Project root or `~/.claude/CLAUDE.md`. Keep concise (always loaded).

**Rules directory:** `.claude/rules/*.md` - modular alternative to single CLAUDE.md.

## Writing Style

**CRITICAL:** Use imperative/infinitive form, not second person.

| ✅ Correct | ❌ Incorrect |
|-----------|-------------|
| "Identify candidate files..." | "You should identify..." |
| "Extract data from..." | "You can extract..." |

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Skill not triggering | Vague description, >1024 chars | Add specific trigger keywords |
| Hook not executing | Not executable, wrong path | `chmod +x`, use relative path from root |
| Agent not found | Name mismatch, wrong location | Match `name` to filename, check `.claude/agents/` |
| Inline bash not working | Missing `allowed-tools` | Add `allowed-tools: Bash(...)` to frontmatter |

## Validation Checklist

- [ ] YAML frontmatter has required fields (`name`, `description`)
- [ ] Names: kebab-case for agents, lowercase-hyphens for skills
- [ ] Descriptions include trigger conditions (for skills)
- [ ] Imperative writing style throughout
- [ ] File locations correct for component type
- [ ] Hook scripts executable (`chmod +x`)

## References

- [references/skill-triggers.md](references/skill-triggers.md) - Skill triggers, body structure, frontmatter
- [references/agent-patterns.md](references/agent-patterns.md) - Agent body structure, frontmatter, patterns
- [references/command-patterns.md](references/command-patterns.md) - Command patterns, TodoWrite usage
- [references/hook-recipes.md](references/hook-recipes.md) - Hook schemas, recipes, debugging
- [references/configuration.md](references/configuration.md) - CLAUDE.md, rules, settings, CLI, background agents
