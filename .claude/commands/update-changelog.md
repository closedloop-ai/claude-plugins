# Update Changelog

You are a release engineer responsible for maintaining the root-level CHANGELOG.md. Your goal is to analyze git changes and update the single CHANGELOG.md following the Keep a Changelog format, organized by plugin.

## Workflow Tracking

Use TodoWrite to track progress. Mark items completed immediately if not applicable:

1. Identify changed components (local/branch/stale changelog)
2. Read current CHANGELOG.md
3. Analyze and categorize changes per plugin
4. Update CHANGELOG.md
5. Report summary of changes

<data id="path-mappings">
## Path Mappings

### Plugin Paths
| Path | Plugin |
|------|--------|
| `plugins/code/` | code |
| `plugins/code-review/` | code-review |
| `plugins/bootstrap/` | bootstrap |
| `plugins/judges/` | judges |
| `plugins/platform/` | platform |
| `plugins/self-learning/` | self-learning |

### Ignored Paths
- `.claude/` at project root
- Paths outside `plugins/` (README.md, CLAUDE.md, .gitignore, etc.)
</data>

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

<examples>
## Changelog Entry Examples

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

<constraints>
## Constraints

1. **Single file** - All changes go to the root `CHANGELOG.md`
2. **Never add duplicate entries** - Check ALL sections before adding
3. **Use Keep a Changelog format** - Added/Changed/Fixed/Removed categories
4. **Date format** - YYYY-MM-DD (ISO 8601)
5. **Version source** - Always read from plugin.json, never guess
</constraints>

## Instructions

### Step 1: Identify Changed Components

Gather changes from all sources and map them to plugins using the path mappings above.

**Git Commands to Run:**
```bash
# Local uncommitted changes
git diff --name-only
git diff --name-only --cached

# Branch changes vs main
git diff --name-only main
```

Combine and deduplicate all paths.

**Early Exit Conditions:**
- No changes found → "No changes detected and all changelogs are up to date." → Stop
- Only CHANGELOG.md changed → "Only changelog files changed. Nothing to update." → Stop

**Stale Changelog Detection (if no local/branch changes):**

For each plugin:
1. Compare `plugin.json` version to latest `### {plugin} v{X.Y.Z}` in CHANGELOG.md
2. If plugin version > changelog version, find commits since version bump:
   ```bash
   git log -1 --format="%H" -S'"version": "X.Y.Z"' -- plugins/{plugin}/.claude-plugin/plugin.json
   git log --oneline {commit}^..HEAD -- plugins/{plugin}/
   ```

### Step 2: Read Current State

1. Read `CHANGELOG.md` at the project root (create if missing — see format above)
2. For each affected plugin, read `plugins/{plugin}/.claude-plugin/plugin.json` for version

### Step 3: Analyze and Categorize Changes

Use git to understand what changed:
```bash
git diff <path>           # uncommitted changes
git diff --cached <path>  # staged changes
git diff main -- <path>   # branch changes
git show <commit>         # for stale changelog detection
```

**Categorization Rules:**
| Change Type | Section |
|-------------|---------|
| New files | Added |
| Modified files | Changed |
| Deleted files | Removed |
| "fix" in commit message or filename | Fixed |

### Step 4: Duplicate Detection (CRITICAL)

Before adding ANY entry, check for duplicates across ALL sections in the entire CHANGELOG.md.

**Duplicate Types:**
1. **Exact match** - Identical text (ignoring whitespace)
2. **Semantic match** - Same change, different words
3. **Key phrase match** - Same identifiers (file names, feature names, command names)

<examples>
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

**If duplicate found:** Skip and log: "Skipping duplicate entry: [text] (already in [version])"

### Step 5: Update CHANGELOG.md

Determine where to insert entries:

1. **Find or create the `## [Unreleased]` section** at the top (below the header)
2. **Find or create the plugin subsection** `### {plugin} v{version}` within `[Unreleased]`
3. **Find or create the category** `#### Added/Changed/Fixed/Removed` within the plugin subsection
4. **Add entries** as bullet points under the appropriate category

When a release is cut, `## [Unreleased]` gets renamed to `## [YYYY-MM-DD]` with the release date.

### Step 6: Report Summary

<output-format>
## Summary

**Updated:** `CHANGELOG.md`

**Entries added:**
- {plugin} v{version}: Brief description of change

**Duplicates skipped:** (if any)
- [entry text] (already exists)
</output-format>

## Arguments

$ARGUMENTS

| Argument | Description |
|----------|-------------|
| `--dry-run` | Show what would be changed without modifying files |
| `--plugin <name>` | Only update changelog for specified plugin |
| (plain text) | Use as description for changelog entry |
