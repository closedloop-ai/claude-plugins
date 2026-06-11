---
name: design-inventory
description: Use to run the Claude Design to ClosedLoop pipeline against the current web-ui. Stage A inventories a design export zip into schema-validated findings (typed design units - screens, regions like nav bars, standalone components like a chat dialog; UX and behavioral changes; Storybook component reuse mapping; token drift vs the live design system) plus a report and an HTML review page. Stage B is the human review producing decisions.json. Stage C generates DRAFT feature tickets with design packs for accepted units only. Triggers on "design inventory", "parse claude design export", "design handoff report", "what changed in this design", "generate tickets from design review".
---

# Design Inventory Pipeline

## Purpose

Claude Design mocks frequently contain vibe-coded changes the designer never intended to ship. The pipeline: (A) inventory everything the design changes relative to the current web-ui as reviewable data, (B) a human accepts/declines each change, (C) only accepted work becomes DRAFT feature tickets, each carrying enough actual design information (token-resolved colors, icons, layout, interaction styles, sliced design source, reference screenshots) that an implementing agent can mirror the design without the original zip. Nothing in a design is implemented by default; decisions.json is the gate between inventory and tickets.

## Invocation

```
/code:design-inventory <export.zip> [--repo <path>] [--out <report path>]   # Stage A
/code:design-inventory --tickets <workdir> --decisions <decisions.json> \
    --project <PRO-slug> [--repo <path>]                                    # Stage C
```

Stage A is one invocation: extraction, repo inventories, visual specs, parallel analysts, report + review page. Stage B is human review of the generated review.html (or an interactive triage session; see Stage B). Stage C runs only with a decisions.json.

Stage C arguments:

