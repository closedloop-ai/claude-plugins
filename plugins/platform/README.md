# Platform Plugin

The Platform plugin provides foundational skills for working with the ClosedLoop/Claude Code ecosystem. It bundles five skills covering Claude Code extensibility knowledge, prompt engineering best practices, diagram visualization, artifact upload workflows, and skill creation scaffolding.

## Key Features

- **Claude Code expert guidance**: Comprehensive quick-reference for building and maintaining skills, agents, slash commands, hooks, and plugins, including file format specifications, validation checklists, and a decision framework for choosing extension types.
- **Context engineering**: Distilled Anthropic prompt engineering documentation covering nine techniques—from basic clarity to extended thinking—with prioritized guidance on when to apply each.
- **Mermaid visualization**: Generates clear, effective Mermaid diagrams for system architectures, control flows, data flows, state machines, sequence diagrams, and entity relationships directly in markdown.
- **Artifact upload**: Automates uploading files to the ClosedLoop platform as typed artifacts (PRD, implementation plan, or template) using either a direct-API script or MCP fallback.
- **Skill creation**: Scaffolds new skill directories with proper structure, generates SKILL.md templates with frontmatter, and guides through a five-step creation process from understanding use cases through iteration.

## Architecture Overview

```
plugins/platform/
├── .claude-plugin/
│   └── plugin.json                    # Plugin manifest
└── skills/
    ├── claude-code-expert/
    │   ├── skill.md                   # Main skill definition
    │   └── references/
    │       ├── agent-patterns.md      # Agent body structure, types, patterns
    │       ├── command-patterns.md    # Slash command patterns and anti-patterns
    │       ├── configuration.md       # CLAUDE.md, settings, CLI, env vars
    │       ├── hook-recipes.md        # Hook schemas, I/O, 14 ready-made recipes
    │       ├── skill-triggers.md      # Skill trigger optimization and frontmatter
    │       └── sub-agents-config.schema.json  # JSON Schema for agent frontmatter
    ├── context-engineering/
    │   ├── skill.md                   # Main skill definition
    │   └── references/
    │       ├── chain-of-thought.md    # CoT implementation levels and examples
    │       ├── extended-thinking.md   # Extended thinking mode guidance
    │       ├── long-context.md        # 200K-token context window patterns
    │       └── xml-tags.md            # XML structuring patterns for prompts
    ├── mermaid-visualizer/
    │   ├── SKILL.md                   # Main skill definition
    │   └── references/
    │       └── mermaid-syntax.md      # Complete Mermaid syntax reference
    ├── upload-artifact/
    │   ├── SKILL.md                   # Main skill definition
    │   └── scripts/
    │       └── upload_artifact.py     # Python MCP client for direct API uploads
    └── claude-creator/
        ├── SKILL.md                   # Main skill definition
        └── scripts/
            ├── init_skill.py          # Skill directory scaffolding script
            ├── package_skill.py       # Skill packaging script
            └── quick_validate.py      # Skill validation script
```

All five are **skills** (not agents or commands), meaning Claude invokes them automatically based on conversation context without any explicit user invocation.

## Skills

### claude-code-expert

**Trigger conditions**: Working with Claude Code infrastructure — agents, skills, slash commands, hooks, plugins, `settings.json`, or `CLAUDE.md` files. Also triggered when debugging YAML frontmatter, files in `.claude/` directories, or hook configurations.

**Not for**: Creating new skills from scratch (use a dedicated creator skill instead), general coding tasks, or CI/CD unrelated to Claude Code.

**What it provides**:

- The four Claude Code extension types (Skills, Agents, Commands, Plugins) with a decision framework for choosing between them.
- YAML frontmatter quick-reference for skill, agent, command, and plugin manifests.
- A hook type table covering all ten hook events, their availability in frontmatter vs. `settings.json`, and matcher pattern syntax.
- Settings and CLI flag reference.
- CLAUDE.md and rules directory guidance.
- Writing style requirements (imperative/infinitive form, not second person).
- Common issues table and a validation checklist.

**References**:

