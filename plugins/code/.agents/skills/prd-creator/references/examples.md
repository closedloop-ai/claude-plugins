# PRD Creator Examples

## Discovery Conversation Example

```
PM: "I have an idea for letting users collaborate on documents in real time"

→ "What's the user pain — what happens today when they need to collaborate?"

PM: "They email docs back and forth and end up with version conflicts"

→ "Got it. How do you know this is a real problem? Any data or feedback?"

PM: "Support tickets about lost changes, and our churn survey mentions it as a top frustration"

→ "That's solid evidence. Why tackle this now — what makes it more important than other things on the roadmap?"

PM: "We're losing deals to competitors who have it. Sales flagged it as a top blocker."

→ "Makes sense. Who specifically has this problem — all users or a subset?"

PM: "Mostly teams with 3+ members working on the same project"

→ "Got it. If we ship real-time collaboration, what would success look like?"

PM: "Fewer support tickets about version conflicts, higher team retention, faster document turnaround"

→ "For MVP, what's the smallest version that tests whether this helps?"

PM: "Just cursor presence and live text sync — no comments, no suggestions mode yet"

→ "Any compliance or security concerns? Data residency, access controls?"

PM: "Standard stuff — users should only see docs they have access to. No new regulatory concerns."

→ "Great. I'll draft a PRD with what we've covered. I'll flag open questions like
   conflict resolution strategy and max concurrent editors as Q-001, Q-002."
```

## Story Expansion Example

```markdown
### US-001: View shared document

**As a** team member, **I want** to open a shared document and see who else is viewing it **so that** I know who's working on it.

**Priority:** P0

**Acceptance Criteria:**
- **AC-001.1:** Given I have access to a document, when I open it, then I see the document content and a list of active viewers
- **AC-001.2:** Given another user opens the same document, when they join, then their avatar appears in the viewer list within 2 seconds
- **AC-001.3:** Given a user closes the document, when they leave, then their avatar is removed from the viewer list
```

## Epic Generation Example

```markdown
## Epic: Real-Time Document Collaboration

**Objective:** Enable team members to edit documents simultaneously without version conflicts.

**Stories:**
- US-001: View shared document with active viewer presence
- US-002: See other users' cursors in real time
- US-003: Live text sync across all connected clients

**Success Criteria:** 90% reduction in support tickets about version conflicts within 30 days of launch.
```

## Goals & Success Metrics Example

```markdown
## Goals & Success Metrics

- **Goal 1:** Reduce version conflicts in collaborative documents
  - **Metric:** Support tickets tagged "version conflict"
  - **Target:** 90% reduction within 30 days of launch
- **Goal 2:** Increase team engagement with shared documents
  - **Metric:** % of documents with 2+ concurrent editors per week
  - **Target:** 40% of active documents within 60 days
```

## Risks & Mitigations Example

```markdown
## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Conflict resolution fails under high concurrency | High | Med | Use OT/CRDT algorithm; load test with 20+ concurrent editors |
| Latency spikes degrade real-time experience | Med | Med | WebSocket connection with fallback to polling; regional edge servers |
| Users confused by presence indicators | Low | Low | Onboarding tooltip; user research during beta |
```
