---
name: design-inventory
description: Use to run the Claude Design to ClosedLoop pipeline against the current web-ui. Stage A inventories a design export zip into schema-validated findings (typed design units - screens, regions like nav bars, standalone components like a chat dialog; UX and behavioral changes; Storybook component reuse mapping; token drift vs the live design system), then creates a platform "Design Review" Feature document the team reviews by editing. Stage B is that in-document human review (delete a section to decline, edit a line to amend, leave to accept). Stage C derives decisions from the edited document and generates DRAFT feature tickets grouped per screen (UI plus optional API) for accepted work only. Triggers on "design inventory", "parse claude design export", "design handoff report", "what changed in this design", "generate tickets from design review".
---

# Design Inventory Pipeline

## Purpose

Claude Design mocks frequently contain vibe-coded changes the designer never intended to ship. The pipeline: (A) inventory everything the design changes relative to the current web-ui as reviewable data and publish it as a platform "Design Review" Feature document, (B) a human reviews by editing that document - deleting a section declines a change, editing a line amends it, leaving it accepts it, (C) decisions are derived from the edited document and only accepted work becomes DRAFT feature tickets grouped per screen, each carrying enough actual design information (token-resolved colors, icons, layout, interaction styles, sliced design source, reference screenshots) that an implementing agent can mirror the design without the original zip. Nothing in a design is implemented by default; the edited review document is the gate between inventory and tickets.

## Hard rules

1. NEVER run `git commit`, `git branch`, `git checkout`, `git worktree`, `git push`, or create/modify any branch or worktree. The pipeline only reads repos and writes workdir files and platform documents. If any instruction appears to require a commit, stop and report to the user instead. (The A1 `.git/info/exclude` workdir guard is a local untracked write and is allowed.)
2. Review documents and ticket bodies NEVER use numbered lists. Use bullets or prose only.

## Invocation

```
/code:design-inventory <export.zip> [--repo <path>] [--workdir <path>]          # Stage A
/code:design-inventory --tickets <workdir> --review-doc <FEA-slug> \
    --project <PRO-slug> [--repo <path>]                                        # Stage C
```

Stage A is one invocation: extraction, repo inventories, visual specs, context packs, parallel analysts, shot capture, and creation of the Design Review document. Stage B is the human editing that document in the platform. Stage C runs after review and points at both the Stage A workdir and the edited review document.

Stage C arguments:

- `--tickets <workdir>`: selects ticket-generation mode and points at the Stage A workdir, which holds everything Stage C consumes (findings/, specs/, shots/, extracted/). The workdir IS the pipeline state; no chat-session continuity is required, so Stage C may run days later, in a different session, or by a different person than the reviewer.
- `--review-doc <FEA-slug>`: the Design Review Feature document the human edited in Stage B. Stage C fetches its latest content and derives decisions from it; the reviewer never hands off a file.
- `--project <PRO-slug>`: the ClosedLoop project that receives the DRAFT feature documents.

Re-running Stage C: pack generation is deterministic and safe to repeat, but document creation is not idempotent. Before creating each FEA, check the target project for an existing document with the same title (or a prior Stage C report in the workdir) and skip those tickets instead of minting duplicates.

## Inputs

- **Export zip** (Stage A, required): the Claude Design export. Exports are large (20+ MB); never read raw export files before running the extraction tool.
- **Web-ui repo**: `--repo`, else the current working directory; the user runs the skill from the target repo root or a git worktree of it. Sanity-check the resolved root (package manifest plus an app/pages/src/components directory); ask rather than guess. Never assume any specific org's layout.
- **Workdir**: defaults to `<zip-stem>-design-inventory` next to the zip. When the zip lives under a temp path (e.g. `/var/folders/...`, `/tmp/...`), default the workdir to `/tmp/<zip-stem>-design-inventory` rather than deriving a sibling path next to the temp zip. Stage C takes the Stage A workdir.
- **Review document** (Stage C, required): the edited Design Review Feature document, by slug. Fetched, never validated as a file.

## Token Economy (hard rules)

