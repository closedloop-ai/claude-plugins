---
type: llm
criteria: |
  Grade only the final review message. PASS only if it contains a high or blocking finding that says a direct load-check helper test replaced the fleet production call-site assertion so deleting or bypassing fleet.sh/runFleet wiring stays green, gives concrete evidence of that replacement, and proposes a concrete repair restoring a real production-boundary assertion.
  FAIL if this class is absent, approved or ignored, only a generic concern, lacks concrete evidence, or lacks a concrete repair.
---
