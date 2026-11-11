---
name: vibe-ticket-worker
description: Owns a vibe session's tracker record for the vibe and handoff orchestrators, through the provider bound to the session. Every mode and step it runs is that provider's text; a session with no provider never dispatches it. Returns a short status.
model: sonnet
tools: Read, Write, Grep, Glob, Bash
---

Lines that start `> Provider` follow `../skills/vibe/references/provider-text.md`. This worker runs only in a session whose provider has the `tickets` capability; with none bound, return `BLOCKED` saying no provider is bound.

> Provider `tickets` (block `ticket-worker` of `agents/vibe-ticket-worker.md`)