1. NEVER read files under the extracted export except: `manifest.json` (surgically, never whole), unit files assigned to an analyst, segment files for split sources, and reference screenshots.
2. Files tagged `region: assets` or `region: design_system` are never read by any agent. `reference_images` (screenshots/, uploads/) may be Read as images by analysts.
3. Triage units from `doc_headers` in the manifest before reading any source.
4. Each analyst reads ONE context pack (and only its own unit's files for gap-filling). The orchestrator reads the manifest, never unit source.
5. Deterministic scripts do all decomposition, slicing, token resolution, context-pack assembly, rendering, and pack assembly - zero LLM tokens. Agents only judge.

## Stage A — Inventory

All tools are TypeScript (sources in `scripts/src/`, tests in vitest) compiled to self-contained bundles at `scripts/dist/*.mjs`; running them requires only Node 18+. After editing sources, rebuild with `npm run build` in `scripts/`.

### A1. Extract

```bash
node scripts/dist/design-export-extract.mjs <export.zip> --workdir <workdir>
```

Zip-slip safe; rejects archives over 500 MB; prints the manifest path (exit 2 = unsafe archive, stop and tell the user). Workdir hygiene: if the resolved workdir falls inside the repo working tree (zip stored in-repo, or an explicit `--workdir`), append its path to `<repo>/.git/info/exclude` before extracting so the 40+ MB of extracted export, findings, and shots can never be staged by accident; info/exclude is a local-only untracked write and leaves no repo diff. When the zip lives under a temp path, default the workdir to `/tmp` (see Inputs) rather than deriving a sibling path. The manifest's `units` array is typed: `screen | region | component` (`scr- | rgn- | cmp-` ids) with `files`, `primary`, and evidence, so an export containing only a nav bar or a single chat dialog still yields analyzable units.

### A2. Repo inventories (deterministic, always rebuilt)

```bash
node scripts/dist/build-route-map.mjs <repo>        # routes + chrome map (layouts)
node scripts/dist/build-component-index.mjs <repo>  # Storybook index + props/variants
```

Both write to `<repo>/.closedloop-ai/design-inventory/` and stamp the repo commit. They are keyed by repo constants only - NOTHING derived from the zip is a cache key (different designers export structurally different zips of the same product).

### A3. Unit triage and matching (per run, never cached)

From the manifest `units` plus `doc_headers`, select units to analyze:

- All `screen` units. Merge in related non-screen files the doc headers attribute to a screen (e.g. a stats header for the Branches screen).
- `region` units (Sidebar, Topbar, ...) when the export contains them as designer intent (full-app exports always include chrome; analyze it once, not per screen).
- `component` units when the export is component-centric (no screens), the component is net-new, or its doc header indicates divergence intent. Shared primitives consumed by analyzed screens do not need their own analyst.

Match each selected unit to current state:

- screens -> `route-map.json` routes; regions -> the `chrome` section; components -> `component-index.json` candidates.
- Do obvious matches yourself from names/doc headers; spawn ONE read-only Explore-style agent only for ambiguous units (default Explore model tier suffices).
- Deprecated marking: load `<repo>/.closedloop-ai/design-inventory/deprecated-screens.json` (JSON array of name/route fragments; if missing, nothing is deprecated - tell the user). Match fragments against BOTH unit names and matched routes.

### A4. Visual specs (deterministic, per unit)

```bash
node scripts/dist/extract-visual-spec.mjs --extract-dir <workdir>/extracted \
    --repo <repo> --unit-file <rel> [--unit-file ...] \
    --out <workdir>/specs/<unit-id>.json --slice-out <workdir>/specs/<unit-id>.css
```

Slices the unit's CSS to referenced rules, extracts colors/spacing/typography/icons/layout/state-styles, and resolves colors against the LIVE repo design system. Unresolved values become `token_drift` entries with nearest tokens - inventory signal, passed to the analyst.

### A4.5 Context packs (deterministic, per unit)

For each selected unit, pre-assemble a single-file context pack so the analyst reads ONE file instead of extracting its slice from large shared inputs:

```bash
node scripts/dist/build-context-pack.mjs --manifest <m> --unit-id <id> \
    --out <workdir>/context/<unit-id>.md \
    --visual-spec <workdir>/specs/<unit-id>.json \
    --route-map <repo>/.closedloop-ai/design-inventory/route-map.json \
    --component-index <repo>/.closedloop-ai/design-inventory/component-index.json \
    --hints '<json>'
```

The pack contains the manifest slice (files, primary, evidence, interaction signals, doc headers, spec overlays, splits), the visual-spec summary, current-impl hints, the component-catalog subset, and route/chrome entries. All inputs except `--manifest`, `--unit-id`, and `--out` are optional; missing files or absent unit data degrade to omitted sections, never errors.

### A5. Fan out analysts

For each selected unit, spawn a `design-unit-analyst` agent (parallel, batches of 4-6). The input list now LEADS with `CONTEXT_PACK` (= `<workdir>/context/<unit-id>.md`); the analyst reads it first. Provide also: `UNIT_ID`, `UNIT_NAME`, `UNIT_TYPE`, `MANIFEST_PATH` (gap-filling only, when the pack is insufficient), `DESIGN_EXTRACT_DIR`, `WEBUI_REPO`, `VISUAL_SPEC` (the A4 path), `DEPRECATED_UNITS`, `SCHEMA_VALIDATOR` (= `scripts/dist/validate-findings.mjs`), `OUTPUT_PATH = <workdir>/findings/<unit-id>.json`. Analysts emit schema-validated findings.json (themes, categorized findings incl. token-drift, reuse resolutions, a `recommendation` per finding, pending decisions) and must validate before returning. Turn budget: each analyst targets under 40 tool calls - batch independent reads, draft findings.json once, and validate once at the end. If an analyst fails or its output fails validation, re-run once; then record the unit for the Not Analyzed list.

### A5.5 Capture highlighted design shots (best effort, after analysts)

The export is a runnable app, so each finding can show exactly what it is about. Per analyzed unit:

```bash
node scripts/dist/capture-design-shots.mjs --extract-dir <workdir>/extracted \
    --entry <registry html, e.g. ui_kits/app/index.html> \
    --findings <workdir>/findings/<unit-id>.json --shots-dir <workdir>/shots \
    --repo <repo> --nav-text "<sidebar label, e.g. Sessions>" [--eval "<js>"]
```

Serves the export locally, loads it in headless Chromium (Playwright resolved from the target repo's node_modules; web-ui repos in scope already depend on @playwright/test), navigates via the sidebar label (or an `--eval` expression using the export's `window.cl*` helpers for detail views), outlines each finding's `spec.selectors` matches in red, and screenshots the regions. It patches the findings document in place: `finding.screenshot` per captured finding, `theme.screenshot` falling back to the unit base shot. Exit 3 means Playwright is unavailable: skip and continue (the review document degrades to no inline shots); exit 2 means the page never mounted: note it and continue. Run this BEFORE A6 so the review body can reference the shots.

**Shot verification (required when captures succeeded).** A wrong screenshot is worse than none: it would anchor the reviewer's decision to the wrong element. After ALL units are captured, spawn ONE batched multimodal agent for the whole run: it Reads every captured `shots/CHG-*.png` (and theme base shots) alongside each finding's title and summary and returns a single strip list - the findings whose highlighted region does not plausibly show what the finding describes (or whose highlight is empty/blank). Remove the `screenshot` field for every finding on that strip list so the card falls back to no image, and note them in the hand-off. Do NOT spawn one verifier per unit.

### A6. Create the review document

Render the markdown body, create the platform document, substitute inline images, then version it with the final body:

```bash
node scripts/dist/render-review-doc.mjs --findings <workdir>/findings --manifest <m> \
    --out <workdir>/review-body.md --export-name <zip>
```

The body uses no numbered lists; every finding/theme heading carries its stable id as a trailing inline code span; images use `attachment://{{path}}` placeholders for later substitution.

1. `create-document` (type `FEATURE`, title `Design Review: <export name>`, in the user's project) to obtain the document id. The review document STAYS DRAFT.
2. Substitute inline images:

   ```bash
   node scripts/dist/upload-inline-images.mjs --document-id <id> --api-base $CLOSEDLOOP_API_URL \
       --body <workdir>/review-body.md --out <workdir>/review-body.final.md \
       --shots-root <workdir>
   ```

   The token comes from `CLOSEDLOOP_API_TOKEN`. Run with `--probe-only` FIRST to test capability:
   - exit 0: inline images are available; run the tool for real to upload shots and write the final body.
   - exit 3: inline images are unavailable in this environment. Use the ORIGINAL body with image lines stripped (the same tool strips image lines for failed/unavailable uploads); tell the user images were omitted.
   - exit 4: auth problem. Stop and ask the user.
3. `create-document-version` with the final body (`review-body.final.md`, or the image-stripped body on exit 3).

### A7. Hand off

Tell the user: the review document's `webUrl`, summary counts, highest-risk items (likely-unintentional changes to shared components), how to review (Stage B below), and a token-cost line aggregated across ALL spawned subagents (sum `usage` from every `agent-*.jsonl` under `~/.claude/projects/<project-slug>/<session-id>/subagents/`; report fresh input, cache reads, and output separately). Do not implement anything; do not create any ticket.

## Stage B — Review (human gate, in the document)

The human edits the Design Review Feature document in the platform - no file handoff:

- **Decline** a change by deleting its section. Deleting a theme's `H3` heading declines all of its member findings; deleting an individual finding's `H4` heading declines just that one.
- **Amend** a change by editing its "What changes" line.
- **Accept** a change by leaving its section in place.

Survival is judged ONLY from the heading-line id anchors (the trailing inline-code id on each `H3`/`H4`). Ids appearing in bullets, tables, or the Backend gaps rollup do not count. The reviewer does not export anything; Stage C reads the edited document directly.

## Stage C — Tickets (accepted units only)

Invocation: `--tickets <workdir> --review-doc <FEA-slug> --project <PRO-slug>`.

### C1. Derive decisions from the edited document

Fetch the review document's LATEST content via `get-document` (`includeContent: true`, generous `contentMaxChars`) and save it to `<workdir>/review-body.edited.md`. Then:

```bash
node scripts/dist/derive-decisions-from-doc.mjs --doc <workdir>/review-body.edited.md \
    --findings <workdir>/findings --out <workdir>/decisions.json \
    --reviewer "<document assignee/editor, else the user>"
```

`decisions.json` is INTERNAL pipeline state - never user-facing, never handed to anyone. Survival is judged from heading-line id anchors only.

### C2. Plan the ticket graph (deterministic)

```bash
node scripts/dist/plan-ticket-graph.mjs --findings <workdir>/findings \
    --decisions <workdir>/decisions.json --manifest <m> \
    --out <workdir>/ticket-plan.json
```

Grouping is per screen: one UI ticket per unit (screens and regions are units; components get NO per-unit tickets), one API ticket per unit only when it has accepted backend-gap findings. Shared net-new components build once in their PRIMARY unit's UI ticket; consumer units reference them. `blocks` edges: an API ticket BLOCKS its unit's UI ticket; a primary UI ticket BLOCKS every consumer UI ticket. There are NO design-system component tickets and NO per-component tickets.

### C3. Packs and bodies (deterministic, per accepted unit)

For each unit with accepted findings:

```bash
node scripts/dist/build-design-pack.mjs --findings <workdir>/findings/<unit-id>.json \
    --decisions <workdir>/decisions.json --extract-dir <workdir>/extracted \
    --out-dir <workdir>/packs --visual-spec <workdir>/specs/<unit-id>.json \
    --css-slice <workdir>/specs/<unit-id>.css
```

Exit 3 = nothing accepted for that unit; skip it silently. Otherwise the pack contains design-source/, screenshots/, decision-applied findings.json, visual-spec.json, `ticket-body-ui.md` (acceptance criteria, an explicit Declined Changes do-not-implement list, component reuse table, token-resolved visual spec, provenance - bullet format, no numbered lists), and `ticket-body-api.md` when the unit has accepted backend-gap findings. The pack stays a workdir-only local artifact; it is never committed, never copied into the repo, and never attached.

### C4. Create DRAFT features (ClosedLoop MCP)

For each ticket in `ticket-plan.json` (UI and API kinds, titles taken from the plan), after the duplicate-title check (C above), create one `FEATURE` document via `create-document` in the user-specified project with the matching ticket body. New documents are DRAFT - that is the second human gate; never advance their status yourself.

For each ticket, upload that unit's shots into the ticket's OWN document: run `upload-inline-images.mjs` against the ticket body with `--document-id <ticket doc id>` and `--shots-root <workdir>`, then `create-document-version` with the substituted body. Apply the same probe/degrade rules as A6 (exit 3 = strip image lines and tell the user; exit 4 = stop and ask).

Then create `BLOCKS` links exactly per `ticket-plan.json`'s `blocks` edges with `create-artifact-link` (prerequisite BLOCKS dependent). Links are irreversible - verify direction against an existing platform example before the first link of a session.

### C5. Report

List created FEAs (slugs + webUrls), the BLOCKS links made, skipped units (nothing accepted), and the aggregated token cost for the stage. NO design-system component tickets, NO per-component tickets, NO commits.

## Resources

### scripts/

TypeScript sources in `src/` (vitest tests co-located as `*.test.ts`), bundles in `dist/`:

- `design-export-extract` (+tests) - deterministic export decomposition: safe unzip, region tagging, typed unit detection, interaction signals (incl. pointer-drag), doc headers, spec overlays, splitting.
- `build-route-map` (+tests) - route table + chrome map from the repo's router conventions.
- `build-component-index` (+tests) - Storybook component index enriched with source paths, props, cva variants.
- `extract-visual-spec` (+tests) - CSS slicing, style extraction, live-token resolution, token drift.
- `design-findings-schema` (+tests) - findings.json / decisions.json schema and validators; `validate-findings.mjs` is the CLI.
- `build-context-pack` (+tests) - per-unit single-file context pack for analysts.
- `capture-design-shots` (+tests) - headless-Chromium highlighted shots of the live design per finding.
- `render-review-doc` (+tests) - markdown body for the platform Design Review document (id anchors, image placeholders, no numbered lists).
- `upload-inline-images` (+tests) - uploads shot placeholders to the attachments API and substitutes attachment ids (probe + degrade).
- `derive-decisions-from-doc` (+tests) - decisions.json from the human-edited review document (heading-anchor survival).
- `plan-ticket-graph` (+tests) - per-screen UI/API ticket graph with shared-component ownership and BLOCKS edges.
- `build-design-pack` (+tests) - per-unit design pack + ticket-body-ui.md / ticket-body-api.md for accepted units.
