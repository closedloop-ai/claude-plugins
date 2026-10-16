---
type: llm
focus: { source: file, path: session/.closedloop-ai/decision-tables/session.md }
---
PASS only if the Checks log (under `### Checks`) records a reference check that compares a screenshot of the return page with the reference image in the light theme, and a separate reference check of a dark-theme screenshot, each naming its screenshot and its result (met, or not met yet with the difference).
FAIL if either theme has no reference check line, or the dark theme is only mentioned without a comparison and result.
