---
name: prd-dependency-graph
description: Build an interactive dependency graph of ClosedLoop tickets from live BLOCKS links, for a PRD or any other document (PRD-751, ISS-123) or a whole project (PRO-67). Hovering a ticket lights up what blocks it (purple) and what it blocks (teal); clicking pins the whole upstream and downstream chain. Tickets outside the scope that block it are shown too, one layer up by default or the whole chain on request. Use when the user asks for a "dependency graph", "blocker graph", "blocks graph", "graph of PRD-NNN" or "graph of PRO-NN", "what blocks what", or wants to visualize ticket dependencies. Produces a standalone HTML file (default on the Desktop) or a graph embedded in an existing report, with a refresh button that pulls the latest tickets and links through a local helper.
---

# Ticket dependency graph

Turns a scope's tickets and their BLOCKS links into an interactive HTML graph. Two scripts do all the work, so every run is deterministic and every link is drawn:

- `scripts/refresh_server.py` reads the ClosedLoop REST API, builds the graph data, and saves it as a config. It is also the local helper behind the refresh button.
- `scripts/render_graph.py` draws the graph.

Your job is to pick the scope and options, run them, name the columns, and check the result.

## Inputs

- A scope slug:
  - a **PRD or other document** (`PRD-751`, `ISS-6251`): its PRODUCES children. A document with no ticket children (for example a single ticket) graphs itself and its neighbours.
  - a **project** (`PRO-67`): every ticket in the project.
  The graph looks the same either way.
- Optional:
  - output path. The default is `~/Desktop/<slug-lowercase>-dependency-graph.html`.
  - whether to embed the graph into an existing HTML report instead of writing a standalone page.
  - how far to follow outside blockers: the default is one layer, or `all` for the whole chain.
  - whether to include implementation plans. They are off by default because they are not work items and would double every ticket.

## What counts as a dependency

- **BLOCKS** links are drawn as solid arrows. The source blocks the target, and the target waits on it.
- A BLOCKS arrow is **red** while its blocker is still open (any status other than DONE, CANCELED, EXECUTED, OBSOLETE or APPROVED), and grey once the blocker is finished. Box borders still show each ticket's own status, so a red border means the status is BLOCKED.
- **The scope document** (a PRD or other document with ticket children) is drawn as the root box, with a dotted **PRODUCES** arrow to each in-scope ticket. A project scope has no root. PRODUCES arrows are not counted as BLOCKS links.
- **RELATES_TO** and other link types are never drawn, even when a ticket reads like a blocker. If the user expects a dependency the graph does not show, check the link type with the API and tell them. Changing a link in ClosedLoop is the user's call.
- **Tickets outside the scope** are drawn dashed, and the legend reads "outside <scope>":
  - tickets that in-scope tickets block are shown one layer deep;
  - tickets that block the scope are followed upstream `outside_blockers_depth` layers (default 1; `"all"` follows the chain to its roots).

## Steps

1. **Who is "me".** Call `mcp__closedloop__get-me` (load it with ToolSearch). Use the first name so the user's tickets are highlighted.

2. **Create the graph.** The API key comes from `CLOSEDLOOP_API_KEY`, and a login shell is used as a fallback, so an export in `~/.zprofile` works.
   - Standalone page:
     ```
     python3 scripts/refresh_server.py --new PRD-751 --me Daniel -o ~/Desktop/prd-751-dependency-graph.html
     ```
   - Inside an existing report: first put `<!-- depgraph:<graph-id>:start -->` and `<!-- depgraph:<graph-id>:end -->` where the graph belongs (the graph id defaults to the slug in lowercase), then:
     ```
     python3 scripts/refresh_server.py --new PRD-751 --me Daniel --embed-into <report.html>
     ```
   - Options:
     - `--outside-depth all` (or a number) follows outside blockers further.
     - `--include-plans` adds implementation plans.
     - `--graph-id` names the config if the default is taken.

   It fetches everything, saves the config as `~/.local/share/prd-dependency-graph/<graph-id>.json` (mode 600, with a random token for the refresh button, never the API key), writes the output, and prints the ticket and link counts.

