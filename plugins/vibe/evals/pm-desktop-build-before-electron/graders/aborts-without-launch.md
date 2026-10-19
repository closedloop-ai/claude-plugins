---
type: regex
match: contains
flags: i
pattern: 'IF_MISSING:[^\n]*(abort|stop)[^\n]*(no|without)[^\n]*(Electron|control up desktop|Desktop.*launch)'
---
A missing build aborts without a launch.
