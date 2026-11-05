---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, prevention, iss-13727]
description: Review a test fixture, two path classifiers, and their release notes.
---

Load `vibe:handoff`, then read `agents/vibe-guardrails-reviewer.md`. This is a
pull-request turn. The ticket says to update quoted-citation parsing and path
intake. Its requirements and recorded human rulings contain no change to the
six exclusion categories in the fixture below. Review these synthetic excerpts
and report each finding as
`blocking | file:line | problem | evidence | fix`. Do not edit code.

`plugins/vibe/skills/handoff/scripts/rulings-check.test.mjs:163`:
```diff
 // Pins every exclusion that has no citation of its own.
-const expected = ["docs", "scripts", "root config", "infra", "tests", "hooks"];
+const expected = ["docs", "scripts"];
 assert.deepEqual(result.uncited, expected);
-assert.ok(result.uncited.includes("root config"));
-assert.ok(result.uncited.includes("infra"));
-assert.ok(result.uncited.includes("tests"));
-assert.ok(result.uncited.includes("hooks"));
```

`plugins/vibe/skills/handoff/scripts/path-classifier.mjs:22`:
```js
export function classifyHandoffPath(path, phase, policy) {
  if (policy.prototypeOwned(path)) return "allowed";
  if (policy.isTest(path)) return phase === "pull-request" ? "allowed" : "forbidden";
  if (policy.shrinkOnly(path)) return "shrink-only";
  return "outsideAllowed";
}
```

`plugins/vibe/skills/vibe/scripts/scope-intake.ts:41`:
```ts
function classifyPath(path: string, phase: string, policy: Policy) {
  if (policy.prototypeOwned(path)) return "outsideAllowed";
  if (policy.isTest(path)) return "allowed";
  if (policy.shrinkOnly(path)) return "forbidden";
  return "allowed";
}
```

`plugins/vibe/skills/handoff/scripts/rulings-check.mjs:142`:
```js
const cited = line.includes("Source:");
return exclusions.map((text) => ({ text, cited }));
```

`plugins/vibe/hooks/protected-write-guard.test.mjs:211`:
```js
symlinkSync(realChangeLog, linkedChangeLog);
assert.equal(checkWrite(linkedChangeLog).allowed, true);
```

`CHANGELOG.md:10-11`:
```md
- One citation covers the clause after a semicolon.
- Symlink escapes remain denied.
```
