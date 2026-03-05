# Discovery Learning Reflection

Before completing, reflect on what you discovered about repository structure and cross-repo relationships that could help future discovery work.

## What to Capture

**Repository structure patterns:**
- How this repo organizes its code (directories, naming conventions)
- Where different types of capabilities live (endpoints, models, components)
- Non-obvious locations that differ from defaults

**Cross-repo relationships:**
- How repos in this workspace relate to each other
- Naming conventions across repos (e.g., frontend calls it "meals", backend calls it "food")
- Shared types or contracts between repos

**Discovery shortcuts:**
- Files that are authoritative sources of truth (CLAUDE.md, .repo-identity.json)
- Patterns that quickly identify repo type or capabilities
- Index files or barrel exports that list available capabilities

**Capability location patterns:**
- Where endpoints are defined (not always obvious)
- Where database models live
- Where shared types/interfaces are exported

**Search pattern effectiveness:**
- Which glob patterns worked well
- Which grep patterns found what you needed
- Patterns that returned too many or too few results

## Example Learnings

Good discovery learnings help future searches find things faster:

```json
{
  "what_happened": "Searched for API endpoints in src/routes/ but found none",
  "why": "This repo uses src/routers/ not src/routes/ for FastAPI",
  "pattern_to_remember": "astoria-service uses src/routers/{domain}_router.py for endpoints, not src/routes/",
  "applies_to": ["generic-discovery", "cross-repo-coordinator"],
  "context": { "file": "src/routers/food_router.py" }
}
```

```json
{
  "what_happened": "Couldn't find user model in models/",
  "why": "This repo separates DB models from Pydantic schemas",
  "pattern_to_remember": "astoria-service: DB models in src/db_models/, Pydantic schemas in src/schemas/ - search both for 'model'",
  "applies_to": ["generic-discovery"],
  "context": { "file": "src/db_models/user.py" }
}
```

```json
{
  "what_happened": "Frontend calls endpoint 'meals' but backend has 'food'",
  "why": "Naming mismatch between repos",
  "pattern_to_remember": "astoria workspace: frontend 'meals' = backend 'food' - check both terms when searching cross-repo",
  "applies_to": ["cross-repo-coordinator", "generic-discovery", "*"],
  "context": { "file": ".cross-repo-needs.json" }
}
```

```json
{
  "what_happened": "Found repo type quickly from .repo-identity.json",
  "why": "File contains structured metadata about repo capabilities",
  "pattern_to_remember": "Always check .claude/.repo-identity.json first - contains repo type, owns.patterns, and capability hints",
  "applies_to": ["cross-repo-coordinator", "generic-discovery"],
  "context": { "file": ".claude/.repo-identity.json" }
}
```

```json
{
  "what_happened": "CLAUDE.md had exact directory structure documented",
  "why": "Repo maintainers documented their conventions",
  "pattern_to_remember": "Read peer repo's CLAUDE.md before searching - often documents exact file locations and naming conventions",
  "applies_to": ["generic-discovery"],
  "context": { "file": "CLAUDE.md" }
}
```

## No Learnings Case

If discovery was straightforward:

```json
{
  "no_learnings": true,
  "reason": "Repo followed standard conventions, CLAUDE.md documented structure, all capabilities found in expected locations"
}
```

## Output Location

Write to: `$CLOSEDLOOP_WORKDIR/.learnings/pending/{agent-name}-$CLOSEDLOOP_AGENT_ID.json`

Examples:
- `cross-repo-coordinator-a1b2c3d.json`
- `generic-discovery-d4e5f6g.json`

## Applies To

This guidance is suitable for:
- `cross-repo-coordinator`
- `generic-discovery`
- `repo-coordinator`
- Any agent that explores repository structure
