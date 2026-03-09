---
name: closedloop-env
description: Provides ClosedLoop environment paths (CLOSEDLOOP_WORKDIR, CLAUDE_PLUGIN_ROOT) to agents. This skill should be used by any agent that needs to access ClosedLoop run directories, plugin schemas, or other path-dependent resources.
---

# ClosedLoop Environment

This skill provides access to ClosedLoop environment variables needed for file operations.

## Get Environment Paths

Read the base environment file:

    .closedloop-ai/env

The file contains KEY=VALUE pairs:
- `CLOSEDLOOP_WORKDIR` - The run directory for this session
- `CLAUDE_PLUGIN_ROOT` - The plugin installation directory
- `CLOSEDLOOP_PRD_FILE` - Path to the PRD file
- `CLOSEDLOOP_MAX_ITERATIONS` - Maximum loop iterations

## Common Paths

After reading the env file, construct paths like:
- Schema file: `{CLAUDE_PLUGIN_ROOT}/schemas/plan-schema.json`
- Plan file: `{CLOSEDLOOP_WORKDIR}/plan.json`

## Organization Learnings

Also read your agent-specific learnings file if it exists:

    .closedloop-ai/learnings-{your-agent-name}

Where `{your-agent-name}` is your `name:` from your frontmatter in lowercase (e.g., `plan-validator`).

The learnings file contains an `<organization-learnings>` block with patterns from previous runs. These learnings capture what worked well and should be applied to improve your performance.

When learnings are present:
1. Review the patterns before starting your task
2. Apply relevant patterns to your work
3. Acknowledge which patterns you applied in your response using the format specified in the learnings block
