---
type: regex
flags: i
pattern: 'blocking\s*\|[^|\n]*documents-create-action\.tsx:77[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*(?:fix:\s*)?(?:use|gate|wait|replace|switch)\b[^|\n]*(?:isReady|useFeatureFlagGate)'
---
The review blocks the unresolved flag swap at the original file and line.
