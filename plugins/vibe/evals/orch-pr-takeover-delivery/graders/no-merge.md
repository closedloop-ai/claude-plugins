---
type: regex
match: contains
flags: i
pattern: 'PR:.*(?:open|unmerged).*(?:do not arm auto.merge|don.t arm auto.merge|never arm auto.merge|auto.merge not armed|auto.merge stays off|without auto.merge|no auto.merge|no merge or auto.merge|never merge or auto.merge)'
---
The skill leaves the PR open without auto-merge.
