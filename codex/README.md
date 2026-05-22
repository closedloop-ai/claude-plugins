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
| Codex CLI | TOML agents + Markdown skills | `codex/plugins/<plugin>/` |

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
# All plugins, no prompts, output into codex/plugins/
for p in bootstrap code code-review judges platform self-learning; do
  npx @disdjj/acplugin convert "plugins/$p" --to codex -o "codex/plugins/$p"
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

The converted plugins can be installed through a Codex marketplace. The
`codex-marketplace` CLI installs from GitHub repository identifiers or GitHub
tree URLs; it does not install from local filesystem paths like `./codex`.
For this repository, the installable Codex marketplace is published from the
`codex/` subtree to the `codex-marketplace` branch, where the marketplace root
contains the required top-level `plugins/` directory.

To install all plugins from this repo's Codex marketplace:

```bash
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins --plugins
```

Choose the install scope explicitly when you do not want the interactive prompt:

```bash
# Install for the current project only.
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins --plugins --project

# Install for the current user.
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins --plugins --global
```

Use `--global` when installing from this repository checkout itself. A
project-scoped install writes plugin sources into `./plugins/<plugin>`, which
would collide with this repo's Claude Code source plugins. Use `--project` from
another project that wants to consume these Codex plugins.

The marketplace registry for this conversion lives at
`codex/.agents/plugins/marketplace.json`. Keep each marketplace entry's
`source.path` aligned with the directory layout you publish. This repo keeps
converted plugins under `codex/plugins/<plugin>`, so entries point at
`./plugins/<plugin>` from the marketplace root on the `codex-marketplace`
branch.

## Installing Individual Plugins

Use the singular `--plugin` flag when installing one plugin directly instead of
the whole marketplace:

```bash
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins/code --plugin
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins/code-review --plugin
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins/platform --plugin
```

Scoped individual installs use the same shape:

```bash
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins/code --plugin --project
npx codex-marketplace add https://github.com/closedloop-ai/claude-plugins/tree/codex-marketplace/plugins/code-review --plugin --project
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
| `plugins/<p>/agents/<name>.md` | `codex/plugins/<p>/.codex/agents/<name>.toml` | YAML frontmatter → TOML keys; body → `developer_instructions` |
| `plugins/<p>/skills/<name>/SKILL.md` | `codex/plugins/<p>/.agents/skills/<name>/SKILL.md` | Aux files under `references/`, `scripts/`, `assets/` keep their relative paths |
| `plugins/<p>/commands/<name>.md` | `codex/plugins/<p>/.agents/skills/cmd-<name>/SKILL.md` | Commands become skills with a mandatory `cmd-` prefix |
| `plugins/<p>/.claude-plugin/plugin.json` | `codex/plugins/<p>/.codex-plugin/plugin.json` | Manifest is rewritten for Codex's plugin loader |
| Instructions + hooks | `codex/plugins/<p>/AGENTS.md` | Hooks are appended under a `# Hooks (from Claude Code)` section |
| MCP server config | `codex/plugins/<p>/.codex/config.toml` | Merged from `plugins/<p>/.mcp.json` |

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
├── plugins/
│   └── <plugin>/
│       ├── .codex-plugin/plugin.json  ← Codex plugin manifest
│       ├── .codex/
│       │   ├── agents/*.toml          ← converted agents
│       │   └── config.toml            ← MCP servers (when applicable)
│       ├── .agents/
│       │   └── skills/<name>/SKILL.md ← skills + cmd-* (converted commands)
│       └── AGENTS.md                  ← instructions + hooks
└── .agents/plugins/marketplace.json   ← cross-plugin registry
```

## Related Docs

- Source plugins: [`../plugins/`](../plugins/)
- Plugin authoring conventions: [`../CLAUDE.md`](../CLAUDE.md)
- Conversion tool: [closedloop-ai/acplugin](https://github.com/closedloop-ai/acplugin)
