---
name: prd-dependency-graph
description: Build an interactive dependency graph of ClosedLoop tickets from live BLOCKS links, for a PRD or any other document (PRD-751, ISS-123) or a whole project (PRO-67). Hovering a ticket lights up what blocks it (purple) and what it blocks (teal); clicking pins the whole upstream and downstream chain. Tickets outside the scope that block it are shown too, one layer up by default or the whole chain on request. Use when the user asks for a "dependency graph", "blocker graph", "blocks graph", "graph of PRD-NNN" or "graph of PRO-NN", "what blocks what", or wants to visualize ticket dependencies. Produces a standalone HTML file (default on the Desktop) or a graph embedded in an existing report, with a refresh button that pulls the latest tickets and links through a local helper. The page carries its own config, so a copy refreshes on any machine with the skill and a ClosedLoop API key.
---

# Ticket dependency graph

Turns a scope's tickets and their BLOCKS links into an interactive HTML graph. Two scripts do all the work, so every run is deterministic and every link is drawn:

- `scripts/refresh_server.py` reads the ClosedLoop REST API, builds the graph data, and writes the page. It is also the local helper behind the refresh button.
- `scripts/render_graph.py` draws the graph, and embeds the graph's config in it.

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

1. **Create the graph.** The API key comes from `CLOSEDLOOP_API_KEY`, and a login shell is used as a fallback, so an export in `~/.zprofile` works. The helper asks the ClosedLoop API whose key it is and highlights that person's tickets as "yours", so there is no name to pass.
   - Standalone page:
     ```
     python3 scripts/refresh_server.py --new PRD-751 -o ~/Desktop/prd-751-dependency-graph.html
     ```
   - Inside an existing report: first put `<!-- depgraph:<graph-id>:start -->` and `<!-- depgraph:<graph-id>:end -->` where the graph belongs (the graph id defaults to the slug in lowercase), then:
     ```
     python3 scripts/refresh_server.py --new PRD-751 --embed-into <report.html>
     ```
   - Options:
     - `--outside-depth all` (or a number) follows outside blockers further.
     - `--include-plans` adds implementation plans.
     - `--graph-id` names the graph if the report already holds one with the default id.
     - `--me <first name>` is only a fallback for when the API lookup fails.

   It fetches everything, writes the page with the graph's config inside it, and prints the ticket and link counts and whose tickets are highlighted. Nothing is saved outside the page.

2. **Name the columns.** Run `python3 scripts/render_graph.py <page.html> --print-columns` (add `--graph <graph-id>` when a report holds several graphs).
   - Columns come from dependency depth. Read which tickets landed in each and write a short `column_labels` entry for each, for example "foundations and design", "components and APIs", "adoption", "retirement".
   - Tickets with no BLOCKS links are not in any column. They are drawn in a grid below the graph, titled "No BLOCKS links".
   - For large scopes where the columns mix unrelated work, plain numbers are fine; say so rather than inventing labels.

3. **Tidy labels.** Each ticket's `label` is derived from its title, with prefixes like `[P751-3]` stripped and the text cut to about 28 characters. Shorten any that read badly to 2 to 4 words. Keep the full title in `title`, which is shown as a tooltip. Labels and columns are kept across refreshes.

4. **Apply the edits.** Export the page's config, edit it, and refresh the page from it:
   ```
   python3 scripts/refresh_server.py --export-config <page.html> > /tmp/graph.json
   # edit column_labels and node labels in /tmp/graph.json
   python3 scripts/refresh_server.py --once <page.html> --apply-config /tmp/graph.json
   ```
   `--once <page.html>` on its own refreshes the page in place from the API and prints what changed. For a graph made before pages carried their config, edit `~/.local/share/prd-dependency-graph/<graph-id>.json` and run `--once <graph-id>` instead (see "Older graphs").

5. **Verify.**
   - The printed counts must match what the API holds. Never drop edges to make a picture cleaner.
   - Headless browser check: `node scripts/check_graph.cjs <file.html> <a ticket with many links> <screenshot.png>`. It works on a copy of the file and confirms there are no script errors, hover highlights exactly the ticket's incoming and outgoing links, click pins the chain, Esc clears, zoom changes the graph size without disturbing a pinned chain, a refresh from a file sends the file's path and reloads with the change dialog and the same zoom, a refresh of a page served from this machine swaps in place and says no file changed, only one toolbar menu is open at a time, Save Image downloads a PNG, and Copy Image puts a PNG on the clipboard. It never calls ClosedLoop. It needs `playwright-core` and Chrome; set `PLAYWRIGHT_CORE` and `CHROME_PATH` if the defaults do not exist. Look at the screenshot.

6. **Report back** with:
   - the file path;
   - ticket and link counts, how many tickets are outside the scope and how many have no links;
   - a one-line summary of the main chains (what gates what);
   - how refresh works (below): the helper is already running in the background, and `prd-graph-helper` starts it again after a reboot;
   - that the file can be shared as is (see "Sharing a page").
   Offer to open it.

