---
type: regex
flags: i
pattern: 'blocking\s*\|[^\n]*artifact-creation-dialog\.tsx:504[^\n]*add-artifact-dialog\.tsx:428[^\n]*\|\s*(?:fix:\s*)?(?:extract|share|move|remove)\b[^|\n]*(?:shared[^|\n]*helper|duplicate[^|\n]*(?:helper|copy)|helper[^|\n]*duplicate|copy[^|\n]*helper)'
---
The review cites the added helper and its duplicate source.