| File | Contents |
|------|----------|
| `references/agent-patterns.md` | Recommended agent body structure (Inputs/Outputs/Method/Constraints), frontmatter field reference, agent types (read-only, write-enabled, specialized), disabling agents, invocation patterns, common patterns (discovery, review, implementation) |
| `references/command-patterns.md` | Command anatomy with full frontmatter, eight command patterns (TodoWrite for multi-step, argument handling, validation, output declaration, focused single-purpose, error recovery, hooks as guardrails, composable commands), anti-patterns, and a decision tree for Command vs Skill vs Agent |
| `references/configuration.md` | CLAUDE.md format and loading behavior, rules directory structure, full `settings.json` reference, CLI flags, environment variables (including hook-specific variables), and background agent control |
| `references/hook-recipes.md` | Complete hook configuration structure, hook types (command and prompt), matcher syntax, exit code semantics, per-event I/O schemas (PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, Stop, SessionStart, SessionEnd, Notification, PreCompact), and 14 ready-to-use recipes |
| `references/skill-triggers.md` | How skill triggering works, description anatomy, good vs. bad description examples, trigger pattern types (WHEN/WHEN NOT, keyword enumeration, file pattern), common trigger failures, testing strategy, description length guidelines, skill hierarchy, and full frontmatter reference |
| `references/sub-agents-config.schema.json` | JSON Schema (draft-07) for validating agent frontmatter YAML, covering `name`, `description`, `tools`, `skills`, `model`, `permissionMode`, and `color` |

---

### context-engineering

**Trigger conditions**: Designing prompts, system prompts, or context windows for Claude. Triggered when writing prompts for API calls, designing agent instructions, structuring complex inputs, optimizing context for accuracy, adding few-shot examples, or implementing chain-of-thought reasoning.

**What it provides**:

Nine prompting techniques prioritized by effectiveness, with actionable guidance and examples for each:

| Priority | Technique | Best For |
|----------|-----------|----------|
| 1 | Be clear and direct | All tasks |
| 2 | Multishot examples | Format consistency, complex patterns |
| 3 | Chain of thought | Math, logic, multi-step analysis |
| 4 | XML tags | Multi-part prompts, structured I/O |
| 5 | Role prompting | Domain expertise, tone adjustment |
| 6 | Prefill response | Output format control |
| 7 | Chain prompts | Multi-step workflows, error isolation |
| 8 | Long context tips | Documents over 20K tokens |
| 9 | Extended thinking | Complex STEM, constraint optimization |

**References**:

| File | Contents |
|------|----------|
| `references/chain-of-thought.md` | Three CoT implementation levels (basic, guided, structured with tags), worked financial advisor example, debugging with CoT, combining CoT with examples and role prompting |
| `references/extended-thinking.md` | What extended thinking is and when to use it, token budget guidance, prompting best practices (general instructions first, multishot with thinking tags, self-verification), use case examples (STEM, constraint optimization, analytical frameworks), what to avoid |
| `references/long-context.md` | Three core principles for 200K-token contexts (data at top, XML document structure, grounding in quotes), document indexing pattern, citation pattern, chunking strategy, performance tips table, common pitfalls |
| `references/xml-tags.md` | Why XML tags work, tag naming conventions, best practices (consistency, nesting, combining with other techniques), document processing pattern, output structuring, common patterns (task + context + data, instructions + examples + input, role + task + constraints) |

---

### mermaid-visualizer

**Trigger conditions**: When a user asks to explain a complex idea, concept, or system architecture, or when a diagram would help visualize control flows, system architectures, data flows, state machines, sequence diagrams, or entity relationships.

**What it provides**:

A comprehensive guide for creating Mermaid diagrams embedded in markdown. Covers six diagram types with syntax reference and best practices:

| Diagram Type | Best For |
|---|---|
| Flowcharts | Decision trees, process flows, control flows |
| Sequence Diagrams | Component/system interactions over time |
| State Diagrams | State transitions and triggers |
| Class Diagrams | Object-oriented relationships and hierarchies |
| Entity Relationship Diagrams | Database schemas and data relationships |
| System Architecture Diagrams | Component relationships and service interactions |

**References**:

| File | Contents |
|------|----------|
| `references/mermaid-syntax.md` | Complete Mermaid syntax reference: node syntax (rectangular, diamond, rounded, stadium), edge syntax (solid, dotted, thick arrows with labels), prohibited symbols and safe alternatives, all six diagram types with examples, and 10 best practices for clarity |

---

### upload-artifact

