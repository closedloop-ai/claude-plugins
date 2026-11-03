# Manual QA Record

Copy this template to the chosen durable, untracked QA-record location. This physical Markdown file is the complete plan and live execution ledger, not merely a final report. Populate the entire planned scenario inventory before the first checkpoint and update the file after every material action. Remove unused optional rows, but retain explicit gaps and `not applicable` decisions.

## Session identity

- Started:
- Updated:
- Tester / human confirmer:
- Agent:
- Repository:
- Absolute worktree:
- Change target (ticket, branch, PR, or description):
- Base revision:
- Head revision:
- Merge base and stable patch-id at each tested head:
- Resume point (next `PENDING` checkpoint):
- Uncommitted changes under test:
- Requirements consulted:
- Repository instructions consulted:
- Memory hints used and current evidence that verified them:

## Environment

- OS / architecture:
- Runtime and package versions:
- Approved QA origin and authority (local default, explicit user override, or repository instruction):
- Actual browser origin verification:
- Browser or desktop build:
- Browser state fixture method:
- Browser state origin and non-secret keys:
- Browser state verification:
- Disposable browser context/profile and cleanup path:
- Interactive window or app owner, settled route/control, and last live verification time:
- Feature-flag assignments:
- Role / permissions:
- Local or non-production account / tenant:
- Relevant configuration, with secrets redacted:

### Services and worktree proof

| Service | Launch command | Cwd | PID | Listener / endpoint | Health result | Proof it maps to this worktree |
| --- | --- | --- | --- | --- | --- | --- |

Record the service owner or supervisor that keeps each required process alive across tool calls or worker turns, plus the supported command that inspects and stops only that owner. Recheck these rows after a resume; prior readiness is historical evidence.

### Persistence runtime proof

- Expected repository data-service lane (Docker / Compose / native / other) and evidence:
- Actual service owner (container/project or native process):
- Container image, name, health, and host-to-container port mapping, if applicable:
- Database name and non-secret connection target:
- Migration command and result:
- Seed command, profile/source, authentication-identity binding, and result:
- Non-sensitive population summary:
- App/API effective database target proof:
- Shared developer state excluded by:
- Mock-backed surfaces that intentionally do not use this database:

### Fixtures and data

- Fixture or seed source:
- Creation command or steps:
- Identifiers safe to record:
- Reset between scenarios:
- Cleanup plan:
- Production-data exclusion verified by:

## Automated preparation

These results prepare the session and do not count as human confirmation.

| Check | Command / method | Result | Evidence |
| --- | --- | --- | --- |

### Exact-head E2E coverage map

| Requirement / candidate checkpoint | Shipping host and state | E2E spec and assertion | Tested head and result | Manual gap, if any |
| --- | --- | --- | --- | --- |

Record a candidate here as `E2E_COVERED`, rather than in planned coverage, when a passing E2E case proves its same host, flags, fixture transition, action, and oracle. An E2E result is automated coverage, not a human `PASS`. Recheck every row after a head change; preserve the prior evidence without pretending it ran on the new head.

## Planned coverage

| ID | Priority | Surface / risk not covered by E2E | Requirement | Dependencies | Status |
| --- | --- | --- | --- | --- | --- |

Use `PENDING`, `PASS`, `FAIL`, `BLOCKED`, `NOT APPLICABLE`, or `AGENT_VERIFIED` for checkpoint status. `AGENT_VERIFIED` means the agent closed the checkpoint under the routing rule in `SKILL.md` without presenting it; it is never a human `PASS`. In a carried-forward plan, `E2E_COVERED` means a former checkpoint moved to the exact-head E2E coverage map; link its matching assertion and result. Exclude both from human pass/fail counts.

Every planned scenario must appear here even if it has not started. When a scenario is blocked, retain it and record the exact prerequisite and recheck condition rather than deleting or silently narrowing it.

## Checkpoint results

### QA-001: Scenario title

- Risk / requirement:
- Exact owning surface / mode / renderer:
- Prototype-harness eligibility, if applicable (asserted code and proven production/Storybook importer; otherwise `NOT APPLICABLE` and owning-surface/gap disposition):
- Oracle contract evidence (exact acceptance criterion or approved clause, version, and applicability to this surface):
- Expectation basis (explicit requirement or diagnostic inference; code/tests only corroborate behavior):
- Fixture reachability proof:
- Active defaults, persisted state, hierarchy, and population effects:
- Applicability boundary / intentionally absent behavior:
- Prerequisites and starting state:
- Entry point used (feature-map id and route, when the repository keeps a feature map):
- Agent dry run (capture, or link to an earlier capture of this entry point on this head):
- Routing (`AGENT_VERIFIED` with its evidence, or the reason this checkpoint needs a human):
- Read-only second view after a write:
- Human action or observation:
- Expected:
- Agent-observed or automated supporting evidence:
- Reset / cleanup performed:
- Effect on later checkpoints:

| Attempt | Head | Patch-id | Status | Actual | Confirmed by | Time | Evidence | Carry-forward reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Status is `PASS`, `FAIL`, `BLOCKED`, `NOT APPLICABLE`, `AGENT_VERIFIED`, or `ORACLE CORRECTION`; an inconclusive observation is `BLOCKED` with reason "inconclusive". For `AGENT_VERIFIED`, "Confirmed by" is `agent-observed`, never a human name. Append a row for every run, rerun, reset, or carry-forward. Never edit an earlier row. The latest row is the checkpoint's current status in "Planned coverage".

Duplicate this section for each checkpoint.

Complete the oracle fields before presenting the checkpoint. If the expected outcome lacks an applicable approved requirement, keep it diagnostic rather than a pass/fail gate. If a disputed observation shows the expectation was inferred from an internal matrix, attached to the wrong surface, or ignored fixture/default behavior, use `ORACLE CORRECTION`, preserve the observation, and do not open or count a product finding.

## Recovery log

| Time | Intended path | Exact command or action | Failure | Targeted repair | Rerun result | Fallback or blocked scope |
| --- | --- | --- | --- | --- | --- | --- |

Record a wrong-origin or wrong-service discovery as an `ORACLE CORRECTION`. State which evidence was invalidated and which checkpoints were reopened; never carry a preview/native-database observation into a local/Docker result without rerunning it.

## Findings

### Finding F-001: Short title

- Status: suspected / human-confirmed / withdrawn
- Environment and revision:
- Preconditions:
- Minimal reproduction:
- Expected:
- Actual:
- Frequency:
- Affected surfaces:
- Logs, screenshots, or trace references:
- Evidence label for each claim (`agent-observed`, `automated`, `inferred`, or `unverified`):
- Related checkpoint IDs:
- Local cleanup state:
- Selected disposition: local evidence only / continue independent testing / investigate source / authorized external action
- Authorization detail, if any:

## Final summary

- Coverage completed:
- Separate counts: human-confirmed `PASS` and `FAIL`, `AGENT_VERIFIED`, `E2E_COVERED`, and `BLOCKED`:
- Checkpoints left to the human, and why each needed a human:
- Confirmed findings:
- Untested gaps and reasons:
- Cleanup status:
- Evidence locations (in the record's directory, outside the worktree):
- Evidence pointers checked after cleanup, and any that no longer resolve:
- Feature-map drift observed:
- Selected next action:

Each line cites the record section or evidence path that supports it. Label a claim nobody observed `inferred` or `unverified`.
