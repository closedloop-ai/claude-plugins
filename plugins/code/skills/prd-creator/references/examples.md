# PRD Creator Examples

## Discovery Conversation Example

```
PM: "I have an idea for letting patients message their care team"

→ "What's the user pain — what happens today when they need to reach their team?"

PM: "They have to call during business hours and wait on hold"

→ "Got it. How do you know this is a real problem? Any data or feedback?"

PM: "We've had multiple support tickets about it, and our NPS comments mention it"

→ "That's solid evidence. Why tackle this now — what makes it more important than other things on the roadmap?"

PM: "Our NPS is dragging and this is a top complaint. If we don't address it, churn risk goes up."

→ "Makes sense. Who specifically has this problem — all patients or a subset?"

PM: "Mostly patients managing chronic conditions who need frequent check-ins"

→ "Makes sense. If we ship messaging, what would success look like?"

PM: "Fewer phone calls, faster response times, higher satisfaction"

→ "For MVP, what's the smallest version that tests whether this helps?"

PM: "Just text messaging to their assigned care manager, no attachments or group chats"

→ "Last check — messages will contain health info, so we'll need audit logging and
   access controls. Any new roles needed, or existing care team permissions work?"

PM: "Existing permissions should work"

→ "Great. I'll draft a PRD with what we've covered. I'll flag open questions like
   response time SLAs and notification preferences as Q-001, Q-002."
```

## Story Expansion Example

```markdown
### US-001: View medication list

**As a** patient, **I want** to view my current medications **so that** I can manage my prescriptions.

**Priority:** P0

**Acceptance Criteria:**
- **AC-001.1:** Given I am logged in, when I navigate to medications, then I see my active prescriptions
- **AC-001.2:** Given I have no medications, when I view the list, then I see an empty state with guidance
- **AC-001.3:** Given a medication has refill info, when I view it, then I see the refill date and pharmacy

**Compliance:**
- [ ] Access logged
- [ ] Minimum necessary data displayed
```

## Epic Generation Example

```markdown
## Epic: Medication Management

**Objective:** Enable patients to view and manage their medication information.

**Stories:**
- US-001: View medication list
- US-002: View medication details
- US-003: Request refill

**Success Criteria:** 80% of patients can find their medications within 2 taps.
```

## Analytics Section Example

```markdown
## Analytics

*See [references/event-instrumentation.md](../references/event-instrumentation.md) for formatting rules and platform guidelines.*

### Key Events

| Event | Properties | Description | Platform |
|-------|------------|-------------|----------|
| Page Viewed | `page_name`: "Medications" | Track medication list access for engagement | FE |
| Button Clicked | `button_name`: "Medications:RequestRefill", `page_name`: "MedicationDetail", `medication_id`: "[id]" | Track refill intent | FE |
| Button Clicked | `button_name`: "Medications:ViewDetails", `page_name`: "Medications", `medication_id`: "[id]" | Track detail exploration | FE |
| Refill Requested | `medication_id`: "[id]", `pharmacy_id`: "[id]" | Source-of-truth for refill submissions | BE |

### Event Details

**Page Viewed (Medications)**
- **Trigger:** User navigates to Medications tab
- **Decisions Supported:** Feature adoption, engagement funnel entry point
- **Compliance:** No — no PHI in event itself

**Refill Requested**
- **Trigger:** BE successfully submits refill request to pharmacy
- **Decisions Supported:** Conversion rate, pharmacy integration health
- **Compliance:** Yes — medication_id links to PHI, use BE for audit trail

### User Properties

| Property | Updated When | New Value |
|----------|--------------|-----------|
| `has_viewed_medications` | Page Viewed (Medications) | `true` |
| `last_refill_request_date` | Refill Requested | [timestamp] |

### Instrumentation Notes

- MOBILE ONLY: All events above (web medication view not in scope for MVP)
- Dedupe note: "Request Refill" button click (FE) vs "Refill Requested" (BE) — use BE as source of truth for conversion metrics
```

