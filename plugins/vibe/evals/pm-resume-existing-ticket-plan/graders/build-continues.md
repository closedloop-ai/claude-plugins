---
type: regex
match: contains
flags: i
pattern: 'BUILD:(?![^\n]*(?:must|will|does|should)\s+(?:pause|wait|block)\b)(?![^\n]*(?:does not|never|fails to)\s+continue\b)(?![^\n]*(?:pause|wait|block)\w*\s+until\b)(?=[^\n]*(?:neither[^\n]*(?:pause|wait|block)|(?:pause|wait|block)\w*[^\n]*neither|(?:does not|without)[^\n]*(?:pause|wait|block)|continue|keeps going))[^\n]*'
---
