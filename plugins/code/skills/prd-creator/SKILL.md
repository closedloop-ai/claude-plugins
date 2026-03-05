---
name: prd-creator
description: This skill helps PMs draft lightweight PRDs for a pre-PMF healthcare startup. It should be used when a PM wants to define a new feature, brainstorm requirements, or prep for sprint planning. Triggers include "I have a feature idea", "help me write a PRD", "let's break this into stories", or "what do I need for sprint planning". Optimized for speed — generates minimal viable documentation through conversation, not heavy templates.
---

# PRD Creator

## Philosophy

We document for **alignment**, not approval. A PRD answers:

1. What are we building and why?
2. Who is it for?
3. How do we know it worked?
4. What's the smallest thing we can ship?
5. Any compliance blockers?

## Workflow Modes

### Discovery Mode

When PM has a rough idea, guide them through conversationally:

1. **Problem** — "What's the user pain or opportunity?"
2. **Evidence** — "How do you know this matters?" (even anecdotal is fine)
3. **Why now?** — "Why this over other things we could build? What's the cost of waiting?"
4. **Persona** — "Who specifically has this problem?"
5. **Success** — "If this works, what changes? How will we measure it?"
6. **First slice** — "What's the smallest version that tests the hypothesis?"
7. **Analytics** — "What user actions do we need to track to validate the hypothesis?" Use `references/event-instrumentation.md` to guide event naming and structure.

Don't ask all at once. Have a conversation. Fill gaps with reasonable assumptions and flag them as open questions.

See [references/examples.md](references/examples.md) for a sample Discovery conversation.

### Draft Mode

When ready to write, use `assets/prd-template.md`. The template includes:

- **Summary** — Executive overview for Confluence skimmers
- **Context** — Problem, hypothesis, personas
- **Scope** — MVP in/out, success metrics, kill criteria
- **Compliance & Risk** — PHI assessment, access requirements, dependencies
- **Analytics** — Key events following `references/event-instrumentation.md` format (Title Case events, snake_case properties, PascalCase values)
- **Open Questions** — Unresolved items with Q-### IDs
- **User Stories** — Stories with US-### IDs and acceptance criteria

### Story Expansion Mode

Use this mode to add acceptance criteria to stories before exporting to Jira. The PM workflow is:

1. **Draft PRD** → Write stories in user story format (As a / I want / so that)
2. **Expand stories** → Add acceptance criteria using this mode
3. **Export to Jira** → Use `jira-prd-export` to create epics/stories with full ACs

**To expand a story:**

1. Take an existing user story (e.g., US-001)
2. Generate acceptance criteria in Given/When/Then format
3. Use AC-###.# IDs (e.g., AC-001.1, AC-001.2)
4. Reference `references/story-patterns.md` for healthcare-specific patterns

See [references/examples.md](references/examples.md) for story expansion examples.

### Epic Generation Mode

When organizing stories into epics:

- 1 epic = 1-2 sprints of work max
- Group related user stories under a theme
- Each epic gets a clear objective and success criteria

See [references/examples.md](references/examples.md) for epic format example.

## Interacting with Codebase

When PM asks about existing features or feasibility:

1. Search codebase for relevant files
2. Summarize what exists in plain language
3. Note integration points or constraints
4. Don't over-engineer — flag technical questions for eng

## Output Formats

| Need | Output |
|------|--------|
| Quick alignment | Markdown in chat, no file needed |
| Sprint planning | PRD file → `confluence-prd-export` → `jira-prd-export` |
| Symphony pipeline | PRD file → `prd-analyst` → `requirements.json` |

## ID Conventions

Consistent IDs enable traceability through the Symphony pipeline:

| Type | Format | Example |
|------|--------|---------|
| User Story | US-### | US-001, US-002 |
| Acceptance Criteria | AC-###.# | AC-001.1, AC-001.2 |
| Open Question | Q-### | Q-001, Q-002 |

## Integration with Symphony

PRDs created with this skill feed into Symphony's planning pipeline:

```
prd-creator → PRD.md → prd-analyst → requirements.json → plan-writer → implementation-plan.md
```

The `prd-analyst` agent extracts:
- User stories → `user_stories[]`
- Acceptance criteria → `acceptance_criteria[]`
- Success metrics → `success_metrics[]`
- Analytics events → `analytics[]`
- Open questions → `open_questions[]`
- Compliance notes → `constraints[]`

## Task Tracking

Use TodoWrite to track progress through each workflow mode.

### Discovery Mode

```json
TodoWrite([
  {"content": "Understand the problem and user pain", "status": "pending", "activeForm": "Understanding the problem"},
  {"content": "Gather evidence for why this matters", "status": "pending", "activeForm": "Gathering evidence"},
  {"content": "Identify target persona(s)", "status": "pending", "activeForm": "Identifying personas"},
  {"content": "Define success metrics", "status": "pending", "activeForm": "Defining success metrics"},
  {"content": "Scope the first slice / MVP", "status": "pending", "activeForm": "Scoping MVP"},
  {"content": "Identify analytics events needed", "status": "pending", "activeForm": "Identifying analytics events"}
])
```

### Draft Mode

```json
TodoWrite([
  {"content": "Write Summary section", "status": "pending", "activeForm": "Writing Summary"},
  {"content": "Write Context (Problem, Hypothesis, Personas)", "status": "pending", "activeForm": "Writing Context"},
  {"content": "Write Scope (In/Out, Success Metrics)", "status": "pending", "activeForm": "Writing Scope"},
  {"content": "Write Compliance & Risk section", "status": "pending", "activeForm": "Writing Compliance"},
  {"content": "Write Analytics section (events, properties, platform)", "status": "pending", "activeForm": "Writing Analytics"},
  {"content": "Document Open Questions with Q-### IDs", "status": "pending", "activeForm": "Documenting questions"},
  {"content": "Write User Stories with US-### IDs", "status": "pending", "activeForm": "Writing user stories"}
])
```

### Story Expansion Mode

```json
TodoWrite([
  {"content": "Select user story to expand", "status": "pending", "activeForm": "Selecting story"},
  {"content": "Generate acceptance criteria (Given/When/Then)", "status": "pending", "activeForm": "Generating acceptance criteria"},
  {"content": "Assign AC-###.# IDs", "status": "pending", "activeForm": "Assigning AC IDs"},
  {"content": "Review against story-patterns.md", "status": "pending", "activeForm": "Reviewing patterns"}
])
```

Mark each task completed only after the PM confirms alignment. For Discovery Mode, tasks may be revisited as the conversation evolves.

## Keep It Light

- Keep to as few pages as is feasible
- Assumptions are fine — flag them as Q-### items
- Details emerge in Story Expansion Mode
- The AI can regenerate/expand sections later
- Perfect is the enemy of shipped