3. **Name the columns.** Run `python3 scripts/render_graph.py ~/.local/share/prd-dependency-graph/<graph-id>.json --print-columns`.
   - Columns come from dependency depth. Read which tickets landed in each and write a short `column_labels` entry for each into the config, for example "foundations and design", "components and APIs", "adoption", "retirement".
   - Tickets with no BLOCKS links are not in any column. They are drawn in a grid below the graph, titled "No BLOCKS links".
   - For large scopes where the columns mix unrelated work, plain numbers are fine; say so rather than inventing labels.

4. **Tidy labels.** Each ticket's `label` is derived from its title, with prefixes like `[P751-3]` stripped and the text cut to about 28 characters. Shorten any that read badly to 2 to 4 words in the config. Keep the full title in `title`, which is shown as a tooltip. Labels are kept across refreshes.

5. **Re-render** after editing the config: `python3 scripts/refresh_server.py --once <graph-id>`. This also re-reads the API and prints what changed.

6. **Verify.**
   - The printed counts must match what the API holds. Never drop edges to make a picture cleaner.
   - Headless browser check: `node scripts/check_graph.cjs <file.html> <a ticket with many links> <screenshot.png>`. It confirms there are no script errors, hover highlights exactly the ticket's incoming and outgoing links, click pins the chain, Esc clears, zoom changes the graph size without disturbing a pinned chain, only one toolbar menu is open at a time, Save Image downloads a PNG, and Copy Image puts a PNG on the clipboard. It needs `playwright-core` and Chrome; set `PLAYWRIGHT_CORE` and `CHROME_PATH` if the defaults do not exist. Look at the screenshot.

7. **Report back** with:
   - the file path;
   - ticket and link counts, how many tickets are outside the scope and how many have no links;
   - a one-line summary of the main chains (what gates what);
   - how refresh works (below): the helper is already running in the background, and `prd-graph-helper` starts it again after a reboot.
   Offer to open it.

## Refresh button

The graph's top-right corner has zoom controls, a gear (options), and a refresh icon. The gear and refresh icon need the local helper running.

- **Started for the user:** `--new` and `--once` start the helper in the background when it is not running, and replace a helper left running from another install of this skill (for example after a plugin update). `--ensure` does only that. The helper's log is `~/.local/share/prd-dependency-graph/helper.log`.
- **Starting it by hand** (for example after a reboot): `prd-graph-helper`. Every run writes that launcher to `~/.local/bin/prd-graph-helper`, pointing at the installed `scripts/refresh_server.py`, so the command survives plugin updates even though the installed path changes with each version. The page's "helper not running" dialog shows `prd-graph-helper`, or its full path when `~/.local/bin` is not on PATH. A file already at that path that the skill did not write is left alone.

- **Where it listens:** `127.0.0.1:8765` only. The page POSTs to `/refresh?graph=<graph-id>&token=<token>`.
- **What a refresh does:**
  - re-reads the scope's tickets and their BLOCKS links;
  - keeps the labels, `column` overrides, `column_labels` and `me` from the config, and saves the config;
  - rewrites every file listed in `outputs`;
  - returns the new graph, which the page swaps in place.
- **Options (gear):** one checkbox, "Show the full chain of outside blockers". Flipping it fetches and redraws immediately (no separate refresh) and saves `outside_blockers_depth` (`"all"` or `1`) to the config. If the helper is not running, the checkbox flips back and a dialog explains. Add future options to this menu.
- **Dialogs:** after a refresh, a dialog lists what changed (status, owner, tickets or links added or removed) or says nothing changed. If the helper is not running, a dialog says so and shows the start command. Other failures also show in a dialog.
- **Styles and scripts** travel inside the swapped block, so a page opened before a renderer update picks up the new look after one refresh. The helper reloads `render_graph.py` on every refresh. Changes to `refresh_server.py` in the same install need a helper restart (stop it, then `--ensure`); a helper from a different install is replaced by the next `--new`, `--once` or `--ensure`.
- **Security:** the per-graph token stops other websites open in the browser from driving the helper. A page only carries the token of its own config.
- **Other commands:**
  - `--once <graph-id>` refreshes from the terminal without the server.
  - `--port` changes the port; set the same `port` in the config.
- **Limits:**
  - Only the graph refreshes. Prose in a report around an embedded graph is not rewritten.
  - If the number of columns changes, the change dialog says so; update `column_labels` and refresh again.

## Config (graph JSON)

