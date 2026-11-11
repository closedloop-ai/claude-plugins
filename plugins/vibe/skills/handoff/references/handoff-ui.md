# Handoff: UI steps

Lines that start `> Provider` follow `../../vibe/references/provider-text.md`.

Moved out of `../SKILL.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: step-4-storybook -->
## 4. Storybook

Read-only `vibe-storybook-decomposer` advises on components/stories/catalog
gaps in handoff mode: its precedent search covers every story or shared
component the session added, retitled or moved, checked against the Placement
<!-- generic: placement-record -->
blocks in the writer's local plan. Each placement goes on the handoff summary's
Storybook placement line; the SAME writer logs each Conflict with its
audience, never to the person.
Every new story follows the repo's Storybook taxonomy document, a v1.0
<!-- end generic: placement-record -->
> Provider `tickets+recipes` (block `placement-record` of `handoff/handoff-ui.md`)
story file is never edited beyond a compile-only repair and any other existing
story file keeps its title and tag
(`../vibe/references/guardrails-ui.md`, "Storybook taxonomy"); the inventory's
`v1Stories` and `retitledStories` block handoff, judged by the scheme of the
session's base (`storybookScheme`: under the lifecycle scheme, the
`<Level> v1.0/` roots and the `deprecated` tag are v1.0). Its `compileOnlyV1Repairs`
do not; the ticket worker puts each on the Engineering checklist. Every
`lost-story-id` finding, a lost story ID or a reference still naming one,
blocks too, because a stale ID breaks any spec that still names it; the SAME
writer fixes them. Story files
under the `Start Here/` root are exempt from the v1.0 freeze and the title,
tag and retitle checks: Start Here is unversioned
and its Version History is edited by every Storybook release. Resume the SAME writer to perform every extraction, story and catalog
source change. Read-only verify footprint mode measures the sidebar and
reports remaining problems; they return to the writer, never another author.
Collect Design Review evidence from the verified final diff and existing
Storybook tooling: added/changed/removed components and stories, actual IDs
and direct links, controls/Docs/plays declared versus inspected/executed,
intentional ID/category moves/sidebar folds and retained state access. Keep
actual compiled footprint/canonical catalog reports and unresolved advisories.
Source inspection alone does not clear a compiled warning or prove appearance.
<!-- end: step-4-storybook -->

<!-- block: running-app-verification -->
Before the first commit or push, dispatch read-only `vibe-verify-worker` control
mode on every locally served uncommitted candidate screen, naming HEAD plus
<!-- generic: control-verification -->
diff/tree hashes. It drives the running app headless (Playwright, or the
browser harness the repository documents), never a visible window, and keeps
its captures in private Git storage. Return captures, console/page errors,
network evidence and baseline comparisons with what each proves.
<!-- end generic: control-verification -->
> Provider `recipes` (block `control-verification` of `handoff/handoff-ui.md`)

A static or generated page control cannot drive (an HTML page a script or a
main-process module writes, such as Desktop's sign-in return page) is
rendered directly instead: the verify worker
produces its HTML with the repo's own generator, opens it headless and
captures it in light and dark wherever it supports both. "Could not drive" is
not accepted for such a page. Any other surface it can neither drive nor
render comes back with the exact control command and the reason, never as
verified. A console error, page error, failed request or
broken screen this session caused resumes the SAME writer in fix mode, then
steps 3 to 6 and this check again before committing. Owned prototype sessions skip this check
and record why: a mockup changes no web app or Desktop screen. The build loop
has no control step; this check runs only here. The writer's single control
read for an acceptance criterion (`../vibe/references/quality-loop.md`,
"Acceptance criteria before ready") is not this check. Its evidence goes into the
Design Review's Visual evidence and the Handoff Running app checks line,
separated from source-only claims.
<!-- end: running-app-verification -->
