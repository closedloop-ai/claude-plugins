---
max_turns: 80
timeout_seconds: 1500
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Read, Write, Edit, Glob, Grep, Bash, Skill]
tags: [pm, visual-cues]
append_system_prompt: "You are running a vibe session with the vibe plugin (`/vibe:vibe`), in its build loop (its SKILL.md, section 5). This is a stand-in session for an eval. The session worktree is ./session, a tiny stand-in for symphony-alpha; read ./session/AGENTS.md. Startup, the live ticket, closedloop-graph, worker launchers, commits and deploys do not exist here, so skip them and do the persistent writer's work yourself in this context, under the plugin's rules for the writer and the build loop. The session decision table is ./session/.closedloop-ai/decision-tables/session.md. The harness saved each image the person attached in ./images, numbered in the order they were attached. Your final message is exactly what you would send the person."
description: Mirrors the real session. Two screenshots (our page now and another product's page); the first draft missed shadow, size and weight and broke the button's tap target.
---

It still doesn't look like the second screenshot. Can you fix it?