```json
{
  "title": "PRD-751 dependency graph",
  "subtitle": "Individual Artifact Four-Tab Shell. Live BLOCKS links from ClosedLoop.",
  "me": "Daniel",
  "generated_at": "2026-09-24 13:43",
  "column_labels": ["foundations and design", "components and APIs", "adoption"],
  "nodes": [
    {
      "id": "ISS-10797",
      "label": "Branch adoption",
      "title": "[P751-9] Adopt the shared shell on Branch detail...",
      "owner": "Daniel",
      "status": "BLOCKED",
      "url": "https://app.closedloop.ai/closedloop-ai/issues/ISS-10797",
      "external": false,
      "column": null
    }
  ],
  "edges": [
    {"from": "ISS-10790", "to": "ISS-10797"}
  ],
  "refresh": {
    "graph_id": "prd-751",
    "token": "<random>",
    "port": 8765,
    "scope": "PRD-751",
    "api_base": "https://api.closedloop.ai",
    "app_issue_base": "https://app.closedloop.ai/closedloop-ai/issues",
    "include_plans": false,
    "outside_blockers_depth": 1,
    "outputs": [{"path": "~/Desktop/prd-751-scope-briefing.html", "mode": "embed"}]
  }
}
```

- **`from` / `to`:** `from` blocks `to`.
- **`produces`:** optional list of `{"from", "to"}` PRODUCES links from the scope document (a node with `"root": true`) to its tickets, drawn dotted.
- **`owner`:** the assignee's first name, or `"unassigned"`. A node whose `owner` equals `me` (or has `"mine": true`) is highlighted as the user's.
- **`status`:** the ClosedLoop status. BLOCKED, TRIAGE/BACKLOG and DONE get their own colors. The user's own BLOCKED tickets get a red border.
- **`column`:** optional; it overrides the automatic column.
- **`scope`:** a document or project slug. Older configs use `prd`, which still works.
- **`outside_blockers_depth`:** a number (0 turns outside blockers off) or `"all"`.
- **`outputs`:** `mode` is `page` for a standalone file or `embed` for a report with markers.
- **Without the helper:** `render_graph.py` also renders a hand-written JSON with no `refresh` section: `-o page.html`, `--fragment -o frag.html`, or `--embed-into` (which needs `refresh.graph_id`). There is no refresh button in that case.
- **Worked example:** PRD-751, 21 tickets and 50 links, is in `examples/prd-751.json`.

## What the graph does

- Columns run left to right by dependency depth. Rows are ordered to reduce crossings, and each box sits near the tickets it connects to. Tickets with no BLOCKS links sit in a grid below.
- The graph scrolls inside its frame, both ways, when it is wider than the page allows or taller than 80% of the window.
- Zoom with the top-right **− / percentage / +** controls, trackpad pinch, or Ctrl/Cmd + scroll. The graph opens zoomed to fit entirely inside its frame, and the percentage button (or **0** on the keyboard) fits it again. Focus the graph (or a ticket) and use **+ / − / 0** for keyboard zoom and fit. Zoom ranges from 25% (lower if fitting needs it) to 300% of the frame width, keeps the viewport center or pointer location anchored where scroll bounds allow, and survives a refresh in the open page. Ordinary scrolling still scrolls. Zoom also works offline and on graphs without a refresh config.
- Hover or keyboard focus on a ticket:
  - links into it (what blocks it) turn purple;
  - links out of it (what it blocks) turn teal;
  - connected tickets are outlined, and everything else fades.
- Click, or Enter on a focused ticket, pins the highlight and follows the whole chain upstream and downstream. Click empty space or press Esc to clear. Holding Shift while hovering also shows the whole chain.
- Double-click opens the ticket in ClosedLoop.
- The save button (download icon, top right) opens a menu with **Save Image**, which downloads `<title>.png`, and **Copy Image**, which puts the PNG on the clipboard for pasting into Slack or a doc. The image is the whole graph with its legend, as currently shown (a pinned chain stays highlighted), at 2x in the viewer's light or dark colors. The status line confirms each; a failure opens a dialog. It works without the helper.
- Works in light and dark mode.

## Rules

- Every BLOCKS link is drawn. If the result is too dense, say so and offer a filtered view (for example only the user's tickets and their direct neighbours); never silently omit links.
- Mark unassigned tickets as `"unassigned"`, not as a person.
- Do not add em dashes to labels or text you write.
