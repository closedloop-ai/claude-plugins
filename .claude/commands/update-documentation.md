# Update Documentation

You are a release engineer responsible for maintaining the root-level CHANGELOG.md and verifying plugin READMEs. Analyze git changes, update the single CHANGELOG.md following the Keep a Changelog format organized by plugin, and ensure plugin READMEs accurately reflect their contents.

## Arguments

$ARGUMENTS

| Argument | Description |
|----------|-------------|
| `--dry-run` | Show what would be changed without modifying files |
| `--plugin <name>` | Only update documentation for specified plugin |
| `--changelog-only` | Skip README verification, only update changelog |
| `--readme-only` | Skip changelog update, only verify/fix READMEs |
| (plain text) | Use as description for changelog entry |

## Execution Modes

Determine the execution mode before starting:

| Flag | Steps to Run |
|------|-------------|
| (none) | All steps: 1 → 2 → 3 → 4 → 5 → 6 |
| `--changelog-only` | Steps 1 → 2 → 3 → 4 → 6 (skip README verification) |
| `--readme-only` | Steps 1 → 5 → 6 (skip changelog, verify READMEs for all changed plugins) |

<data id="reference">

## Path Mappings

### Plugin Paths

| Path | Plugin |
|------|--------|
| `plugins/bootstrap/` | bootstrap |
| `plugins/code/` | code |
| `plugins/code-review/` | code-review |
| `plugins/judges/` | judges |
| `plugins/platform/` | platform |
| `plugins/self-learning/` | self-learning |

### Ignored Paths

- `.claude/` at project root
- Paths outside `plugins/` (root README.md, CLAUDE.md, .gitignore, etc.)

## Changelog Format

The root `CHANGELOG.md` uses a single file with plugin-scoped sections:

```markdown
# Changelog

All notable changes to the claude-plugins project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### code v1.1.0

#### Added
- New `code-reviewer` agent for language-agnostic code review

### judges v1.0.1

#### Fixed
- Fixed scoring normalization in KISS judge
```

**Key rules:**
- Plugin sections use the format: `### {plugin-name} v{version}`
- Version comes from `plugins/{plugin}/.claude-plugin/plugin.json`
- Category subsections use `####` (Added/Changed/Fixed/Removed)
- Entries within a category are bullet points
- Only include plugin sections that have changes
- Order plugin sections alphabetically within a release

<examples id="changelog-entries">

<example type="new-agent">
#### Added
- New `code-reviewer` agent for language-agnostic code review with severity-based findings
</example>

<example type="modified-command">
#### Changed
- Updated `/plan` command to support `--simple` flag for lightweight planning
</example>

<example type="bug-fix">
#### Fixed
- Fixed path resolution in init command when running from subdirectories
</example>

<example type="removal">
#### Removed
- Deprecated `legacy-planner` agent (replaced by `plan-writer`)
</example>

</examples>

<examples id="duplicate-detection">

<example type="duplicate">
Existing: "New `code-reviewer` agent for language-agnostic code review"
Proposed: "Added code-reviewer agent with severity-based categorization"
Result: DUPLICATE (same feature: code-reviewer agent)
</example>

<example type="not-duplicate">
Existing: "Fixed path for .gitignore in init slash command"
Proposed: "New init command improvements"
Result: NOT duplicate (different aspects)
</example>

</examples>

<constraints>

1. **Single file** — All changelog changes go to the root `CHANGELOG.md`
2. **Never add duplicate entries** — Check ALL sections before adding (see duplicate-detection examples)
3. **Use Keep a Changelog format** — Added/Changed/Fixed/Removed categories only
4. **Date format** — YYYY-MM-DD (ISO 8601)
5. **Version source** — Always read from plugin.json, never guess
6. **README edits are minimal** — Only fix inaccurate sections, preserve correct prose and formatting

</constraints>

</data>

## Workflow Tracking

Use TodoWrite to track progress. Mark items completed immediately if not applicable (based on execution mode):

1. Identify changed components
2. Read current state and analyze changes
3. Detect duplicates
4. Update CHANGELOG.md
5. Verify and update plugin READMEs
6. Report summary

## Instructions

### Step 1: Identify Changed Components

Gather changes from all sources and map them to plugins using the path mappings in `<data>`.

**Git commands to run:**
```bash
# Local uncommitted changes
git diff --name-only
git diff --name-only --cached

# Branch changes vs main
git diff --name-only main
```

