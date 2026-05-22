# Draft Plan Playbook (Reference)

## Artifacts

- `anchors.json`
- `traceability.csv`
- `api-requirements.md` (if backend APIs needed)

## Required Sections

Summary → Acceptance Criteria → Architecture Fit → Task Table → API/Data Impacts → Risks/Constraints → Test Plan → Rollback → Open Questions → Gaps → Visual References (if any)

## Task & Acceptance Criteria Format

### Task IDs

All tasks MUST use the format `T-{phase}.{sequence}`:

```markdown
### Phase 1: Data Layer

- [ ] **T-1.1**: Create user schema in `src/models/user.ts`
- [ ] **T-1.2**: Add migration for users table
```

Task IDs enable traceability to acceptance criteria and API requirements.

### Acceptance Criteria IDs

Add an `## Acceptance Criteria` section after Summary. Each criterion MUST have an ID:

```markdown
## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-001 | User can log in with email/password | PRD §2.1 |
| AC-002 | Session expires after 24h inactivity | PRD §2.3 |
| AC-003 | Failed login shows error message | PRD §2.1 |
```

### Traceability Requirements

Every task MUST map to at least one acceptance criterion. Document in `traceability.csv`:

```csv
task_id,acceptance_criteria,status
T-1.1,"AC-001,AC-002",pending
T-1.2,AC-001,pending
```

### API Requirements Linkage

If `api-requirements.md` is produced, each endpoint MUST reference the task(s) it supports:

```markdown
### POST /v1/auth/login

**Supports:** T-2.1, T-2.3
**Acceptance Criteria:** AC-001, AC-003
```

## RFC-Style Elements

Surface decisions that need reviewer input. Include where applicable:

### Design Decisions

| Decision | Options | Proposed | Rationale |
|----------|---------|----------|-----------|
| Storage format | JSONL, SQLite, JSON | JSONL | Append-only, human-readable, matches existing patterns |

### Questions for Reviewer

- "Should we prioritize storage efficiency over query performance?"
- "Is 30-day retention sufficient, or allow configuration?"

### Gaps (PRD/Requirements Issues)

Document issues found in requirements that need human attention. Use `GAP-###` IDs with checkboxes:

```markdown
## Gaps

- [ ] **GAP-001**: PRD specifies "fast response times" but doesn't define acceptable latency thresholds
- [ ] **GAP-002**: No guidance on handling concurrent edits to the same resource
- [ ] **GAP-003**: Authentication requirements conflict between §2.1 (session-based) and §3.2 (stateless API)
```

**Workflow:**
- Gaps start unchecked `[ ]` - informational only, not actionable
- When a human wants to address a gap, they mark it `[x]` and add a resolution:
  ```markdown
  - [x] **GAP-001**: PRD specifies "fast response times" but doesn't define acceptable latency thresholds **Resolution:** Use 200ms p95 latency target
  ```
- Plan-writer then incorporates addressed gaps into tasks

### Alternatives Considered

- **SQLite (rejected)**: More query power. *Why not: adds dependency, overkill for append-only log.*

### Success Criteria

- "Query latency < 100ms p90"
- "Zero data loss on graceful shutdown"

## Quality Bar

All must hold:

1. Exact file paths & explicit edits
2. No conditional language ("may/should/if")
3. Explicit deletions with full paths
4. Existence verified for every referenced symbol/file
5. Each acceptance criterion maps to ≥1 task & validation

## Workflow

1. Create draft with RFC elements
2. Self-audit: concreteness, existence, scope, simplicity, traceability, decision clarity
3. Revise to fix findings

Prefer minimal, targeted edits over broad refactors unless strictly required.