**Trigger conditions**: Any of the following phrases or intentions — "upload artifact", "upload PRD", "upload implementation plan", "create artifact from file", "save as artifact", "push to closedloop", "new artifact version", "test artifact upload", "verify artifact content", "upload to project".

**What it provides**:

A two-mode workflow for uploading file content to the ClosedLoop platform as a typed artifact:

**Script mode** (preferred when `CLOSEDLOOP_API_KEY` is available in the shell environment): Runs `skills/upload-artifact/scripts/upload_artifact.py` via `uv`, which connects directly to the MCP server over Streamable HTTP without loading file content into the conversation context. Supports creating new artifacts and new versions of existing artifacts.

**MCP fallback** (when no API key is configured): Uses Claude Code's existing MCP authentication to call `mcp__closedloop__create-artifact` or `mcp__closedloop__create-artifact-version` directly. File content is loaded into conversation context in this mode.

Both modes follow the same five-step workflow: resolve credentials and choose mode, list projects, collect remaining parameters (file path, title, type), upload, and report results.

**Artifact types**: `PRD`, `IMPLEMENTATION_PLAN`, `TEMPLATE`

**Script parameters**:

| Flag | Required | Description |
|------|----------|-------------|
| `--url` | No | MCP server URL (default: `http://localhost:3010/mcp`) |
| `--api-key` | Yes | ClosedLoop API key (`sk_live_...`) |
| `--list-projects` | No | List projects and exit |
| `--file` | Upload | Path to content file |
| `--title` | Create | Artifact title |
| `--type` | Create | `PRD`, `IMPLEMENTATION_PLAN`, or `TEMPLATE` |
| `--project-id` | No | Project association |
| `--workstream-id` | No | Workstream association |
| `--artifact-id` | Version | Existing artifact ID for new version |
| `--verify` | No | Fetch artifact back after upload and compare content lengths |

### claude-creator

**Trigger conditions**: When a user wants to create a new skill from scratch — triggered by "create a skill", "new skill", or "scaffold skill". Not for updating existing skills (use claude-code-expert instead).

**What it provides**:

A five-step skill creation process:

| Step | Purpose |
|------|---------|
| 1. Understanding | Gather concrete usage examples and trigger patterns |
| 2. Planning | Identify reusable scripts, references, and assets |
| 3. Initializing | Scaffold directory via `scripts/init_skill.py` |
| 4. Editing | Write SKILL.md and bundled resources |
| 5. Iterating | Test and refine based on real usage |

Covers skill anatomy (SKILL.md frontmatter, scripts/, references/, assets/), the progressive disclosure design principle (metadata → SKILL.md → bundled resources), writing effective descriptions with trigger terms, and the 500-line SKILL.md guideline.

**Scripts**:

| Script | Purpose |
|--------|---------|
| `scripts/init_skill.py` | Scaffolds a new skill directory with SKILL.md template and example resource directories |
| `scripts/package_skill.py` | Packages a skill for distribution |
| `scripts/quick_validate.py` | Validates skill structure and frontmatter |

---

## Usage

### Installing the Plugin

Add the plugin to your Claude Code installation following the standard plugin installation process. Once installed, all five skills activate automatically when the conversation context matches their trigger conditions — no slash command or explicit invocation is required.

### Using claude-code-expert

The skill activates when you discuss Claude Code extension types or work with files in `.claude/` directories. Example triggers:

- "How do I write a skill that auto-triggers when working on Python files?"
- "What frontmatter fields does an agent definition support?"
- "My hook isn't executing — how do I debug it?"
- "What's the difference between a skill and a command?"

### Using context-engineering

The skill activates when you work on prompts or system prompts for Claude. Example triggers:

- "Help me write a system prompt for a customer support agent."
- "How should I structure this multi-document prompt?"
- "My prompt gives inconsistent output formats — what technique should I use?"
- "When should I use extended thinking vs. chain of thought?"

### Using upload-artifact

The skill activates on explicit upload requests. Example triggers:

- "Upload `/tmp/my-prd.md` as a PRD to the ClosedLoop project."
- "Save this implementation plan as an artifact."
- "Create a new version of artifact `art_abc123` from `plan-v2.md`."

For script mode, ensure `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` are set in the shell environment. For MCP fallback, ensure the ClosedLoop MCP server is configured in Claude Code's MCP settings.