Combine and deduplicate all paths. Map each path to its plugin.

**Early exit conditions:**
- No changes found → "No changes detected and all documentation is up to date." → Stop
- Only CHANGELOG.md and/or README.md files changed → "Only documentation files changed. Nothing to update." → Stop

**Stale changelog detection (if no local/branch changes):**

For each plugin:
1. Compare `plugin.json` version to latest `### {plugin} v{X.Y.Z}` in CHANGELOG.md
2. If plugin version > changelog version, find commits since version bump:
   ```bash
   git log -1 --format="%H" -S'"version": "X.Y.Z"' -- plugins/{plugin}/.claude-plugin/plugin.json
   git log --oneline {commit}^..HEAD -- plugins/{plugin}/
   ```

### Step 2: Read Current State and Analyze Changes

1. Read `CHANGELOG.md` at the project root (create if missing — see changelog format in `<data>`)
2. For each affected plugin, read `plugins/{plugin}/.claude-plugin/plugin.json` for version
3. Use git to understand what changed:
   ```bash
   git diff <path>           # uncommitted changes
   git diff --cached <path>  # staged changes
   git diff main -- <path>   # branch changes
   git show <commit>         # for stale changelog detection
   ```
4. Categorize each change:

| Change Type | Category |
|-------------|----------|
| New files | Added |
| Modified files | Changed |
| Deleted files | Removed |
| "fix" in commit message or filename | Fixed |

### Step 3: Detect Duplicates

Before adding ANY entry, check for duplicates across ALL sections in the entire CHANGELOG.md.

**Duplicate types:**
1. **Exact match** — Identical text (ignoring whitespace)
2. **Semantic match** — Same change, different words
3. **Key phrase match** — Same identifiers (file names, feature names, command names)

See the `duplicate-detection` examples in `<data>`. If a duplicate is found, skip and log: "Skipping duplicate entry: [text] (already in [version])"

### Step 4: Update CHANGELOG.md

1. **Find or create** the `## [Unreleased]` section at the top (below the header)
2. **Find or create** the plugin subsection `### {plugin} v{version}` within `[Unreleased]`
3. **Find or create** the category `#### Added/Changed/Fixed/Removed` within the plugin subsection
4. **Add entries** as bullet points under the appropriate category

When a release is cut, `## [Unreleased]` gets renamed to `## [YYYY-MM-DD]` with the release date.

### Step 5: Verify and Update Plugin READMEs

For each plugin with changes detected in Step 1, spawn a `general-purpose` Agent **in the background** to verify its README. Run one agent per changed plugin, all in parallel.

Each agent's task:

1. **Inventory the plugin's actual files on disk:**
   - `plugins/{plugin}/agents/*.md` — list agents (exclude non-agent docs like `AGENT_FORMAT.md`)
   - `plugins/{plugin}/skills/*/SKILL.md` — list skills
   - `plugins/{plugin}/commands/*.md` — list commands (exclude `.json` workflow files)
   - `plugins/{plugin}/hooks/*.json` — list hooks
   - `plugins/{plugin}/tools/python/*.py` — list tools (exclude `test_*.py`)
   - `plugins/{plugin}/scripts/*.sh` — list scripts
   - `plugins/{plugin}/.claude-plugin/plugin.json` — read version

2. **Read** `plugins/{plugin}/README.md`

3. **Check for discrepancies:**
   - Agents listed in README vs agents on disk (missing or extra)
   - Skills listed in README vs skills on disk
   - Commands listed in README vs commands on disk
   - Stale counts or references (e.g., "all three skills" when there are 5)
   - Section headers that reference removed or renamed components

4. **If discrepancies found**, edit the README to fix them. Only touch sections that are inaccurate — preserve prose and formatting that is correct.

5. **Report** using this format:
   ```
   Plugin: {plugin}
   Status: Updated | Accurate
   Changes: (list each fix, or "no changes needed")
   ```

Unchanged plugins are skipped.

### Step 6: Report Summary

<output>
## Summary

**Updated:** `CHANGELOG.md`

**Entries added:**
- {plugin} v{version}: Brief description of change

**Duplicates skipped:** (if any)
- [entry text] (already exists)

**README verification:**
- {plugin}: Updated (list changes) | Accurate, no changes needed
</output>
