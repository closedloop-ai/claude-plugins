# Standalone HTML reports

Use the bundled renderer when the requested deliverable is a local HTML work report. It accepts UTF-8 Markdown, escapes source HTML, permits only `http`, `https`, and `mailto` links, and emits one self-contained HTML file. Tables, lists, headings, inline emphasis/code/links, code fences, and Mermaid fences are supported. Raw HTML is intentionally displayed as text.

Keep the report executive-first:

1. Your assigned tickets.
2. Proposed complete page or capability groupings.
3. Specific minimal reassignment recommendations, including an explicit “none” when justified.
4. Scope decisions and external dependencies.
5. Broader context and evidence in collapsed sections.

Follow the canonical `What this delivers` content requirement in `../SKILL.md`. Place that paragraph immediately after each proposed feature heading, before metadata, tables, diagrams, or dependency detail; the renderer needs no special handling for it.

In table cells, write the protected-owner policy marker exactly as `**Protected owner — no reassignment**` (an optional period inside the bold marker is accepted). The renderer gives only rows containing that bold marker a muted grey background and replaces the marker with a readable `Protected owner` label plus a `No reassignment` badge. Links remain active and readable. Do not use the marker for ordinary `keep owner; coordinate` recommendations or other external prerequisites.

Use a Mermaid diagram only when it clarifies a bounded delivery unit. Keep selected owned tickets, proposed transfers, shared external prerequisites, and out-of-scope context visually distinct, and label relations such as `blocks`, `provides evidence`, and `after rollout`. In the Delivery and ownership map, label every ticket node with its slug, short title, and live-verified current assignee. Write `Current owner: unassigned` or `Current owner: unknown` when applicable. Show a proposed transfer separately from the current owner; never replace or blur the current assignment. If one node groups several tickets, list each ticket with its own current assignee or split the group into ticket-level nodes; never apply one owner label to a mixed-owner group. Do not diagram the full project or PRD when only one page or capability is selected.

## Input and output contract

- **Input:** one Markdown file. Mermaid diagrams use fenced `mermaid` blocks. Do not place ticket data in executable HTML or JavaScript.
- **Renderer asset:** the skill bundles Mermaid 11.16.0 at `assets/mermaid-11.16.0.min.js` and uses it by default. The renderer inlines that pinned bundle, uses Mermaid's strict security mode, and fails closed when a diagram exists without a renderer. `assets/mermaid-LICENSE.txt` contains its MIT license; upstream provenance is `mermaid` 11.16.0 from `https://github.com/mermaid-js/mermaid`.
- **Output:** one offline HTML file with embedded CSS, embedded Mermaid runtime when needed, safe external links, diagram text fallbacks, and no mutation controls.
- **Collapsed context:** repeat `--collapse "Exact H2 text"` for broad evidence/context sections.

Invoke it from the skill directory:

```bash
python3 scripts/render_report.py /path/to/report.md /path/to/report.html \
  --collapse "Broader context" \
  --collapse "Scope and evidence"
```

The output must be verified with a headless browser before delivery. Wait for `window.__REPORT_RENDER_COMPLETE`, then require `document.documentElement.dataset.mermaidRendered === "true"`, confirm every `.diagram-card` contains an SVG, confirm no horizontal page overflow at desktop and mobile widths, and capture a screenshot. The same completion markers are set immediately for reports with no diagrams. Keep automated browser execution headless or displayless.

Run the deterministic safety checks after editing the renderer:

```bash
python3 scripts/test_render_report.py
```

If no local Mermaid bundle or headless browser is available, omit the diagram and disclose the rendering limitation. Do not silently deliver an unrendered Mermaid fence as the requested HTML diagram.
