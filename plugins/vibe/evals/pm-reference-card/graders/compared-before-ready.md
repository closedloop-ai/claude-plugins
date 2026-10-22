---
type: llm
focus: trace
---
PASS only if, after its last edit to session/src/project-card.css and before its final message, the session rendered the card with tools/screenshot.py and viewed that render as an image and compared it with the reference (the attached image or images/1.png), and its final message tells the person it is ready without asking them to confirm the comparison or showing them screenshots.
FAIL if it said ready without a render after its last edit, or asked the person to compare.
