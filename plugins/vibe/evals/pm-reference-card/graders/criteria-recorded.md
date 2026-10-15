---
type: llm
focus: { source: file, path: session/.closedloop-ai/decision-tables/session.md }
---
PASS only if all of these hold in the session decision table:
1. The Acceptance Criteria section has separate criteria for the card's drop shadow, the larger title size and the bold title weight, each sourced to the reference image and each naming a design token (for example --shadow-card, --text-xl, --weight-bold).
2. The Checks log records that the reference image was read (a "Reference read" line or equivalent naming the image path and what it shows).
3. The Checks log records a comparison of a screenshot of the built card with the reference image, with its result.
FAIL if any of the three is missing.
