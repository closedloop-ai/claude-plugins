---
type: regex
match: contains
flags: i
pattern: 'STEPS:[\s\S]*((refresh|updat|rewrit|regenerat)\w*[^\n]{0,60}(body|description)|(body|description)[^\n]{0,60}(refresh|updat|match))'
---
The pull request body is refreshed from the session record to match the diff.
