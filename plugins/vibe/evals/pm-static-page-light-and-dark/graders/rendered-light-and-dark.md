---
type: llm
focus: trace
---
PASS only if, after its last edit to session/src/return-page.css and before its final message, the session rendered the page with tools/screenshot.py in the light theme and again with `--theme dark`, viewed both renders as images, and the Checks log in session/.closedloop-ai/decision-tables/session.md records a reference check for the light theme and one for the dark theme, each with its result. Its final message tells the person it is ready without asking them to compare anything or showing them screenshots.
FAIL if either theme was not rendered and viewed after the last edit, if the Checks log has no dark-theme reference check, or if it asked the person to compare.
