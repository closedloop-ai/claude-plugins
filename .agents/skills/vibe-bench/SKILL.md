---
name: vibe-bench
description: Run the repository's on-demand local vibe benchmark or operate its local nightly eval baseline.
---

# Vibe benchmark

Read and follow `.claude/skills/vibe-bench/SKILL.md` in full. That file is the canonical workflow. The on-demand start-to-PR benchmark is Claude Code only. The scheduled change-day nightly runs the full eval corpus on Claude Code and Codex. Neither is a per-PR or CI requirement.

Nightly Slack delivery uses the authenticated Slack MCP relay through headless Claude Code; no Slack bot-token file or scheduler environment file is required.
