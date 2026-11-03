# Rung Examples

These are illustrations, not rules for any particular repository. Each shows the class
sentence and the rung chosen; some also note why a higher rung did not fit. Before acting, find the
equivalent mechanism in the repository you are in (step 3 of the skill).

## Rung 1: architecture or types

Example. Class: "passed a raw user id where an organization id was expected, causing a
cross-tenant read." Both were plain strings, so nothing stopped the swap.

Prevention: give each id its own type (a branded type, newtype, or value class) and make
the lookup accept only the organization id type. Every misuse becomes a compile error,
including ones nobody has written yet.

Example. Class: "updated the status without clearing the error field, leaving a success
record that still shows an error." Prevention: replace the two fields with one tagged
union (success or failure with its error), so the inconsistent pair cannot be built.

## Rung 2: static analysis

Example. Class: "imported the internal client directly instead of the wrapper that adds
auth headers." The import path is syntactic, so a lint rule that bans that import outside
the wrapper's own folder catches every instance. Why not rung 1: the internal client
must stay importable for the wrapper itself.

Example. Class: "hard-coded a developer's local path in a committed file." A source-gate
script or pre-commit check that rejects home-directory paths in tracked files catches
it. If the repository already has such a script, add the pattern there rather than
writing a second script.

## Rung 3: guard test

Example. Class: "added a new route without registering its permission check." No single
line is wrong, so a lint rule cannot see it. A test that iterates every registered route
and asserts each one declares a permission catches the next unregistered route too.
Why not rung 1: the router API is shared and reshaping it is a separate project, so
propose that as a follow-up.

Example. Class: "the retry path and the first-attempt path validated input differently."
A test that runs one shared table of inputs through both paths and asserts identical
decisions pins the parity.

Example. Class: "a skill or prompt file referenced a resource by absolute path, which
broke on other machines." A test that scans every skill file for absolute paths and
checks that each relative link resolves catches it across the whole plugin.

## Rung 4: owning AGENTS.md rule

Example. Class: "chose the generic list component for a dense data view that needs the
virtualized one." Which component fits is a judgment call. One line in the AGENTS.md of
the folder that owns those components (not the repository root) names the rule and the
size threshold: "Use the virtualized list for views that can exceed a few hundred rows;
the generic list renders every row."

If that line already existed and was ignored, step 5 of the skill applies instead: look
for a mechanical signal (for example, a guard test that flags generic lists fed by a
paginated query) before adding more prose.

## Rung 5: memory or notes hint

Example. Class: "ran the integration suite against the shared dev database, which a
parallel session was resetting." This is environment knowledge, not a code rule. A
repository memory or notes entry describing the isolated database setup helps the next
session; it enforces nothing. If the launcher could detect a shared database and
refuse to run, that check is the prevention (rung 2 or 3) and the note only
supplements it.
