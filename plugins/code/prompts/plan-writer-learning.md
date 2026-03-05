# Plan-Writer Learning Reflection

Before completing, reflect on what you discovered that could help future planning runs.

## What to Capture

**Codebase organization patterns:**
- Where different types of files live (routes, components, services, etc.)
- Naming conventions (kebab-case, PascalCase, etc.)
- Barrel export patterns (index.ts files)

**Architectural conventions:**
- How features are structured in this codebase
- State management patterns in use
- API integration patterns

**PRD interpretation patterns:**
- What vague PRD terms mean in this specific org/project
- Implicit requirements that PRDs assume but don't state
- Common gaps in PRDs for this project type

**Reusable abstractions discovered:**
- Existing utilities, hooks, or components that can be reused
- Shared types or interfaces
- Helper functions that handle common operations

**Scope discipline insights:**
- Things that look necessary but aren't (handled elsewhere)
- Patterns that are tempting to add but shouldn't be
- What "out of scope" looks like for this codebase

## Example Learnings

Good plan-writer learnings are architectural/organizational, not code-level:

```json
{
  "what_happened": "Explored codebase to understand feature structure",
  "why": "Needed to know where to place new auth components",
  "pattern_to_remember": "New features follow src/features/{name}/ structure with components/, hooks/, and index.ts barrel export",
  "applies_to": ["plan-writer"],
  "context": { "file": "src/features/dashboard/index.ts" }
}
```

```json
{
  "what_happened": "PRD said 'secure authentication' without specifics",
  "why": "Needed to determine what auth approach to plan for",
  "pattern_to_remember": "PRD 'secure authentication' in this org means Auth0 integration with JWT access tokens and httpOnly refresh cookies",
  "applies_to": ["plan-writer"],
  "context": { "file": "src/lib/auth/provider.tsx" }
}
```

```json
{
  "what_happened": "Almost added error boundary tasks to plan",
  "why": "Discovered app already has global error handling",
  "pattern_to_remember": "Don't add per-component error handling tasks - global ErrorBoundary in src/app/layout.tsx handles all errors",
  "applies_to": ["plan-writer"],
  "context": { "file": "src/app/layout.tsx", "line": 15 }
}
```

```json
{
  "what_happened": "Found existing hook while exploring API patterns",
  "why": "useApiMutation already handles optimistic updates",
  "pattern_to_remember": "useApiMutation hook in src/hooks/api.ts handles optimistic updates and cache invalidation - don't add manual cache tasks",
  "applies_to": ["plan-writer", "implementation-subagent"],
  "context": { "file": "src/hooks/api.ts" }
}
```

## No Learnings Case

If the planning was straightforward with no new discoveries:

```json
{
  "no_learnings": true,
  "reason": "Codebase structure was already documented in CLAUDE.md, PRD was explicit, no new patterns discovered"
}
```

## Output Location

Write to: `$CLOSEDLOOP_WORKDIR/.learnings/pending/plan-writer-$CLOSEDLOOP_AGENT_ID.json`
