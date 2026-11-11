# Provider text

A line of the form ``> Provider `<capability>` (block `<id>` of `<file>`)`` in a
vibe skill, reference or agent stands for text of the provider bound to the
session, when there is one. Its block is followed in place of any text between
`<!-- generic: <id> -->` and `<!-- end generic: <id> -->` just above the line.
A capability joined with `+` needs each. With
`P=<plugin-root>/skills/vibe/scripts/provider.mjs` (add `--worktree "<wt>"` once
the session exists):

- A file you open yourself (a reference, INSTALL.md, an agent file you hand to
  a subagent): run `node $P assemble <file>` and read the file whose path it
  prints, in place of the raw file and never as well. It is the file with every
  served stub already replaced and its generic regions dropped, and with no
  provider bound it is the generic text.
- A file already in your context (a loaded SKILL.md): run
  `node $P assemble --blocks <file>` once and read the file whose path it
  prints. Each `<!-- block: <id> -->` there replaces the generic region of
  the same id; a stub with no block there keeps its generic text.
- One stub alone: `node $P block <capability> <file> <id>` prints its block.

Each command has only these other answers:

- `provider: ...` (exit 3): no provider with that capability is bound. Skip
  the stub and follow the generic text.
- `provider-broken: ...` (exit 4): the session is bound to a provider whose
  text or binding record cannot be read. Never follow the generic text in its
  place. Stop that step and tell the person the provider is broken, with the
  printed reason and fix.
- Any other failure (exit 2, a usage or file error printed on stderr): stop
  that step and report what it printed; never follow the generic text in its
  place. Nothing is written on a failure.

In provider text, `provider:<file>` names a whole provider reference:
`node $P path <capability> provider:<file>` prints where it is.

A worker launched through the Claude launcher gets its own file with this
text already in place; it follows the same rule for every other file it reads.
