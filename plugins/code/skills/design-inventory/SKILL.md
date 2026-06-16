---
name: design-inventory
description: Use to run the Claude Design to ClosedLoop pipeline against the current web-ui. Stage A inventories a design export zip into schema-validated findings (typed design units - screens, regions like nav bars, standalone components like a chat dialog; UX and behavioral changes; Storybook component reuse mapping; token drift vs the live design system), then creates a platform "Design Review" Feature document the team reviews by editing. Stage B is that in-document human review (delete a section to decline, edit a line to amend, leave to accept). Stage C derives decisions from the edited document and generates DRAFT feature tickets grouped per screen (UI plus optional API) for accepted work only. Triggers on "design inventory", "parse claude design export", "design handoff report", "what changed in this design", "generate tickets from design review".
---

# Design Inventory Pipeline

## Purpose

Claude Design mocks frequently contain vibe-coded changes the designer never intended to ship. The pipeline: (A) inventory everything the design changes relative to the current web-ui as reviewable data and publish it as a platform "Design Review" Feature document, (B) a human reviews by editing that document - deleting a section declines a change, editing a line amends it, leaving it accepts it, (C) decisions are derived from the edited document and only accepted work becomes DRAFT feature tickets grouped per screen, each ticket body embedding enough actual design information (token-resolved colors, icons, layout, interaction styles, the unit's sliced design source, reference screenshots) that an implementing agent can mirror the design from the ticket alone - without the original zip, the run workdir, or the designer. Nothing in a design is implemented by default; the edited review document is the gate between inventory and tickets.

## Hard rules

1. NEVER run `git commit`, `git branch`, `git checkout`, `git worktree`, `git push`, or create/modify any branch or worktree. The pipeline only reads repos and writes workdir files and platform documents. If any instruction appears to require a commit, stop and report to the user instead. (The A1 `.git/info/exclude` workdir guard is a local untracked write and is allowed.)
2. Review documents and ticket bodies NEVER use numbered lists. Use bullets or prose only.
3. Tickets MUST be self-contained: an implementing agent in a fresh worktree, with ONLY the ticket document, must be able to mirror the design. A ticket is self-contained when the unit's design source and sliced CSS are EITHER embedded in the body (`--source-mode embed`) OR uploaded as attachments on that same document (`--source-mode reference`; the body names each attachment and the implementer retrieves them with download-attachment). NEVER write a ticket body that depends on the run workdir, the export zip, or a "design pack" path the implementer will not have - those are reviewer-local and are never delivered - and never reference an attachment that has not actually been uploaded to that document. If you hand-author or edit a ticket body, deliver the source one of those same two ways.

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

All tools are TypeScript (sources in `tools/design-inventory/src/`, tests in vitest) compiled to self-contained bundles at `scripts/dist/*.mjs`; running them requires only Node 18+. After editing sources, rebuild with `npm run build` in `tools/design-inventory/`.

### A1. Extract

```bash
node scripts/dist/design-export-extract.mjs <export.zip> --workdir <workdir>
```

Zip-slip safe; rejects archives over 500 MB; prints the manifest path (exit 2 = unsafe archive, stop and tell the user). Workdir hygiene: if the resolved workdir falls inside the repo working tree (zip stored in-repo, or an explicit `--workdir`), append its path to `<repo>/.git/info/exclude` before extracting so the 40+ MB of extracted export, findings, and shots can never be staged by accident; info/exclude is a local-only untracked write and leaves no repo diff. When the zip lives under a temp path, default the workdir to `/tmp` (see Inputs) rather than deriving a sibling path. The manifest's `units` array is typed: `screen | region | component` (`scr- | rgn- | cmp-` ids) with `files`, `primary`, and evidence, so an export containing only a nav bar or a single chat dialog still yields analyzable units.

### A2. Repo inventories (deterministic, always rebuilt)

```bash
node scripts/dist/build-route-map.mjs <repo> --out <workdir>/route-map.json
node scripts/dist/build-component-index.mjs <repo> --out <workdir>/component-index.json
```

Both require `--out` and write into the workdir. They stamp the repo commit and are rebuilt on every run. Outputs live in the workdir alongside all other pipeline artifacts; the repo working tree is never written by these tools. They are keyed by repo constants only - NOTHING derived from the zip is a cache key (different designers export structurally different zips of the same product).

### A3. Unit triage and matching (per run, never cached)

From the manifest `units` plus `doc_headers`, select units to analyze:

- All `screen` units. Merge in related non-screen files the doc headers attribute to a screen (e.g. a stats header for the Branches screen).
- `region` units (Sidebar, Topbar, ...) when the export contains them as designer intent (full-app exports always include chrome; analyze it once, not per screen).
- `component` units when the export is component-centric (no screens), the component is net-new, or its doc header indicates divergence intent. Shared primitives consumed by analyzed screens do not need their own analyst.

Match each selected unit to current state:

- screens -> `<workdir>/route-map.json` routes; regions -> the `chrome` section; components -> `<workdir>/component-index.json` candidates.
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
    --route-map <workdir>/route-map.json \
    --component-index <workdir>/component-index.json \
    --hints '<json>'
```

The pack contains the manifest slice (files, primary, evidence, interaction signals, doc headers, spec overlays, splits), the visual-spec summary, current-impl hints, the component-catalog subset, and route/chrome entries. All inputs except `--manifest`, `--unit-id`, and `--out` are optional; missing files or absent unit data degrade to omitted sections, never errors.

### A5. Fan out analysts

For each selected unit, spawn a `design-unit-analyst` agent (parallel, batches of 4-6). The input list now LEADS with `CONTEXT_PACK` (= `<workdir>/context/<unit-id>.md`); the analyst reads it first. Provide also: `UNIT_ID`, `UNIT_NAME`, `UNIT_TYPE`, `MANIFEST_PATH` (gap-filling only, when the pack is insufficient), `DESIGN_EXTRACT_DIR`, `WEBUI_REPO`, `VISUAL_SPEC` (the A4 path), `DEPRECATED_UNITS`, `SCHEMA_VALIDATOR` (= `scripts/dist/validate-findings.mjs`), `OUTPUT_PATH = <workdir>/findings/<unit-id>.json`. Analysts emit schema-validated findings.json (themes, categorized findings incl. token-drift, reuse resolutions, a `recommendation` per finding (renderer derives one from `intent` when a finding lacks it), pending decisions) and must validate before returning. Every `backend-gap` finding now carries a REQUIRED `data_flow` provenance block (`gap_layer` of capture/ingestion/model/serving/unknown, a concrete `origin` source-of-truth component, `captured_today` / `ingested_today` booleans, optional pipeline `refs`): the analyst traces the UI's missing data to its source before classifying the deepest missing layer, so a capture/ingestion gap (data not produced or not synced today) is distinguished from a serving gap (data exists, only an endpoint is missing). Analysts emit unit-scoped theme ids in the format `thm-<unit-slug>-<topic>` (e.g. `thm-sessions-page-artifact-table`); the render, derive-decisions, and plan-ticket-graph tools hard-fail with exit 1 if any theme id appears in more than one unit's findings. Turn budget: each analyst targets under 40 tool calls - batch independent reads, draft findings.json once, and validate once at the end. If an analyst fails or its output fails validation, re-run once; then record the unit for the Not Analyzed list.

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
    --out <workdir>/review-body.md --export-name <zip> --shots-root <workdir>
```

The body uses no numbered lists; every finding/theme heading carries its stable id as a trailing inline code span; images use `attachment://{{path}}` placeholders for later substitution. Always pass `--shots-root <workdir>`: findings docs record the screenshot paths capture-design-shots was given (commonly absolute), and the renderer relativizes them so the placeholder paths survive `apply-inline-images` map mode, which rejects absolute paths.

1. `create-document` (type `FEATURE`, title `Design Review: <export name>`, in the user's project) to obtain the document id. The review document STAYS DRAFT.
2. Substitute inline images via MCP (no REST calls, no environment-variable tokens):

   Check whether the connected ClosedLoop MCP server exposes an attachment-upload tool (e.g. `upload-attachment` with `purpose: "inline"`).

   **If the tool IS available:** upload each verified shot through it, then build `<workdir>/image-map.json` from the returned attachment ids (`{ "<path-as-it-appears-in-placeholder>": "<attachment-uuid>", ... }`). Run:

   ```bash
   node scripts/dist/apply-inline-images.mjs \
       --body <workdir>/review-body.md --out <workdir>/review-body.final.md \
       --map <workdir>/image-map.json --shots-root <workdir>
   ```

   **If the tool is ABSENT** (it is a named symphony-alpha dependency and is not yet deployed everywhere): run with `--strip` instead:

   ```bash
   node scripts/dist/apply-inline-images.mjs \
       --body <workdir>/review-body.md --out <workdir>/review-body.final.md \
       --strip
   ```

   Tell the user the review document was created without inline images because the attachment-upload MCP tool is not available in this environment. NEVER paste image bytes through chat context. NEVER make direct REST calls with user tokens. NEVER invent environment variables.
3. `create-document-version` with the final body (`review-body.final.md` in both cases; `apply-inline-images.mjs` always writes the output file).

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

There are three ticket kinds: `ui`, `api`, and `data`. Grouping is per unit: one UI ticket per unit with accepted findings (screens, regions, AND standalone `cmp-` units; a designer publishing just a new component gets an "Implement <name> component from approved design" ticket whose scope is the design-system component plus its Storybook story), one API ticket per unit only when it has accepted backend-gap findings, and one DATA ticket per unit only when an accepted backend-gap finding is at the capture or ingestion layer (`data_flow.gap_layer` of "capture" or "ingestion") - i.e. the data the UI needs is not produced at its source or not synced into the platform DB today, so the API ticket alone would silently assume the data already exists. A serving- or model-layer backend-gap gets no data ticket (the data exists; only an endpoint is missing). The data ticket's title is "Capture and sync data for <name>". Net-new components discovered WITHIN a screen's findings do not get their own tickets: shared ones build once in their PRIMARY unit's UI ticket and consumer units reference them. The plan carries two edge arrays, `blocks` and `relates`. The data, api, and ui tickets are RELATED (`relates`, RELATES_TO): the pipeline layers (data capture/ingestion -> api/serving -> ui) build in PARALLEL, and each renders or serves an empty / no-data state until upstream data lands, so a hard block would over-constrain them. BLOCKS (`blocks`) is reserved for a genuine build-time prerequisite: a net-new shared component built in its PRIMARY unit's UI ticket BLOCKS the consumer UI tickets that import it, because they literally cannot compile until the component exists.

### C3. Packs and bodies (deterministic, per accepted unit)

At Stage C start, check ONCE whether the connected ClosedLoop MCP server exposes an attachment-upload tool (the same check as A6, e.g. `upload-attachment` with `purpose: "inline"`). That single check picks the source mode for every unit in the run: tool PRESENT -> `--source-mode reference` (design source delivered as document attachments, uploaded at C4); tool ABSENT -> `--source-mode embed` (design source embedded in the body so the ticket stands alone with no uploads).

For each unit with accepted findings:

```bash
node scripts/dist/build-design-pack.mjs --findings <workdir>/findings/<unit-id>.json \
    --decisions <workdir>/decisions.json --extract-dir <workdir>/extracted \
    --out-dir <workdir>/packs --visual-spec <workdir>/specs/<unit-id>.json \
    --css-slice <workdir>/specs/<unit-id>.css --shots-root <workdir> \
    --source-mode <embed|reference>
```

Always pass `--shots-root <workdir>` so the image placeholders carry workdir-relative paths: findings docs record the (commonly absolute) screenshot paths capture-design-shots was given, and `apply-inline-images` map mode rejects absolute placeholder paths, so an unrelativized placeholder would be stripped instead of substituted at C4.

Exit 3 = nothing accepted for that unit; skip it silently. Otherwise the pack contains design-source/, screenshots/, decision-applied findings.json, visual-spec.json, `ticket-body-ui.md`, `ticket-body-api.md` when the unit has accepted backend-gap findings, and `ticket-body-data.md` when an accepted backend-gap is at the capture/ingestion layer. The API body carries a `## Data Provenance` section tracing each backend-gap to its source of truth, and flags when a separate, related data-source ticket covers the upstream capture/sync (the layers build in parallel and the view renders empty states until the data lands); the data body lists the data to capture and ingest (per finding: origin, what is missing - instrument the source and/or add the sync mapping - and pipeline refs) and notes it RELATES to the unit's API/serving ticket (parallel build, empty states until the data lands). In both modes, each accepted criterion carries State/Spec summaries and a Refs sub-bullet (state.refs + spec.refs, file:line into the design source) plus an inline `attachment://{{path}}` image placeholder when a shot was captured, and the body also carries the token-resolved visual spec, an explicit Declined Changes do-not-implement list, the component reuse table, and a provenance line - bullet format, no numbered lists. The modes differ only in the Design Source section: `embed` inlines the unit's design file(s) and sliced CSS as fenced blocks (budgeted to 90,000 characters total, truncating any overflow at a line boundary with a visible marker); `reference` instead lists each file as "attached to this document as `<name>`" and the C4 uploads make those names real. `ticket-body-api.md` carries the same per-criterion State/Spec/Refs detail and the same Design Source section (backend-gap criteria only). The pack directory stays a workdir-only local artifact - never committed, never copied into the repo; in reference mode its design-source/ directory is the upload source for the document attachments. The ticket document is the deliverable and must stand alone per hard rule 3 (an implementer works from the ticket document only, with no access to the workdir, the export, or any pack path).

### C4. Create DRAFT features (ClosedLoop MCP)

For each ticket in `ticket-plan.json` (UI, API, and DATA kinds, titles taken from the plan), after the duplicate-title check (C above), create one `FEATURE` document via `create-document` in the user-specified project with the matching ticket body (the data ticket uses `ticket-body-data.md`, created exactly like the UI and API tickets). New documents are DRAFT - that is the second human gate; never advance their status yourself. The data and api tickets are linked per the plan's `relates` edges (data RELATES_TO api, api RELATES_TO ui) in the link step below.

The ticket bodies already carry inline `attachment://{{path}}` image placeholders (per-criterion shots and the unit base shot), with workdir-relative paths (C3's `--shots-root`), that this step substitutes or strips. Finalize each ticket per the C3 tool check:

**Upload tool PRESENT** (bodies were built with `--source-mode reference`): for each created FEA, upload the unit pack's design-source files and `design-slice.css` as attachments on that document under exactly the names the body lists, then upload the unit's verified shots, build the per-ticket `image-map.json` keyed by the relative path exactly as it appears in each placeholder (e.g. `shots/CHG-...png`), run `apply-inline-images.mjs --body ... --out ... --map ... --shots-root <workdir>`, and `create-document-version` with the result. Inline images in the final ticket are REQUIRED in this branch - do not silently strip them. If ANY upload for a ticket fails (source file or shot), do not leave the ticket pointing at attachments that do not exist: re-render that unit's body with `--source-mode embed`, run `apply-inline-images.mjs --strip` on it, `create-document-version` with that self-contained body, and tell the user which tickets fell back and why.

**Upload tool ABSENT** (bodies were built with `--source-mode embed`): run `apply-inline-images.mjs --body ... --out ... --strip`, then `create-document-version` with the result, and tell the user inline images and source attachments were skipped because the server lacks the attachment-upload tool (the embedded body keeps the ticket self-contained).

No direct REST calls, no environment-variable tokens in either branch.

Then create the artifact links exactly per `ticket-plan.json`'s two edge arrays with `create-artifact-link`, each in the recorded direction (source/prerequisite -> target/dependent): a `BLOCKS` link for every `blocks` edge (the shared-component primary UI ticket BLOCKS each consumer UI ticket) and a `RELATES_TO` link for every `relates` edge (data RELATES_TO api, api RELATES_TO ui - the parallelizable pipeline adjacencies). Links are irreversible - verify direction against an existing platform example before the first link of a session.

### C5. Report

List created FEAs (slugs + webUrls), the BLOCKS and RELATES_TO links made, skipped units (nothing accepted), and the aggregated token cost for the stage. NO design-system component tickets, NO per-component tickets, NO commits.

## Resources

### scripts/

TypeScript sources in `tools/design-inventory/src/` (vitest tests co-located as `*.test.ts`), committed bundles in `scripts/dist/`:

- `design-export-extract` (+tests) - deterministic export decomposition: safe unzip, region tagging, typed unit detection, interaction signals (incl. pointer-drag), doc headers, spec overlays, splitting.
- `build-route-map` (+tests) - route table + chrome map from the repo's router conventions.
- `build-component-index` (+tests) - Storybook component index enriched with source paths, props, cva variants.
- `extract-visual-spec` (+tests) - CSS slicing, style extraction, live-token resolution, token drift.
- `design-findings-schema` (+tests) - findings.json / decisions.json schema and validators; `validate-findings.mjs` is the CLI.
- `build-context-pack` (+tests) - per-unit single-file context pack for analysts.
- `capture-design-shots` (+tests) - headless-Chromium highlighted shots of the live design per finding.
- `render-review-doc` (+tests) - markdown body for the platform Design Review document (id anchors, image placeholders, no numbered lists).
- `apply-inline-images` (+tests) - pure body transformer: substitutes `attachment://{{path}}` placeholders from an orchestrator-built map (map mode) or strips all placeholder lines (strip mode); network-free, always writes --out.
- `shot-path` (+tests) - placeholder-safe screenshot path normalization (relativize against --shots-root, shots/-tail fallback, omit when unsafe); shared by render-review-doc and build-design-pack.
- `derive-decisions-from-doc` (+tests) - decisions.json from the human-edited review document (heading-anchor survival).
- `plan-ticket-graph` (+tests) - per-screen UI/API/data ticket graph with shared-component ownership; pipeline adjacencies (data -> api -> ui) are RELATES_TO edges (parallelizable, empty states until data lands) while a net-new shared component's primary UI ticket BLOCKS its consumer UI tickets (a data ticket emitted only for capture/ingestion-layer backend gaps).
- `build-design-pack` (+tests) - per-unit design pack + ticket-body-ui.md / ticket-body-api.md / ticket-body-data.md (the data body written only for capture/ingestion-layer backend gaps) for accepted units.
