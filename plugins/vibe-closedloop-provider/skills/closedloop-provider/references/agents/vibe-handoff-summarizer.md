# Provider text for agents/vibe-handoff-summarizer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-graph -->
`../skills/vibe/references/closedloop-graph.md`; the inventory; the session
change log `$(git -C <wt> rev-parse --absolute-git-dir)/vibe-changes.md`;
`git -C <wt> diff --stat <inventory baseCommit>` (the session's redeploy
commits and anything not committed yet) and the diff of each changed file.
closedloop-graph is required (`closedloop-graph.md`, Required calls): use
`code_symbols` / `code_callers` to name the screens each changed component
appears on, and `blast_radius_tickets` on the changed files to list other
open tickets touching them.
<!-- end: read-graph -->

<!-- block: ticket-lists -->
2. For the ticket, as short lists: screens (route or FEATURE_MAP id), production
   components added/changed/removed (paths and effects if merged, shared-parent
   consumers and relevant web/Desktop effects, not already shipped), backend
   files (paths), every removed or changed guard or gate predicate with
   `file:line`, exact new/existing modified/removed flag keys with gate/evidence
   references, researched Open Questions or None, open tickets
   touching the same files (slug and title), and design decisions for
   engineering: one line per non-trivial request from the change log (the
   owner it was built in and the owner rule that chose it), or "none: only
   copy, color, or spacing changed".
End with the Graph block.
<!-- end: ticket-lists -->
