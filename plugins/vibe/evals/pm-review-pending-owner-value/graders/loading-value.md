---
type: regex
flags: i
pattern: 'blocking\s*\|[^|\n]*creation-owner-field\.tsx:44[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*(?:fix:\s*)?(?:render|show|use|wait|hold|read)\b[^|\n]*isPending'
---
The existing review rule catches a loaded-looking value during the pending read.
