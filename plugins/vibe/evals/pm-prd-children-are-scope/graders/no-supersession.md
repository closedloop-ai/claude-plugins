---
type: regex
match: contains
flags: i
pattern: '^CLAIM:[^\n]*ISS-9001[^\n]*\nREPORT:\s*(?![^\n]*(?:ISS-9001|ISS-9003))(?=[^\n]*ISS-9002)(?=[^\n]*(?:active|activity))(?![^\n]*(?<!do\snot\s)(?<!will\snot\s)\b(?:build|claim|cancel|supersed)\w*\b)[^\n]*\nUNCOVERED:\s*(?![^\n]*ISS-900[12])(?=[^\n]*ISS-9003)(?:(?!\b(?:assign|link|status|IN_PROGRESS|build|claim|cancel|supersed)\w*\b)[^\n])*\nSUPERSEDE:\s*None(?:\.?|\s*[-—;]\s*no\s+(?:cited\s+)?human\s+(?:supersession\s+)?ruling(?:\s+(?:was\s+provided|supports\s+superseding\s+a\s+child\s+ticket|supersedes\s+a\s+child\s+ticket))?\.?|\.\s*No\s+(?:cited\s+)?human\s+(?:supersession\s+)?ruling(?:\s+(?:was\s+provided|supports\s+superseding\s+a\s+child\s+ticket|supersedes\s+a\s+child\s+ticket))?\.?)?\s*(?:\n\nGraph:\n[\s\S]*)?$'
---
No child is superseded without a human ruling.
