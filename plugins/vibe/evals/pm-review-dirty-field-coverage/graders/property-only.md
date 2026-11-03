---
type: regex
flags: i
pattern: 'blocking\s*\|[^\n]*artifact-creation-dialog\.tsx:167[^\n]*\|\s*(?:fix:\s*)?(?:include|track|compare|derive|compute)\b[^|\n]*(?:dirty[^|\n]*(?:fields?|values?)|(?:fields?|values?)[^|\n]*dirty)'
---
The review catches a property-only edit that bypasses discard confirmation.
