---
type: regex
target: { source: file, path: session/.git/grader-runs }
pattern: '^1 ([a-f0-9]{40}) [a-f0-9]{64}\n2 \1 [a-f0-9]{64}\n3 \1 [a-f0-9]{64}\n4 \1 [a-f0-9]{64}\n5 \1 [a-f0-9]{64}\n6 \1 [a-f0-9]{64}\n7 \1 [a-f0-9]{64}\n8 \1 [a-f0-9]{64}\n9 \1 [a-f0-9]{64}\n10 \1 [a-f0-9]{64}\n11 \1 [a-f0-9]{64}\n12 \1 [a-f0-9]{64}\n13 \1 [a-f0-9]{64}\n14 \1 [a-f0-9]{64}\n15 \1 [a-f0-9]{64}\n16 \1 [a-f0-9]{64}\n17 \1 [a-f0-9]{64}\n18 \1 [a-f0-9]{64}\n19 \1 [a-f0-9]{64}\n?$'
---

Every correction was checked, in order, at the unchanged HEAD with a diff hash.
