# Implementation Learning Reflection

Before completing, reflect on what you discovered during implementation that could help future coding work.

## What to Capture

**Code patterns that worked:**
- Patterns you discovered that solved problems elegantly
- Framework-specific conventions that aren't obvious
- Helper functions or utilities you found useful

**Gotchas and pitfalls:**
- Errors you hit and how you fixed them
- Type issues and their solutions
- API quirks that aren't documented

**Import and dependency patterns:**
- Where to import things from (not always obvious)
- Correct versions or variants to use
- Barrel exports vs direct imports

**Error handling patterns:**
- How errors should be handled in this codebase
- Existing error utilities to reuse
- What NOT to handle (already handled elsewhere)

**Testing implications:**
- Things that need mocking
- Test utilities that exist for this pattern
- Test patterns required by this codebase

**Performance considerations:**
- Caching patterns you discovered
- Expensive operations to avoid
- Optimizations already in place

## Example Learnings

Good implementation learnings are specific and actionable:

```json
{
  "what_happened": "Got type error when accessing user.preferences",
  "why": "User type has preferences as optional, returns undefined not null",
  "fix_applied": "Used optional chaining and nullish coalescing",
  "pattern_to_remember": "Always use user?.preferences ?? defaultPrefs when accessing User.preferences - it's optional and can be undefined",
  "applies_to": ["implementation-subagent"],
  "context": { "file": "src/features/settings/UserSettings.tsx", "line": 42 }
}
```

```json
{
  "what_happened": "API call failed with 401 despite valid token",
  "why": "This endpoint requires X-Request-ID header for audit logging",
  "fix_applied": "Added header via the apiClient interceptor",
  "pattern_to_remember": "All /api/v2/ endpoints require X-Request-ID header - use apiClient.withRequestId() wrapper",
  "applies_to": ["implementation-subagent", "*"],
  "context": { "file": "src/lib/api-client.ts", "line": 78 }
}
```

```json
{
  "what_happened": "Imported useState from wrong location",
  "why": "This project re-exports React hooks with additional tracking",
  "fix_applied": "Changed import to use @/hooks/react",
  "pattern_to_remember": "Import React hooks from @/hooks/react not 'react' - they include analytics tracking wrappers",
  "applies_to": ["implementation-subagent"],
  "context": { "file": "src/hooks/react/index.ts" }
}
```

```json
{
  "what_happened": "Form validation was duplicating logic",
  "why": "Didn't know about existing validation schemas",
  "fix_applied": "Used existing schema from src/lib/validation/",
  "pattern_to_remember": "Check src/lib/validation/ for existing Zod schemas before writing form validation - most common schemas exist",
  "applies_to": ["implementation-subagent", "plan-writer"],
  "context": { "file": "src/lib/validation/user.ts" }
}
```

```json
{
  "what_happened": "Component re-rendered excessively",
  "why": "Inline object in dependency array",
  "fix_applied": "Memoized the config object with useMemo",
  "pattern_to_remember": "Never pass inline objects to useEffect deps in this codebase - always useMemo first (ESLint rule is disabled)",
  "applies_to": ["implementation-subagent"],
  "context": { "file": "src/components/DataTable.tsx", "line": 156 }
}
```

## No Learnings Case

If the implementation was straightforward:

```json
{
  "no_learnings": true,
  "reason": "Standard CRUD implementation following existing patterns in src/features/users/"
}
```

## Output Location

Write to: `$CLOSEDLOOP_WORKDIR/.learnings/pending/{agent-name}-$CLOSEDLOOP_AGENT_ID.json`

Example: `implementation-subagent-a1b2c3d.json`

## Applies To

This guidance is suitable for:
- `implementation-subagent`
- `stage-implementer`
- Any agent that writes or modifies code
