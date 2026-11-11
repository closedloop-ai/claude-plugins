# Provider text

A line of the form ``> Provider `<capability>` (block `<id>` of `<file>`)`` in a
vibe skill, reference or agent stands for text of the provider bound to the
session, when there is one. Print it with
`node <plugin-root>/skills/vibe/scripts/provider.mjs block --worktree "<wt>" <capability> <file> <id>`
(before the session exists, leave out `--worktree`) and follow what it prints
in place of any text between `<!-- generic: <id> -->` and
`<!-- end generic: <id> -->` just above the line. When it prints
`provider: ...` instead (no provider with that capability is bound), skip the
line and follow the generic text. A capability joined with `+` needs each.

In provider text, `provider:<file>` names a whole provider reference:
`node <plugin-root>/skills/vibe/scripts/provider.mjs path --worktree "<wt>" <capability> provider:<file>`
prints where it is.

A worker launched through the Claude launcher gets its own file with this
text already in place; it follows the same rule for every other file it reads.
