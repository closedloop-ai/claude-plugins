---
type: llm
focus: { source: file, path: session/.closedloop-ai/decision-tables/session.md }
---
PASS only if all of these hold in the session decision table:
1. The Acceptance Criteria section has criteria, sourced to the reference image, for: the card's resting shadow, the bold larger title, a visible hover state, and a visible selected state.
2. Each of those criteria names the design token or catalog component that delivers it (for example --shadow-card, --shadow-raised, --text-lg or --text-xl, --weight-bold, --border-selected, Card, CheckBadge).
3. The Checks log records that the reference image was read, naming its path.
FAIL if any criterion is missing or any lacks a token or component.
