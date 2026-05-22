# Codex Conversion of ClosedLoop Plugins

This directory contains the **Codex CLI** ports of the six Claude Code plugins
shipped from `plugins/`. The contents here are generated artifacts: the
authoritative source is `plugins/`, and everything under `codex/` is produced
by running a conversion tool against that source.

If you change a plugin, edit it under `plugins/` and **re-run the conversion**.
Do not hand-edit files in `codex/` — they will be overwritten on the next run.

## Source of Truth

| Side | Format | Location |
|---|---|---|
| Claude Code | Markdown + YAML frontmatter | `plugins/<plugin>/` |
| Codex CLI | TOML agents + Markdown skills | `codex/<plugin>/` |

## Conversion Tool

Conversion is performed by [`@disdjj/acplugin`](https://github.com/closedloop-ai/acplugin) — an open-source CLI that walks a Claude Code plugin and emits Codex / OpenCode / Cursor / Antigravity equivalents.

### Install

```bash
npm install -g @disdjj/acplugin
# or one-shot:
npx @disdjj/acplugin convert . --to codex
```

### Regenerate this directory

From the repo root:

```bash
# All plugins, no prompts, output into codex/
for p in bootstrap code code-review judges platform self-learning; do
  npx @disdjj/acplugin convert "plugins/$p" --to codex -o "codex/$p"
done
```

Useful flags:

- `--to codex` — target the Codex CLI format (other targets: `opencode`, `cursor`, `antigravity`)
- `--all` — convert every plugin without interactive prompts
- `-o, --output <path>` — explicit output directory
- `--dry-run` — preview without writing
- `--path <subpath>` — restrict conversion to a sub-path inside the source

Interactive mode (TUI wizard): run `acplugin` with no args.

## Installing the Codex Marketplace

The converted plugins can be installed through a Codex marketplace. The current
`codex-marketplace` CLI expects GitHub repository identifiers, not local
filesystem paths.

To install all plugins from this repo's Codex marketplace:

```bash
npx codex-marketplace add closedloop-ai/claude-plugins/codex --plugins
```

Choose the install scope explicitly when you do not want the interactive prompt:

```bash
# Install for the current project only.
npx codex-marketplace add closedloop-ai/claude-plugins/codex --plugins --project

# Install for the current user.
npx codex-marketplace add closedloop-ai/claude-plugins/codex --plugins --global
```

The marketplace registry for this conversion lives at
`codex/.agents/plugins/marketplace.json`. Keep each marketplace entry's
`source.path` aligned with the directory layout you publish. This repo keeps
converted plugins directly under `codex/<plugin>`, so entries point at
`./<plugin>` from the marketplace root.

## Installing Individual Plugins

Use the singular `--plugin` flag when installing one plugin directly instead of
the whole marketplace:

```bash
npx codex-marketplace add closedloop-ai/claude-plugins/codex/code --plugin
npx codex-marketplace add closedloop-ai/claude-plugins/codex/code-review --plugin
npx codex-marketplace add closedloop-ai/claude-plugins/codex/platform --plugin
```

Scoped individual installs use the same shape:

```bash
npx codex-marketplace add closedloop-ai/claude-plugins/codex/code --plugin --project
npx codex-marketplace add closedloop-ai/claude-plugins/codex/code-review --plugin --project
```

Use `--plugins` only when the target contains a marketplace or plugin
collection. Use `--plugin` when the target directory is the plugin itself and
contains `.codex-plugin/plugin.json`.

## Mapping Rules

The conversion is deterministic. Every Claude artifact lands at a predictable
Codex path — these rules come straight from `acplugin`'s converter modules and
are also enforced by `codex/tests/test_conversion_coverage.py`.

| Claude source | Codex destination | Notes |
|---|---|---|
| `plugins/<p>/agents/<name>.md` | `codex/<p>/.codex/agents/<name>.toml` | YAML frontmatter → TOML keys; body → `developer_instructions` |
| `plugins/<p>/skills/<name>/SKILL.md` | `codex/<p>/.agents/skills/<name>/SKILL.md` | Aux files under `references/`, `scripts/`, `assets/` keep their relative paths |
| `plugins/<p>/commands/<name>.md` | `codex/<p>/.agents/skills/cmd-<name>/SKILL.md` | Commands become skills with a mandatory `cmd-` prefix |
| `plugins/<p>/.claude-plugin/plugin.json` | `codex/<p>/.codex-plugin/plugin.json` | Manifest is rewritten for Codex's plugin loader |
| Instructions + hooks | `codex/<p>/AGENTS.md` | Hooks are appended under a `# Hooks (from Claude Code)` section |
| MCP server config | `codex/<p>/.codex/config.toml` | Merged from `plugins/<p>/.mcp.json` |

### Agent frontmatter translation

The `agent.ts` converter maps the following YAML fields to TOML:

| YAML field | TOML field | Default |
|---|---|---|
| `name` | `name` | — |
| `description` | `description` | — |
| `model` | `model` (via `mapModel()`) | `gpt-5.4` |
| `tools` | drives `sandbox_mode` | `read-only` (or `workspace-write` if `Bash`/`Write`/`Edit` present) |
| `effort` | `model_reasoning_effort` | — |
| (body) | `developer_instructions` | — |

Files whose path contains `.hook-` are excluded from the Codex output —
hooks are surfaced through `AGENTS.md` rather than copied as standalone files.

## Validating the Conversion

Structural coverage tests live in `codex/tests/` and run in CI:

```bash
uv run pytest codex/
```

These tests assert that **every** Claude agent, skill, and command has a
corresponding Codex artifact under the rules above. They do not validate
content fidelity — only structural presence.

If you add a new agent/skill/command under `plugins/`, the test will fail
until you re-run the conversion to populate the Codex side.

## Directory Layout

```
codex/
├── README.md                          ← you are here
├── tests/
│   └── test_conversion_coverage.py    ← CI-enforced structural checks
├── <plugin>/
│   ├── .codex-plugin/plugin.json      ← Codex plugin manifest
│   ├── .codex/
│   │   ├── agents/*.toml              ← converted agents
│   │   └── config.toml                ← MCP servers (when applicable)
│   ├── .agents/
│   │   └── skills/<name>/SKILL.md     ← skills + cmd-* (converted commands)
│   └── AGENTS.md                      ← instructions + hooks
└── .agents/plugins/marketplace.json   ← cross-plugin registry
```

## Related Docs

- Source plugins: [`../plugins/`](../plugins/)
- Plugin authoring conventions: [`../CLAUDE.md`](../CLAUDE.md)
- Conversion tool: [closedloop-ai/acplugin](https://github.com/closedloop-ai/acplugin)
