# Provider text

A line of the form ``> Provider `<capability>` (block `<id>` of `<file>`)`` in a
vibe skill, reference or agent stands for text of the provider bound to the
session, when there is one. Its block is followed in place of any text between
`<!-- generic: <id> -->` and `<!-- end generic: <id> -->` just above the line.
A capability joined with `+` is served when any one of them is bound. A stub whose capability the binding
does not hold (its connection did not answer, or the repository has not opted
in) keeps its generic text. The text between `<!-- provider-rule -->` and
`<!-- end provider-rule -->` is for a reader of the raw file only.

With no provider bound (the check's `provider.state` is not `bound`), follow
the generic text and read nothing below.

When this conversation's check bound a provider, it wrote every vibe file that
has stubs, already assembled for that binding, into one folder per repository
and provider under `~/.codex/vibe/provider-text/`. With
`P=<plugin-root>/skills/vibe/scripts/provider.mjs` (add `--worktree "<wt>"` once
the session exists):

- Find the folder: `node $P tree` prints it. Or read
  `~/.codex/vibe/provider-text/index.json`, take the folder it names for this
  session's repository main checkout (every worktree of a repository shares
  it; outside a checkout, the working folder), and use it only when its
  `binding.json` has that
  `repoRoot` and, as `vibeRoot`, the vibe plugin folder these files were loaded
  from. When `tree` exits 3 or the folder does not match, run the plugin
  version check again, then look again.
- A file you open yourself (a reference, INSTALL.md, an agent file you hand to
  a subagent): read the file at the same relative path in that folder, in place
  of the raw file and never as well. A file with no copy there has no stubs:
  read it as it is.
- A file already in your context (a loaded SKILL.md): read its blocks file
  beside it there (`SKILL.blocks.md`). Each `<!-- block: <id> -->` there
  replaces the generic region of the same id; a stub with no block there keeps
  its generic text.
- Last resort, when the check could not write the folder: `node $P assemble <file>`
  (or `assemble --blocks <file>` for a file in context) prints the path of that
  one file assembled, and `node $P block <capability> <file> <id>` prints one
  block.

In a session the check bound, every answer from `assemble`, `block`, `path` or
`data` other than the text is a stop:

- `provider: ...` (exit 3) or `provider-broken: ...` (exit 4): stop that step
  and tell the person what it printed. Never follow the generic text in its
  place; only an unbound session does.
- Any other failure (exit 2, a usage or file error printed on stderr): stop
  that step and report what it printed; never follow the generic text in its
  place. Nothing is written on a failure.

In provider text, `provider:<file>` names a whole provider reference:
`node $P path <capability> provider:<file>` prints where it is.

A worker launched through the Claude launcher gets its own file with this
text already in place; it follows the same rule for every other file it reads.
