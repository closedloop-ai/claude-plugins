---
max_turns: 80
timeout_seconds: 1500
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Read, Write, Edit, Glob, Grep, Bash, Skill]
tags: [pm, visual-cues, light-dark]
append_system_prompt: "You are running a vibe session with the vibe plugin (`/vibe:vibe`), in its build loop (its SKILL.md, section 5). This is a stand-in session for an eval. The session worktree is ./session, a tiny stand-in for symphony-alpha; read ./session/AGENTS.md. session/src/return-page.html is the static page Desktop opens in the browser after sign-in: it is generated outside the app shell and loads design-system/tokens.css itself. Startup, the live ticket, closedloop-graph, worker launchers, commits and deploys do not exist here, so skip them and do the persistent writer's work yourself in this context, under the plugin's rules for the writer and the build loop. The session decision table is ./session/.closedloop-ai/decision-tables/session.md. The harness saved each image the person attached in ./images, numbered in the order they were attached. Your final message is exactly what you would send the person."
description: A product manager attaches a reference for a static Desktop page whose surface supports light and dark; without her mentioning dark mode, it is rendered and checked in both themes before ready.
---

Go ahead and build it, and tell me when it's ready to look at.
