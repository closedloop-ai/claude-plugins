# [Feature Name]

**Owner:** [PM] | **Status:** Draft / Review / Approved | **Target:** [Sprint/Quarter]

---

## Summary

[2-3 sentence executive summary: What we're building, for whom, and the expected outcome. Written for someone skimming in Confluence.]

---

## Context

### Problem

[1-3 sentences: What's broken or missing? For whom? Include evidence if available.]

### Hypothesis

We believe [solution] will [outcome] for [persona], measured by [metric].

### Personas

- **Primary:** [Name] — [Role/description, key need]
- **Secondary:** [Name] — [Role/description, key need] *(optional)*

---

## Scope

### In (MVP)

- [Capability 1]
- [Capability 2]

### Out (Deferred)

- [Explicitly excluded item with brief rationale]

### Success Metrics

| Metric | Baseline | Target | How Measured |
|--------|----------|--------|--------------|
| [Primary metric] | [Current] | [Goal] | [Method] |
| [Secondary metric] | [Current] | [Goal] | [Method] |

### Kill Criteria

If [primary metric] doesn't reach [minimum threshold] by [timeframe], we will [action: deprioritize / remove / pivot].

---

## Compliance & Risk

### PHI Assessment

- [ ] Displays patient health information
- [ ] Stores new patient data
- [ ] Transmits data to/from external systems
- [ ] Enables export/download of patient data

**If checked:** [What PHI, why needed, access model]

### Access Requirements

- [ ] New role/permission needed
- [ ] Changes to data visibility
- [ ] Patient-facing feature

**If checked:** [Access model notes]

### Dependencies & Risks

| Risk/Dependency | Mitigation | Owner |
|-----------------|------------|-------|
| [Item] | [Plan] | [Who] |

---

## Analytics

*See [references/event-instrumentation.md](../references/event-instrumentation.md) for formatting rules and platform guidelines.*

### Key Events

| Event | Properties | Description | Platform |
|-------|------------|-------------|----------|
| Page Viewed | `page_name`: "[PageName]" | [When/why this page view matters] | FE |
| Button Clicked | `button_name`: "[Context:Action]", `page_name`: "[PageName]" | [What this action represents] | FE |
| [Backend Event] | [relevant_id]: "[value]" | [Source-of-truth action] | BE |

### Event Details

For each event above, document:
- **Trigger:** [Precise trigger condition]
- **Decisions Supported:** [What we learn / how it's used]
- **Compliance:** [Yes/No — contains PHI or sensitive data?]

### User Properties

| Property | Updated When | New Value |
|----------|--------------|-----------|
| [property_name] | [Event that triggers update] | [New value] |

### Instrumentation Notes

- [Platform tags: MOBILE ONLY, DESKTOP ONLY, BACKEND ONLY]
- [Funnel analysis, A/B test integration, deduplication notes]
- [Any conditional logic for when events fire]

---

## Open Questions

- **Q-001:** [Question needing resolution before/during implementation]
- **Q-002:** [Question]

---

## User Stories

### US-001: [Short title]

**As a** [persona], **I want** [capability] **so that** [benefit].

**Priority:** P0 | **Notes:** [Optional context]

*(Acceptance criteria generated during refinement)*

---

### US-002: [Short title]

**As a** [persona], **I want** [capability] **so that** [benefit].

**Priority:** P1 | **Notes:** [Optional context]

*(Acceptance criteria generated during refinement)*

---

## Appendix *(optional)*

### Design References

- [Figma link]

### Technical Notes

- [Architecture considerations flagged for eng]

---

*Stories expanded during refinement. Implementation details determined by engineering.*
