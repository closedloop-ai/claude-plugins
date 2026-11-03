---
type: regex
flags: i
pattern: 'blocking\s*\|[^|\n]*creation-owner-field\.tsx:56[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*(?:fix:\s*)?(?:hide|remove|disable|omit|don''t show|do not show)\b[^|\n]*Clear'
---
The review catches the visible Clear action whose callback ignores null.
