---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, prevention, iss-13727]
description: Review synthetic guard, wiring, session-binding, and sequencing excerpts.
---

Load `vibe:handoff`, then read `agents/vibe-adversarial-reviewer.md`. Review
these synthetic pull-request excerpts and report each finding as
`high | file:line | problem | trigger | evidence | fix`. Do not edit code.
Every proven defect in these excerpts is high; report it in the requested high format.
Each fix must name the production correction and its boundary regression test.

`plugins/vibe/hooks/protected-write-guard.mjs:188`:
```js
const parent = realpathSync(dirname(target));
const nativeTarget = join(parent, basename(target));
if (nativeTarget === sessionChangeLog) return { allowed: true };
```

`plugins/vibe/hooks/protected-write-guard.test.mjs:211`:
```js
symlinkSync(realChangeLog, linkedChangeLog);
assert.equal(checkWrite(linkedChangeLog, "writeFile").allowed, true);
```

The fixture also defines, but does not call, these values:
```js
const absent = join(gitDir, "vibe-changes.md");
const dangling = join(gitDir, "missing-link-target");
const hooksEscapeTarget = join(gitDir, "hooks/pre-commit");
const directoryTarget = join(gitDir, "vibe-changes.md/");
const writeForms = ["writeFile", "appendFile", "cp", "mv", "install", "rsync", "ln"];
```

For the protected-write finding, treat every declared-but-uncalled boundary
value and write form as missing evidence. Name each missing category and the
unused fixture value or list that proves the omission. Its fix must require a
regression matrix that exercises every declared boundary through every
supported write form.

`plugins/vibe/skills/fleet-orchestrator/scripts/fleet.test.mjs:307`:
```diff
-runFleet("slot", "heavy", "owner", "worktree", "command");
-assert.match(commandLog(), /load-check\.sh/);
+const result = runLoadCheck({ load: 80, cores: 8 });
+assert.equal(result.allowed, false);
```

`plugins/vibe/skills/vibe/scripts/vibe-sessions.mjs:444,634`:
```js
session.liveTicket = input.ticket;
// discardSession
if (session.liveTicket) await cancelTicket(session.liveTicket);
```

`plugins/vibe/skills/handoff/scripts/rulings-check.mjs:191`:
```js
const SEQUENCING = /\b(follows|wait for)\b/i;
```

`plugins/vibe/skills/handoff/scripts/rulings-check.test.mjs:221`:
```js
assert.deepEqual(sequencingRequirements("ISS-2 follows ISS-1"), [["ISS-1", "ISS-2"]]);
assert.deepEqual(sequencingRequirements("ISS-2 must wait for ISS-1"), [["ISS-1", "ISS-2"]]);
const ordinary = ["review follows normal policy", "wait for the preview to load"];
```
