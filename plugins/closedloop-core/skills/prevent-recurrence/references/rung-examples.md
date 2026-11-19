# Rung Examples

These are illustrations, not rules for any particular repository. Before acting, find
the equivalent mechanism in your repository (step 3 of the skill).

## Rung 1: architecture or types

Example. Class: "passed a raw user id where an organization id was expected, causing a
cross-tenant read." Both were plain strings, so nothing stopped the swap.

Prevention: give each id its own type (a branded type, newtype, or value class) and make
the lookup accept only the organization id type. Every misuse, present or future, becomes a
compile error.

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
it. Extend an existing script rather than writing a second one.

## Rung 3: guard test

Example. Class: "added a new route without registering its permission check." No single
line is wrong, so a lint rule cannot see it. A test that iterates every registered route
and asserts each one declares a permission catches the next unregistered route too.
Why not rung 1: reshaping the shared router API is a separate project; propose it as a
follow-up.

Example. Class: "the retry path and the first-attempt path validated input differently."
A test that runs one shared table of inputs through both paths and asserts identical
decisions pins the parity.

Example. Class: "a skill or prompt file referenced a resource by absolute path, which
broke on other machines." A test that scans every skill file for absolute paths and
checks that each relative link resolves catches it across the whole plugin.

## Rung 4: owning instruction rule

Example. Class: "chose the generic list component for a dense data view that needs the
virtualized one." Which fits is a judgment call, so one line in the AGENTS.md of the
folder owning those components (not the root) names the rule, threshold and why: "Use
the virtualized list for views that can exceed a few hundred rows; the generic list
renders every row."

Example. Class: "a test shared mutable fixture state across cases." The line lives in
the test helpers' AGENTS.md, but test files sit in every package. A `.claude/rules`
file with `paths: "**/*.test.ts"` and the same line reaches Claude at every test file;
the AGENTS.md copy stays for Codex.

Example. If that lesson is high value, a PostToolUse hook both harnesses register
returns the line as `additionalContext` on test file edits, so Codex gets it too; still
advisory.

## Rung 5: memory or notes hint

Example. Class: "ran the integration suite against the shared dev database, which a
parallel session was resetting." A notes entry describing the isolated database setup
helps the next session but enforces nothing. If the launcher could detect a shared
database and refuse to run, that check is the prevention (rung 2 or 3) and the note only
supplements it.