## Refresh button

The graph's top-right corner has zoom controls, a gear (options), and a refresh icon. The gear and refresh icon need the local helper running.

- **Started for the user:** `--new` and `--once` start the helper in the background when it is not running, and replace a helper left running from another install of this skill (for example after a plugin update). `--ensure` does only that. The helper's log is `~/.local/share/prd-dependency-graph/helper.log`.
- **Starting it by hand** (for example after a reboot): `prd-graph-helper`. Every run writes that launcher to `~/.local/bin/prd-graph-helper`, pointing at the installed `scripts/refresh_server.py`, so the command survives plugin updates even though the installed path changes with each version. The page's "helper not running" dialog shows `prd-graph-helper`, or `~/.local/bin/prd-graph-helper` when that folder is not on PATH. A file already at that path that the skill did not write is left alone. If an older helper is running, the dialog says it is out of date and shows `prd-graph-helper --ensure`, which replaces it.
- **Where it listens:** `127.0.0.1:8765` only (the graph's `port`).
- **What a refresh does:**
  - the page POSTs its graph id and scope to `/v2/refresh`, and, when it was opened from a file, the file's own path;
  - the helper checks the file (see "Security"), reads the graph's config from it, re-reads the scope's tickets and BLOCKS links with this machine's API key, and looks up whose key it is for the "yours" highlighting;
  - it keeps the labels, `column` overrides and `column_labels`, and rewrites only that graph's block in the file;
  - it answers without ticket data, and the page reloads from the file and shows the change dialog from the config the helper wrote into it. The zoom is kept.
- **Pages that are not files** (for example a report served from `http://localhost`): the page sends its config instead of a path, the helper sends the new graph back, the page swaps it in place, and the dialog says only that view was updated and no file on disk changed. Pages on any other website cannot refresh.
- **Options (gear):** one checkbox, "Show the full chain of outside blockers". Flipping it fetches and redraws immediately (no separate refresh) and saves `outside_blockers_depth` (`"all"` or `1`) in the page. If the helper is not running, the checkbox flips back and a dialog explains. Add future options to this menu.
- **Dialogs:** after a refresh, a dialog lists what changed (status, owner, tickets or links added or removed) or says nothing changed. If the helper is not running, a dialog says so and shows the start command. Other failures also show in a dialog.
- **Styles and scripts** travel inside the refreshed block, so a page made by an older renderer picks up the new look after one refresh. The helper reloads `render_graph.py` on every refresh. Changes to `refresh_server.py` in the same install need a helper restart (stop it, then `--ensure`); a helper from a different install is replaced by the next `--new`, `--once` or `--ensure`.
- **Other commands:**
  - `--once <page.html>` refreshes a page or report from the terminal without the server (`--graph <graph-id>` picks one graph in a report). `--once <graph-id>` refreshes an older graph from its config file.
  - `--export-config <page.html>` prints the config a page carries.
  - `--port` changes the port of the helper and of a new graph.
- **Limits:**
  - Only the graph refreshes. Prose in a report around an embedded graph is not rewritten.
  - If the number of columns changes, the change dialog says so; update `column_labels` and refresh again.
  - A page cannot refresh the same file again within 3 seconds; wait a moment.

## Sharing a page

A page, or a report with embedded graphs, can be copied to any machine and refreshed in place there:

- **What to share:** just the HTML file. Each graph carries its own config (scope, options, labels, columns, nodes and links). There is no side file to send, and the page holds no token, no file path and no API key.
- **What the other person needs:** this skill installed (any run of it writes `prd-graph-helper`) and their own `CLOSEDLOOP_API_KEY` with access to the scope. They open the file in a browser and click refresh; the helper rewrites their copy wherever they saved it.
- **"Yours":** a page highlights the tickets of whoever last refreshed it. A copy shows the author's highlighting until the new owner refreshes it, then shows theirs.
- **Pages made before this version** carry a token instead of a config and refresh only on the machine that made them. Refresh one there once (see "Older graphs") and share the refreshed file.

## Older graphs

Graphs made before pages carried their config have a config in `~/.local/share/prd-dependency-graph/<graph-id>.json`, with `me`, a per-graph token and the absolute `outputs` paths it rewrites. They keep working:

- an old page's refresh button still uses its token URL (`/refresh?graph=<graph-id>&token=<token>`), and the helper still answers it;
- `--once <graph-id>` still refreshes from the config;
- while that config lists a file, it stays the source of truth for that file, whichever way the refresh comes in, so its labels and `column_labels` are edited there;
- every refresh writes the new format into the listed files: the graph's config is embedded, standalone pages gain depgraph markers, and the token is no longer in the page. From then on the page itself can be shared;
- "yours" follows the API key's owner; the config's `me` is used only when that lookup fails.

Deleting the config makes the page refresh from its own embedded config.

## Security

The helper listens on `127.0.0.1`, and any website open in the browser can send it requests. Pages no longer carry a per-graph token, so the helper protects itself as follows. `tools/python/test_prd_dependency_graph_security.py` pins each rule.

- **Reading ClosedLoop data (exfiltration).** A refresh from a file page answers only `{ok, written, refresh_id}`: the new graph goes into the file, and only the page itself, read from disk, can see it. A website cannot read a `file://` page. The graph is sent back only to pages served from this machine (`http://localhost`, `127.0.0.1`, `[::1]`) and to local programs that send no Origin, which could read the files and the key anyway. A request with Origin `null` (a file page, or a sandboxed frame on any website) never gets ticket data, and any other origin is refused. Error messages carry no ticket data. The old token endpoint answers only with the token, which is never in a page made by this version. The one thing a website can learn is whether a file at a path it guesses holds a given graph.
- **Revealing who you are.** A path on this machine holds the username, so the helper sends none to a browser. `GET /health` answers any request that carries an Origin, `null` and pages from this machine included, with only `{ok, protocol}`, which is all a page needs to tell an out-of-date helper from a missing one. The helper's script path and pid, which `--ensure` uses to recognize and replace a helper from another install, go only to requests with no Origin addressed to `127.0.0.1`, `localhost` or `[::1]`; a page reached through DNS rebinding sends no Origin on a GET, but it names its own host. A refresh from a file page answers without the file's path, and errors name a file only as the request gave it, never a symlink's target.
- **Writing files.** A refresh writes only to an absolute path that ends in `.html` or `.htm`, before and after resolving symlinks, and that is an existing regular file owned by the user, at most 64 MB, with this graph's depgraph markers and an embedded config naming the requested scope. Only the text between those markers is replaced, atomically, and not if the file changed during the refresh.
- **Spending API calls.** A request must name a graph id and a scope (strictly formatted, so neither can reach another API path), and the target file must hold that graph for that scope; these checks run before any API call. Requests must be JSON, which makes browsers ask first (CORS preflight), and only file pages and pages from this machine are allowed to send them, so a plain cross-site form or `fetch` never reaches a refresh. The same file or graph cannot be refreshed again within 3 seconds, at most two refreshes run at once, and request bodies are capped at 4 MB.
- **The API key** is read from `CLOSEDLOOP_API_KEY` or a login shell, is never written to any file, and is only sent to `https://api.closedloop.ai`. A page cannot redirect it: an API base in a page's config is ignored, and only a local older config can set one.
- **What a page cannot change:** links in a page's config must point at `https://app.closedloop.ai`, and every value is type-checked and length-capped before it is used or drawn.

## Config (inside the page)

Each graph block carries its config in `<template class="dg-config" data-dg-graph="<graph-id>">`, as HTML-escaped JSON, between the graph's depgraph markers. A `<template>` is never run, so a page with an older script cannot execute it. `--export-config` prints it:

```json
{
  "version": 2,
  "title": "PRD-751 dependency graph",
  "subtitle": "Individual Artifact Four-Tab Shell. Live BLOCKS links from ClosedLoop.",
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
  "produces": [],
  "refresh": {
    "graph_id": "prd-751",
    "scope": "PRD-751",
    "port": 8765,
    "app_issue_base": "https://app.closedloop.ai/closedloop-ai/issues",
    "outside_blockers_depth": 1
  },
  "last_refresh": {"id": "<random>", "summary": "Refreshed ...", "changes": []}
}
```

- **`from` / `to`:** `from` blocks `to`.
- **`produces`:** optional list of `{"from", "to"}` PRODUCES links from the scope document (a node with `"root": true`) to its tickets, drawn dotted.
- **`owner`:** the assignee's first name, or `"unassigned"`. A node whose `owner` equals the viewer's first name is highlighted as theirs.
- **`status`:** the ClosedLoop status. BLOCKED, TRIAGE/BACKLOG and DONE get their own colors. The viewer's own BLOCKED tickets get a red border.
- **`column`:** optional; it overrides the automatic column.
- **`scope`:** a document or project slug. Older configs use `prd`, which still works.
- **`outside_blockers_depth`:** a number (0 turns outside blockers off) or `"all"`. **`include_plans`** appears when plans are included.
- **`last_refresh`:** what the last refresh changed; a page reloaded by a refresh shows it in the change dialog.
- **Not in a page:** a token, output paths, the API base and `me`. Those belong to one machine or person.
- **Without the helper:** `render_graph.py` also renders a hand-written JSON: `-o page.html`, `--fragment -o frag.html`, or `--embed-into` (which needs `refresh.graph_id`). A JSON with no `refresh.graph_id` and `refresh.scope` has no refresh button. In a hand-written JSON, `"me"` names whose tickets are highlighted and `"mine": true` marks a node as theirs; neither is carried into a page's config.
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
