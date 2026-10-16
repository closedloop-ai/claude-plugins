---
type: llm
focus: { source: file, path: session/.closedloop-ai/decision-tables/session.md }
---
PASS only if all of these hold in the session decision table:
1. New Acceptance Criteria, sourced to the second screenshot, cover the panel's shadow, the larger heading size and the bold heading weight, each naming a design token.
2. The Checks log records that both reference images were read (images/1.png and images/2.png).
3. The Checks log records a comparison of a fresh render with images/2.png that covers the button as well as the changed properties, and the earlier "met" by source trace is not the only evidence for the visual criteria.
FAIL if any is missing.
