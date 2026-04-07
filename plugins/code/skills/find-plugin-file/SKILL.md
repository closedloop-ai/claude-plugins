---
name: find-plugin-file
description: This skill should be used when needing to locate files within the Claude Code plugins cache directory (~/.claude/plugins/cache). Triggers include finding tool scripts, skill files, or any plugin resource when the hardcoded path is unknown or varies by plugin version. Use when slash commands or orchestrators need to dynamically resolve plugin file paths.
---

# Find Plugin File

## Overview

This skill provides a utility to dynamically locate files within the Claude Code plugins cache directory. Instead of hardcoding plugin-cache paths, use this skill to find files in `~/.claude/plugins/cache/closedloop-ai/` with automatic latest-version resolution.

## Quick Start

To find a file in the plugins cache, run the `find_plugin_file.py` script:

```bash
python scripts/find_plugin_file.py <file_pattern>
```

## Usage Examples

### Find by filename

```bash
# Find parse_args.py in any plugin (returns first match)
python scripts/find_plugin_file.py parse_args.py

# Find all SKILL.md files across all plugins
python scripts/find_plugin_file.py SKILL.md --all
```

### Find by path pattern

```bash
# Find a specific file using path pattern
python scripts/find_plugin_file.py plan/parse_args.py

# Find tools in a specific subdirectory
python scripts/find_plugin_file.py tools/python/plan/parse_args.py
```

### Restrict to specific plugin

```bash
# Search only in code plugin
python scripts/find_plugin_file.py parse_args.py --plugin code
```

### List available plugins

```bash
python scripts/find_plugin_file.py --list-plugins
```

## Integration with Slash Commands

To use in a slash command that needs to reference plugin tools, use a two-step approach:

```bash
# Step 1: Locate the find_plugin_file.py script (handles multiple plugin versions)
FIND_SCRIPT=`ls ~/.claude/plugins/cache/closedloop-ai/code/*/skills/find-plugin-file/scripts/find_plugin_file.py 2>/dev/null | sort -V | tail -1`

# Step 2: Use the script to find the target file, then derive TOOLS_PATH
TARGET_FILE=`python "$FIND_SCRIPT" plan/parse_args.py`
TOOLS_PATH=`dirname \`dirname "$TARGET_FILE"\``

# Step 3: Run with correct PYTHONPATH
PYTHONPATH="$TOOLS_PATH:$PYTHONPATH" python "$TARGET_FILE" --help
```

**Important:**
- Use backticks (`` ` ``) instead of `$()` for command substitution — Claude Code's Bash tool escapes `$()` syntax.
- The glob pattern `code/*/skills/...` can match multiple version directories. Always use `ls ... | sort -V | tail -1` to select the latest version.

## Script Arguments

| Argument | Description |
|----------|-------------|
| `file_pattern` | File name or path pattern to find |
| `--plugin, -p` | Restrict search to a specific plugin |
| `--all, -a` | Return all matches instead of just the first |
| `--list-plugins, -l` | List available plugins and their latest versions |
| `--cache-dir` | Override the default cache directory |

## Version Resolution

The script automatically selects the latest version of each plugin using semantic versioning comparison. For example, if a plugin has versions `1.6.0`, `1.9.1`, and `1.10.0`, it will search in `1.10.0`.

## Resources

### scripts/

- `find_plugin_file.py` - Main utility script for locating files in the plugins cache