- `--tickets <workdir>`: selects ticket-generation mode and points at the Stage A workdir, which holds everything Stage C consumes (findings/, specs/, shots/, extracted/). The workdir IS the pipeline state; no chat-session continuity is required, so Stage C may run days later, in a different session, or by a different person than the reviewer.
- `--decisions <path>`: the decisions.json exported from review.html (typically the reviewer's Downloads folder) or written by an interactive triage session. Validate it before anything else; abort on schema errors. Convention: copy it to `<workdir>/decisions.json` so the whole run lives in one directory and "continue the design review in <workdir>" is enough context later.
- `--project <PRO-slug>`: the ClosedLoop project that receives the DRAFT feature documents.

Re-running Stage C: pack generation is deterministic and safe to repeat, but document creation is not idempotent. Before creating each FEA, check the target project for an existing document with the same title (or a prior Stage C report in the workdir) and skip those units instead of minting duplicates.

## Inputs

- **Export zip** (Stage A, required): the Claude Design export. Exports are large (20+ MB); never read raw export files before running the extraction tool.
- **Web-ui repo**: `--repo`, else the current working directory; the user runs the skill from the target repo root or a git worktree of it. Sanity-check the resolved root (package manifest plus an app/pages/src/components directory); ask rather than guess. Never assume any specific org's layout.
- **Workdir**: defaults to `<zip-stem>-design-inventory` next to the zip. Stage C takes the Stage A workdir.
- **decisions.json** (Stage C, required): produced by Stage B. Validate before use.

## Token Economy (hard rules)

1. NEVER read files under the extracted export except: `manifest.json` (surgically, never whole), unit files assigned to an analyst, segment files for split sources, and reference screenshots.
2. Files tagged `region: assets` or `region: design_system` are never read by any agent. `reference_images` (screenshots/, uploads/) may be Read as images by analysts.
3. Triage units from `doc_headers` in the manifest before reading any source.
4. Each analyst reads ONLY its own unit's files. The orchestrator reads the manifest, never unit source.
5. Deterministic scripts do all decomposition, slicing, token resolution, rendering, and pack assembly - zero LLM tokens. Agents only judge.

## Stage A — Inventory

All tools are TypeScript (sources in `scripts/src/`, tests in vitest) compiled to self-contained bundles committed at `scripts/dist/*.mjs`; running them requires only Node 18+. After editing sources, rebuild with `npm run build` in `scripts/` and commit the dist output.

### A1. Extract

```bash
node scripts/dist/design-export-extract.mjs <export.zip> --workdir <workdir>
```

Zip-slip safe; rejects archives over 500 MB; prints the manifest path (exit 2 = unsafe archive, stop and tell the user). The manifest's `units` array is typed: `screen | region | component` (`scr- | rgn- | cmp-` ids) with `files`, `primary`, and evidence, so an export containing only a nav bar or a single chat dialog still yields analyzable units.

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

### A5. Fan out analysts

For each selected unit, spawn a `design-unit-analyst` agent (parallel, batches of 4-6) with: `UNIT_ID`, `UNIT_NAME`, `UNIT_TYPE`, `MANIFEST_PATH`, `DESIGN_EXTRACT_DIR`, `WEBUI_REPO`, `CURRENT_IMPL_HINTS`, `COMPONENT_INDEX`, `VISUAL_SPEC` (the A4 path), `DEPRECATED_UNITS`, `SCHEMA_VALIDATOR` (= `scripts/dist/validate-findings.mjs`), `OUTPUT_PATH = <workdir>/findings/<unit-id>.json`. Analysts emit schema-validated findings.json (themes, categorized findings incl. token-drift, reuse resolutions, pending decisions) and must validate before returning. If an analyst fails or its output fails validation, re-run once; then record the unit for the report's Not Analyzed list.

### A5.5 Capture highlighted design shots (best effort, after analysts)

The export is a runnable app, so each decision can show exactly what it is about. Per analyzed unit:

```bash
node scripts/dist/capture-design-shots.mjs --extract-dir <workdir>/extracted \
    --entry <registry html, e.g. ui_kits/app/index.html> \
    --findings <workdir>/findings/<unit-id>.json --shots-dir <workdir>/shots \
    --repo <repo> --nav-text "<sidebar label, e.g. Sessions>" [--eval "<js>"]
```

Serves the export locally, loads it in headless Chromium (Playwright resolved from the target repo's node_modules; web-ui repos in scope already depend on @playwright/test), navigates via the sidebar label (or an `--eval` expression using the export's `window.cl*` helpers for detail views), outlines each finding's `spec.selectors` matches in red, and screenshots the regions. It patches the findings document in place: `finding.screenshot` per captured finding, `theme.screenshot` falling back to the unit base shot. Exit 3 means Playwright is unavailable: skip and continue (the review page degrades to the unit screenshot strip); exit 2 means the page never mounted: note it and continue. Run this BEFORE A6 so the renderer can embed the shots.

**Shot verification (required when captures succeeded).** A wrong screenshot is worse than none: it would anchor the reviewer's decision to the wrong element. After capture, spawn ONE cheap multimodal agent per unit that Reads each captured `shots/CHG-*.png` alongside the finding's title and summary and answers: does the highlighted region plausibly show what the finding describes? Mismatches (or empty/blank highlights) are corrected by removing that finding's `screenshot` field so the card falls back to no image, and noted in the hand-off. Spot-check at minimum the theme-level shots, since those carry the most reviewer weight.

### A6. Render

```bash
node scripts/dist/render-report.mjs --findings <workdir>/findings --out <report path> \
    [--export-name <zip name>] [--not-analyzed "unit: reason" ...]
node scripts/dist/render-review-html.mjs --findings <workdir>/findings \
    --out <workdir>/review.html --screenshots-dir <workdir>/extracted
```

### A7. Hand off

Tell the user: report path, review.html path, summary counts, highest-risk items (likely-unintentional changes to shared components), and a token-cost line aggregated across ALL spawned subagents (sum `usage` from every `agent-*.jsonl` under `~/.claude/projects/<project-slug>/<session-id>/subagents/`; report fresh input, cache reads, and output separately). Do not implement anything; do not create any ticket.

## Stage B — Review (human gate)

Two equivalent modes, same artifact:

1. **review.html**: the user opens it, works themes first (accept/decline per theme; member findings inherit unless overridden), then standalone findings ordered by uncertainty; likely-intentional items are pre-accepted (veto model). Export downloads `decisions.json`.
2. **Interactive triage**: walk the reviewer through themes and uncertain findings in conversation (use AskUserQuestion; screenshots inline), highest-uncertainty first, then write `decisions.json` yourself.

Validate: `node scripts/dist/validate-findings.mjs <decisions.json> --kind decisions`. HARD GATE: Stage C never runs without a valid decisions.json. Platform documents cannot embed images - the visual review lives only in review.html or the conversation.

## Stage C — Tickets (accepted units only)

### C1. Packs and bodies (deterministic)

For each unit findings file:

```bash
node scripts/dist/build-design-pack.mjs --findings <workdir>/findings/<unit-id>.json \
    --decisions <decisions.json> --extract-dir <workdir>/extracted \
    --out-dir <workdir>/packs --visual-spec <workdir>/specs/<unit-id>.json \
    --css-slice <workdir>/specs/<unit-id>.css
```

Exit 3 = nothing accepted for that unit; skip it silently. Otherwise the pack contains design-source/, screenshots/, decision-applied findings.json, visual-spec.json, and ticket-body.md (acceptance criteria from accepted findings, an explicit Declined Changes do-not-implement list, component reuse table, token-resolved visual spec, dependencies).

### C2. Create DRAFT features (ClosedLoop MCP)

For each pack, create one FEATURE document via `create-document` in the user-specified project, title `Implement <unit name> from approved design`, content = ticket-body.md. New documents are DRAFT - that is the second human gate; never advance their status yourself.

Shared-work tickets: collect Dependencies across packs, dedupe, and create one FEA per net-new design-system component ("Build <Component> in the design system") and per backend gap. Link with `create-artifact-link`: prerequisite `BLOCKS` dependent (component/backend FEA blocks each unit FEA that needs it). If the user names an umbrella feature for the design effort, link umbrella `PRODUCES` each created FEA. Links are irreversible - verify direction against an existing example before the first link of a session.

### C3. Attach the design pack

The MCP server has `download-attachment` but no upload tool, so use the repo-stored fallback: copy the pack to `<repo>/.closedloop-ai/design-packs/<FEA-slug>/` and update the ticket body's Design Pack path via `create-document-version`. If/when an attachment-upload tool exists, attach the pack zip to the FEA instead.

### C4. Report

List created FEAs (slugs + webUrls), dependency links made, skipped units (nothing accepted), pack locations, and the aggregated token cost for the stage.

## Resources

### scripts/

TypeScript sources in `src/` (vitest tests co-located as `*.test.ts`), committed bundles in `dist/`:

- `design-export-extract` (+tests) - deterministic export decomposition: safe unzip, region tagging, typed unit detection, interaction signals (incl. pointer-drag), doc headers, spec overlays, splitting.
- `build-route-map` (+tests) - route table + chrome map from the repo's router conventions.
- `build-component-index` (+tests) - Storybook component index enriched with source paths, props, cva variants.
- `extract-visual-spec` (+tests) - CSS slicing, style extraction, live-token resolution, token drift.
- `design-findings-schema` (+tests) - findings.json / decisions.json schema and validators; `validate-findings.mjs` is the CLI.
- `render-report` (+tests) - report renderer from findings (+decisions).
- `render-review-html` (+tests) - self-contained HTML review page emitting decisions.json.
- `build-design-pack` (+tests) - per-unit design pack + ticket-body.md for accepted units.
