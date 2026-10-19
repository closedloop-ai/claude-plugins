#!/usr/bin/env python3
"""Render an interactive ticket dependency graph (SVG + hover/pin highlighting) as HTML.

Input: a JSON file describing tickets and BLOCKS edges (schema in ../SKILL.md), or
an HTML page or report that already holds a refreshable graph (its embedded config).
Output: a standalone HTML page (default) or an embeddable fragment (--fragment).
Tickets with no BLOCKS links at all are laid out in a grid below the graph.

Layout is automatic: columns come from dependency depth (longest path from a
root), rows are ordered with barycenter sweeps to reduce crossings, and edges
that skip columns are routed through the gaps between boxes. Every edge in the
input is drawn; the script exits non-zero if it cannot draw one.
"""

import argparse
import hashlib
import html
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BOX_W = 210
COL_GAP = 110
ROW_GAP = 26
MIN_BOX_H = 50
PORT_STEP = 8
TOP = 130
LEFT = 20
LANE_STEP = 6
GRID_GAP = 24
MIN_SCALE = 0.7  # below this the graph scrolls inside its frame instead of shrinking

STATUS_DONE = {"DONE", "CANCELED", "CANCELLED", "EXECUTED", "OBSOLETE", "APPROVED"}
STATUS_TRIAGE = {"TRIAGE", "BACKLOG", "DRAFT"}
STATUS_BLOCKED = {"BLOCKED"}


def esc(text):
    return html.escape(str(text), quote=True)


def load(path, graph_id=None):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if Path(path).suffix.lower() in HTML_SUFFIXES:
        ids = embedded_graph_ids(text)
        graph_id = graph_id or (ids[0] if len(ids) == 1 else None)
        data = read_embedded(text, graph_id) if graph_id else None
        if data is None:
            sys.exit(f"error: {path} holds no embedded graph config" + (f" for '{graph_id}'" if graph_id else "")
                     + (f"; it holds {', '.join(ids)} (pick one with --graph)" if len(ids) > 1 and not graph_id else ""))
    else:
        data = json.loads(text)
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    ids = [n["id"] for n in nodes]
    if len(ids) != len(set(ids)):
        sys.exit("error: duplicate node ids")
    known = set(ids)
    data["edges"] = clean_edges(edges, known)
    data["produces"] = clean_edges(data.get("produces") or [], known)
    return data


def clean_edges(edges, known):
    clean = []
    seen = set()
    for edge in edges:
        src, dst = (edge["from"], edge["to"]) if isinstance(edge, dict) else (edge[0], edge[1])
        if src not in known or dst not in known:
            sys.exit(f"error: edge {src} -> {dst} references an unknown node")
        if (src, dst) in seen:
            continue
        seen.add((src, dst))
        clean.append((src, dst))
    return clean


def assign_columns(nodes, edges):
    preds = defaultdict(list)
    for src, dst in edges:
        preds[dst].append(src)
    col = {}
    visiting = set()
    broken = []

    def depth(nid):
        if nid in col:
            return col[nid]
        if nid in visiting:
            broken.append(nid)
            return 0
        visiting.add(nid)
        best = 0
        for p in preds[nid]:
            best = max(best, depth(p) + 1)
        visiting.discard(nid)
        col[nid] = best
        return best

    for n in nodes:
        depth(n["id"])
    for n in nodes:
        if n.get("column") is not None:
            col[n["id"]] = int(n["column"])
    if broken:
        print(f"warning: dependency cycle involving {sorted(set(broken))}", file=sys.stderr)
    return col


def box_height(nid, edges):
    ins = sum(1 for _, d in edges if d == nid)
    outs = sum(1 for s, _ in edges if s == nid)
    return max(MIN_BOX_H, 20 + PORT_STEP * max(ins, outs))


def order_rows(nodes, edges, col):
    columns = defaultdict(list)
    for n in nodes:
        columns[col[n["id"]]].append(n["id"])
    ncols = max(columns) + 1 if columns else 0
    rank = {}
    for c in range(ncols):
        for i, nid in enumerate(columns[c]):
            rank[nid] = i
    nbrs_prev = defaultdict(list)
    nbrs_next = defaultdict(list)
    for s, d in edges:
        nbrs_next[s].append(d)
        nbrs_prev[d].append(s)

    def sweep(order_cols, neighbours):
        for c in order_cols:
            keyed = []
            for i, nid in enumerate(columns[c]):
                ns = neighbours[nid]
                bary = sum(rank[x] for x in ns) / len(ns) if ns else rank[nid]
                keyed.append((bary, i, nid))
            keyed.sort()
            columns[c] = [k[2] for k in keyed]
            for i, nid in enumerate(columns[c]):
                rank[nid] = i

    for _ in range(4):
        sweep(range(1, ncols), nbrs_prev)
        sweep(range(ncols - 2, -1, -1), nbrs_next)
    return columns, ncols


def layout(nodes, edges, col):
    columns, ncols = order_rows(nodes, edges, col)
    heights = {n["id"]: box_height(n["id"], edges) for n in nodes}
    preds = defaultdict(list)
    succs = defaultdict(list)
    for s, d in edges:
        preds[d].append(s)
        succs[s].append(d)
    pos = {}
    col_bottom = {}

    def place(c, want):
        # Keep the column's order, put each box as close to its wanted top as
        # possible without overlapping the box above it.
        x = LEFT + c * (BOX_W + COL_GAP)
        y = TOP
        for nid in columns[c]:
            top = max(y, want.get(nid, y))
            pos[nid] = (x, top, heights[nid])
            y = top + heights[nid] + ROW_GAP
        col_bottom[c] = y

    for c in range(ncols):
        place(c, {})
    for _ in range(3):
        for c in range(1, ncols):
            want = {}
            for nid in columns[c]:
                placed = [p for p in preds[nid] if p in pos and pos[p][0] < LEFT + c * (BOX_W + COL_GAP)]
                if placed:
                    centre = sum(pos[p][1] + pos[p][2] / 2 for p in placed) / len(placed)
                    want[nid] = centre - heights[nid] / 2
            place(c, want)
        for c in range(ncols - 2, -1, -1):
            want = {}
            for nid in columns[c]:
                if preds[nid]:
                    continue
                later = [s for s in succs[nid] if s in pos]
                if later:
                    centre = sum(pos[s][1] + pos[s][2] / 2 for s in later) / len(later)
                    want[nid] = centre - heights[nid] / 2
            if want:
                place(c, want)
    # Alignment only ever pushes boxes down, so pull the whole drawing back up
    # to the top margin once placement settles.
    lift = min(p[1] for p in pos.values()) - TOP if pos else 0
    if lift > 0:
        pos = {k: (x, y - lift, h) for k, (x, y, h) in pos.items()}
        col_bottom = {c: b - lift for c, b in col_bottom.items()}
    return columns, ncols, pos, col_bottom


def gaps_for_column(c, columns, pos):
    boxes = sorted((pos[n][1], pos[n][1] + pos[n][2]) for n in columns[c])
    gaps = []
    prev = TOP - ROW_GAP
    for top, bottom in boxes:
        gaps.append((prev, top))
        prev = bottom
    gaps.append((prev, prev + 2 * ROW_GAP))
    return gaps


def route(edges, col, columns, pos):
    out_ports = defaultdict(list)
    in_ports = defaultdict(list)
    for s, d in edges:
        out_ports[s].append(d)
        in_ports[d].append(s)
    for s in out_ports:
        out_ports[s].sort(key=lambda d: pos[d][1])
    for d in in_ports:
        in_ports[d].sort(key=lambda s: pos[s][1])

    def port_y(nid, index, count):
        x, y, h = pos[nid]
        span = (count - 1) * PORT_STEP
        return y + h / 2 - span / 2 + index * PORT_STEP

    lane_use = defaultdict(int)
    paths = []
    for s, d in edges:
        sx, sy, sh = pos[s]
        dx, dy, dh = pos[d]
        y1 = port_y(s, out_ports[s].index(d), len(out_ports[s]))
        y2 = port_y(d, in_ports[d].index(s), len(in_ports[d]))
        cs, cd = col[s], col[d]
        if cs == cd:
            xm = sx + BOX_W / 2 + (lane_use[("v", s)] * LANE_STEP)
            lane_use[("v", s)] += 1
            if dy > sy:
                paths.append((s, d, f"M{xm},{sy + sh} L{xm},{dy}"))
            else:
                paths.append((s, d, f"M{xm},{sy} L{xm},{dy + dh}"))
            continue
        if cd < cs:
            x1, x2 = sx, dx + BOX_W
            bend = 60
            paths.append((s, d, f"M{x1},{y1} C{x1 - bend},{y1} {x2 + bend},{y2} {x2},{y2}"))
            continue
        x1 = sx + BOX_W
        x2 = dx
        if cd == cs + 1:
            mx = (x1 + x2) / 2
            paths.append((s, d, f"M{x1},{y1} C{mx},{y1} {mx},{y2} {x2},{y2}"))
            continue
        seg = [f"M{x1},{y1}"]
        cur_x, cur_y = x1, y1
        total = cd - cs
        for step, c in enumerate(range(cs + 1, cd)):
            target = y1 + (y2 - y1) * (step + 1) / total
            best = min(gaps_for_column(c, columns, pos),
                       key=lambda g: abs((g[0] + g[1]) / 2 - target))
            key = ("lane", c, best)
            offset = lane_use[key]
            lane_use[key] += 1
            centre = (best[0] + best[1]) / 2
            room = max(0.0, (best[1] - best[0]) / 2 - 4)
            shift = ((offset + 1) // 2) * LANE_STEP * (1 if offset % 2 else -1)
            lane_y = centre + max(-room, min(room, shift))
            col_left = LEFT + c * (BOX_W + COL_GAP)
            col_right = col_left + BOX_W
            mx = (cur_x + col_left) / 2
            seg.append(f"C{mx},{cur_y} {mx},{lane_y} {col_left},{lane_y}")
            seg.append(f"L{col_right},{lane_y}")
            cur_x, cur_y = col_right, lane_y
        mx = (cur_x + x2) / 2
        seg.append(f"C{mx},{cur_y} {mx},{y2} {x2},{y2}")
        paths.append((s, d, " ".join(seg)))
    return paths


def status_key(node):
    return str(node.get("status", "")).upper().replace(" ", "_")


def box_class(node, me):
    key = status_key(node)
    if node.get("mine") or (me and node.get("owner") == me):
        if key in STATUS_DONE:
            return "boxme boxok"
        return "boxme boxmebl" if key in STATUS_BLOCKED else "boxme"
    if key in STATUS_BLOCKED:
        base = "boxbl"
    elif key in STATUS_TRIAGE:
        base = "boxtr"
    elif key in STATUS_DONE:
        base = "boxok"
    else:
        base = "box"
    # Outside tickets keep their status color; the dashed border is what marks them as outside.
    return f"{base} boxext" if node.get("external") else base


def trunc(text, limit):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


CSS = """
.depgraph{--dg-panel:#ffffff;--dg-ink:#1d1d1f;--dg-muted:#5f6368;--dg-line:#d6d3cc;
--dg-me:#3b5bdb;--dg-me-soft:#eef2ff;--dg-bl:#b42318;--dg-bl-soft:#fdecea;
--dg-tr:#b54708;--dg-tr-soft:#fff4e5;--dg-ok:#1a7f37;--dg-ok-soft:#e9f7ee;
--dg-up:#9333ea;--dg-down:#0e7490;--dg-edge:#8a8f98}
@media (prefers-color-scheme: dark){.depgraph{--dg-panel:#1e2024;--dg-ink:#e8e8ea;--dg-muted:#a1a4ab;
--dg-line:#3a3d44;--dg-me:#8fa8ff;--dg-me-soft:#232a45;--dg-bl:#ff8a80;--dg-bl-soft:#3a1c1a;
--dg-tr:#f5a25b;--dg-tr-soft:#3a2a17;--dg-ok:#5fd07e;--dg-ok-soft:#17301f;
--dg-up:#d8b4fe;--dg-down:#22d3ee;--dg-edge:#6b7079}}
.depgraph{overflow:auto;max-height:80vh;background:var(--dg-panel);border:1px solid var(--dg-line);border-radius:10px;padding:8px}
.depgraph svg{display:block;width:100%;height:auto}
.depgraph:focus-visible{outline:2px solid #6e56cf;outline-offset:2px}
.depgraph .grid-title{font-size:12px;font-weight:600;fill:var(--dg-muted)}
.depgraph text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:var(--dg-ink)}
.depgraph .small{font-size:11px;fill:var(--dg-muted)}
.depgraph .lbl{font-size:12.5px;font-weight:600}
.depgraph .box{fill:var(--dg-panel);stroke:var(--dg-line)}
.depgraph .boxme{fill:var(--dg-me-soft);stroke:var(--dg-me);stroke-width:2}
.depgraph .boxbl{fill:var(--dg-bl-soft);stroke:var(--dg-bl)}
.depgraph .boxme.boxmebl{stroke:#e5484d;stroke-width:3}
.depgraph .boxtr{fill:var(--dg-tr-soft);stroke:var(--dg-tr)}
.depgraph .boxok{fill:var(--dg-ok-soft);stroke:var(--dg-ok)}
.depgraph .boxext{stroke-dasharray:5 4}
.depgraph .edge{stroke:var(--dg-edge);stroke-width:1.3;fill:none;marker-end:url(#dg-arr);transition:opacity .12s}
.depgraph .edge.produces{stroke-dasharray:2 4}
.depgraph .edge.open{stroke:var(--dg-bl);stroke-width:1.6;marker-end:url(#dg-arr-open)}
.depgraph .mk-open{fill:var(--dg-bl)}
.depgraph .legend-open{stroke:var(--dg-bl);stroke-width:1.6}
.depgraph .legend-produces{stroke:var(--dg-edge);stroke-width:1.6;stroke-dasharray:2 4}
.depgraph .mk{fill:var(--dg-edge)} .depgraph .mk-up{fill:var(--dg-up)} .depgraph .mk-down{fill:var(--dg-down)}
.depgraph .node{cursor:pointer;outline:none;transition:opacity .12s}
.depgraph .edge.up{stroke:var(--dg-up);stroke-width:2.6;marker-end:url(#dg-arr-up)}
.depgraph .edge.down{stroke:var(--dg-down);stroke-width:2.6;marker-end:url(#dg-arr-down)}
.depgraph .node.hl-up rect{stroke:var(--dg-up);stroke-width:3}
.depgraph .node.hl-down rect{stroke:var(--dg-down);stroke-width:3}
.depgraph .node.hl-self rect{stroke:var(--dg-ink);stroke-width:4}
.depgraph .node:focus-visible rect{stroke:var(--dg-ink);stroke-width:3}
.depgraph svg.dimmed .edge:not(.up):not(.down){opacity:.15}
.depgraph svg.dimmed .node:not(.hl-up):not(.hl-down):not(.hl-self){opacity:.25}
.depgraph-help{font-size:13px;color:var(--dg-muted,#5f6368);margin:8px 2px}
.depgraph-help .k-up{color:#9333ea;font-weight:700} .depgraph-help .k-down{color:#0e7490;font-weight:700}
@media (prefers-color-scheme: dark){.depgraph-help .k-up{color:#d8b4fe}.depgraph-help .k-down{color:#22d3ee}}
.dg-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 2px 8px;font-size:13px;color:#5f6368}
.dg-refresh{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:7px;border:1px solid #c9c6bf;background:#ffffff;color:#5f6368;cursor:pointer}
.dg-refresh:hover{background:#f2f0ec;color:#1d1d1f} .dg-refresh:focus-visible{outline:2px solid #6e56cf;outline-offset:2px}
.dg-refresh svg{width:15px;height:15px} .dg-refresh:disabled{cursor:progress} .dg-reload:disabled svg{animation:dg-spin 1s linear infinite}
@keyframes dg-spin{to{transform:rotate(360deg)}} @media (prefers-reduced-motion: reduce){.dg-reload:disabled svg{animation:none}}
.dg-frame{position:relative}
.dg-controls{position:absolute;top:10px;right:22px;z-index:2;display:flex;gap:6px}
.dg-zoom{display:flex;gap:4px}
.dg-zoom .dg-refresh{font:18px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.dg-zoom .dg-zoom-reset{width:54px;font-size:12px;font-variant-numeric:tabular-nums}
.dg-zoom .dg-refresh:disabled{opacity:.45;cursor:default}
.dg-menu-wrap{position:relative}
.dg-save-menu{min-width:150px;padding:4px}
.dg-menu-item{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}
.dg-menu-item:hover,.dg-menu-item:focus-visible{background:#f2f0ec;outline:none}
@media (prefers-color-scheme: dark){.dg-menu-item:hover,.dg-menu-item:focus-visible{background:#2f3238}}
.dg-menu{position:absolute;top:34px;right:0;min-width:250px;padding:10px 12px;border-radius:8px;border:1px solid #d6d3cc;background:#ffffff;color:#1d1d1f;box-shadow:0 6px 20px rgba(0,0,0,.15);font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.dg-menu label{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.dg-menu input{margin:2px 0 0}
.dg-menu .dg-hint{display:block;color:#5f6368;font-size:12px;margin-top:2px}
@media (prefers-color-scheme: dark){.dg-menu{background:#1e2024;color:#e8e8ea;border-color:#3a3d44}.dg-menu .dg-hint{color:#a1a4ab}}
.dg-dialog{max-width:520px;width:calc(100% - 32px);border:1px solid #d6d3cc;border-radius:10px;padding:18px 20px;background:#ffffff;color:#1d1d1f;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.dg-dialog::backdrop{background:rgba(0,0,0,.35)}
.dg-dialog h3{margin:0 0 8px;font-size:15px}
.dg-dialog ul{margin:6px 0;padding-left:20px}
.dg-dialog code{display:block;margin:8px 0;padding:8px 10px;border-radius:6px;background:#f2f0ec;font-size:12.5px;white-space:pre;overflow-x:auto}
.dg-dialog form{display:flex;justify-content:flex-end;margin:12px 0 0}
.dg-dialog button{font:inherit;padding:5px 14px;border-radius:7px;border:1px solid #c9c6bf;background:#ffffff;color:inherit;cursor:pointer}
@media (prefers-color-scheme: dark){.dg-dialog{background:#1e2024;color:#e8e8ea;border-color:#3a3d44}.dg-dialog code{background:#2a2d33}.dg-dialog button{background:#26282d;border-color:#44474e}}
@media (prefers-color-scheme: dark){.dg-toolbar{color:#a1a4ab}.dg-refresh{background:#26282d;color:#a1a4ab;border-color:#44474e}.dg-refresh:hover{background:#2f3238;color:#e8e8ea}}
"""

JS_SRC = r"""
(function () {
  var VERSION = '__DG_VERSION__';
  if (window.__depgraph && window.__depgraph.version === VERSION) { window.__depgraph.initAll(); return; }
  var states = [];

  function initGraph(svg) {
    if (svg.__dg) return;
    var edgeLayer = svg.querySelector('g.edges');
    var edges = Array.prototype.slice.call(svg.querySelectorAll('path.edge'));
    var nodes = {};
    Array.prototype.forEach.call(svg.querySelectorAll('g.node'), function (g) { nodes[g.getAttribute('data-id')] = g; });
    var into = {}, outOf = {};
    edges.forEach(function (e) {
      var f = e.getAttribute('data-from'), t = e.getAttribute('data-to');
      (outOf[f] = outOf[f] || []).push(e);
      (into[t] = into[t] || []).push(e);
    });
    var st = { svg: svg, pinned: null, hovered: null, shiftDown: false };
    function clear() {
      svg.classList.remove('dimmed');
      edges.forEach(function (e) { e.classList.remove('up', 'down'); });
      Object.keys(nodes).forEach(function (k) { nodes[k].classList.remove('hl-up', 'hl-down', 'hl-self'); });
    }
    function walk(id, map, attr, nodeCls, edgeCls, transitive, seen) {
      (map[id] || []).forEach(function (e) {
        e.classList.add(edgeCls);
        edgeLayer.appendChild(e);
        var other = e.getAttribute(attr);
        if (nodes[other]) nodes[other].classList.add(nodeCls);
        if (transitive && !seen[other]) { seen[other] = true; walk(other, map, attr, nodeCls, edgeCls, true, seen); }
      });
    }
    function show(id, transitive) {
      clear();
      if (!id || !nodes[id]) return;
      svg.classList.add('dimmed');
      nodes[id].classList.add('hl-self');
      walk(id, into, 'data-from', 'hl-up', 'up', transitive, {});
      walk(id, outOf, 'data-to', 'hl-down', 'down', transitive, {});
    }
    st.render = function () {
      if (st.pinned) show(st.pinned, true);
      else if (st.hovered) show(st.hovered, st.shiftDown);
      else clear();
    };
    function togglePin(id) { st.pinned = st.pinned === id ? null : id; st.render(); }
    Object.keys(nodes).forEach(function (id) {
      var g = nodes[id];
      g.addEventListener('mouseenter', function (ev) { st.hovered = id; st.shiftDown = ev.shiftKey; st.render(); });
      g.addEventListener('mouseleave', function () { if (st.hovered === id) st.hovered = null; st.render(); });
      g.addEventListener('focus', function () { st.hovered = id; st.render(); });
      g.addEventListener('blur', function () { if (st.hovered === id) st.hovered = null; st.render(); });
      g.addEventListener('click', function (ev) { ev.stopPropagation(); togglePin(id); });
      g.addEventListener('dblclick', function (ev) {
        ev.stopPropagation();
        var url = g.getAttribute('data-url');
        if (url) window.open(url, '_blank', 'noopener');
      });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); togglePin(id); }
      });
    });
    svg.addEventListener('click', function () { if (st.pinned) { st.pinned = null; st.render(); } });
    svg.__dg = st;
    states.push(st);
  }

  function escText(t) {
    return String(t).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; });
  }

  // Resize the SVG itself so scrolling and ticket hit targets follow the zoom.
  // Each block owns its scale; controls also work on graphs with no helper.
  function initZoom(block) {
    if (block.__dgZoom) return;
    var viewport = block.querySelector('.depgraph');
    var svg = viewport && viewport.querySelector('svg');
    var minus = block.querySelector('.dg-zoom-out');
    var plus = block.querySelector('.dg-zoom-in');
    var reset = block.querySelector('.dg-zoom-reset');
    if (!svg || !minus || !plus || !reset) return;
    var baseWidth = svg.getBoundingClientRect().width;
    var aspect = svg.viewBox.baseVal.height / svg.viewBox.baseVal.width;
    var pad = parseFloat(getComputedStyle(viewport).paddingLeft) || 0;
    // The zoom that shows the whole graph inside the frame (which is capped at 80% of the window height).
    var fit = Math.min((viewport.clientWidth - 2 * pad) / baseWidth,
                       (viewport.clientHeight - 2 * pad) / (baseWidth * aspect));
    fit = fit > 0 && isFinite(fit) ? fit : 1;
    var minZoom = Math.min(.25, fit);
    var st = { zoom: 1, fit: fit, set: setZoom };
    block.__dgZoom = st;
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Dependency graph. Use plus and minus to zoom, zero to fit the whole graph.');
    reset.setAttribute('aria-label', 'Fit the whole graph');
    reset.setAttribute('title', 'Fit the whole graph');

    // Keep the graph point under the pointer (or viewport center) in place.
    function setZoom(value, pointer) {
      var next = Math.max(minZoom, Math.min(3, value));
      var rect = viewport.getBoundingClientRect();
      var x = pointer ? pointer.clientX - rect.left - viewport.clientLeft : viewport.clientWidth / 2;
      var y = pointer ? pointer.clientY - rect.top - viewport.clientTop : viewport.clientHeight / 2;
      var padding = parseFloat(getComputedStyle(viewport).paddingLeft) || 0;
      var ratio = next / st.zoom;
      var left = (viewport.scrollLeft + x - padding) * ratio + padding - x;
      var top = (viewport.scrollTop + y - padding) * ratio + padding - y;
      st.zoom = next;
      svg.style.minWidth = '0';
      svg.style.width = (baseWidth * next) + 'px';
      svg.style.height = (baseWidth * next * aspect) + 'px';
      viewport.scrollLeft = left;
      viewport.scrollTop = top;
      reset.textContent = Math.round(next * 100) + '%';
      minus.disabled = next <= minZoom;
      plus.disabled = next >= 3;
    }
    minus.addEventListener('click', function () { setZoom(st.zoom / 1.2); });
    plus.addEventListener('click', function () { setZoom(st.zoom * 1.2); });
    reset.addEventListener('click', function () { setZoom(fit); });
    viewport.addEventListener('wheel', function (ev) {
      // Pinch gestures arrive as Ctrl+wheel; ordinary scrolling stays native.
      if ((!ev.ctrlKey && !ev.metaKey) || !ev.deltaY) return;
      ev.preventDefault();
      var delta = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? viewport.clientHeight : 1);
      setZoom(st.zoom * Math.exp(-Math.max(-100, Math.min(100, delta)) * .01), ev);
    }, { passive: false });
    viewport.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === '+' || ev.key === '=') setZoom(st.zoom * 1.2);
      else if (ev.key === '-') setZoom(st.zoom / 1.2);
      else if (ev.key === '0') setZoom(fit);
      else return;
      ev.preventDefault();
    });
    setZoom(Number(block.getAttribute('data-dg-zoom')) || fit);
  }

  function showDialog(block, title, bodyHtml) {
    var dlg = block.querySelector('.dg-dialog');
    if (!dlg) return;
    dlg.querySelector('h3').textContent = title;
    dlg.querySelector('.dg-dialog-body').innerHTML = bodyHtml;
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  // Only one toolbar menu is open at a time; the toggles stop propagation, so close the others here.
  function closeOtherMenus(block, keep) {
    block.querySelectorAll('.dg-menu').forEach(function (m) {
      if (m === keep || m.hidden) return;
      m.hidden = true;
      var owner = block.querySelector('[aria-controls="' + m.id + '"]');
      if (owner) owner.setAttribute('aria-expanded', 'false');
    });
  }

  // Draw the graph exactly as shown (legend, colors, any pinned chain) into a PNG.
  var STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity',
    'opacity', 'font-family', 'font-size', 'font-weight', 'marker-end', 'visibility'];
  function graphPng(block) {
    return new Promise(function (resolve, reject) {
      var svg = block.querySelector('.depgraph svg');
      var box = svg.viewBox.baseVal;
      var clone = svg.cloneNode(true);
      var from = svg.querySelectorAll('*'), to = clone.querySelectorAll('*');
      for (var i = 0; i < from.length; i++) {
        var cs = getComputedStyle(from[i]);
        to[i].setAttribute('style', STYLE_PROPS.map(function (p) { return p + ':' + cs.getPropertyValue(p); }).join(';'));
      }
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', box.width);
      clone.setAttribute('height', box.height);
      clone.removeAttribute('style');
      var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('width', box.width);
      bg.setAttribute('height', box.height);
      bg.setAttribute('fill', getComputedStyle(block.querySelector('.depgraph')).backgroundColor);
      clone.insertBefore(bg, clone.firstChild);
      // 2x for sharp text, capped so very large graphs stay within canvas limits.
      var scale = Math.min(2, 8000 / Math.max(box.width, box.height));
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(box.width * scale);
        canvas.height = Math.round(box.height * scale);
        var ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, box.width, box.height);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error('The browser could not encode the image.'));
        }, 'image/png');
      };
      img.onerror = function () { reject(new Error('The browser could not draw the graph.')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    });
  }

  function initSave(block) {
    if (block.__dgs) return;
    var btn = block.querySelector('.dg-save');
    var menu = block.querySelector('.dg-save-menu');
    if (!btn || !menu) return;
    block.__dgs = true;
    var status = block.querySelector('.dg-status');
    var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
    function setMenu(open) {
      if (open) closeOtherMenus(block, menu);
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open && items[0]) items[0].focus();
    }
    function flash(text) {
      if (!status) return;
      if (!status.hasAttribute('data-dg-text')) status.setAttribute('data-dg-text', status.textContent);
      status.textContent = text;
      clearTimeout(block.__dgFlash);
      block.__dgFlash = setTimeout(function () {
        status.textContent = status.getAttribute('data-dg-text');
        status.removeAttribute('data-dg-text');
      }, 3000);
    }
    function fail(title) {
      return function (e) { showDialog(block, title, '<p>' + escText(e && e.message ? e.message : e) + '</p>'); };
    }
    btn.addEventListener('click', function (ev) { ev.stopPropagation(); setMenu(menu.hidden); });
    menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
    document.addEventListener('click', function () { if (!menu.hidden) setMenu(false); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !menu.hidden) { setMenu(false); btn.focus(); }
    });
    menu.addEventListener('keydown', function (ev) {
      var at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
    });
    menu.querySelector('[data-action="save"]').addEventListener('click', function () {
      setMenu(false);
      graphPng(block).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (block.getAttribute('data-dg-name') || 'dependency-graph') + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        flash('Image saved as ' + a.download);
      }).catch(fail('Could not save the image'));
    });
    menu.querySelector('[data-action="copy"]').addEventListener('click', function () {
      setMenu(false);
      if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) {
        fail('Could not copy the image')(new Error('This browser does not allow pages to copy images. Use Save Image instead.'));
        return;
      }
      // The PNG is passed as a promise so the write starts inside the click (Safari requires that).
      navigator.clipboard.write([new ClipboardItem({ 'image/png': graphPng(block) })])
        .then(function () { flash('Image copied to the clipboard'); })
        .catch(fail('Could not copy the image'));
    });
  }

  // The graph's own config, embedded by the renderer; null on blocks from before configs were embedded.
  function readConfig(block) {
    var tpl = block.querySelector('template.dg-config');
    if (!tpl || !tpl.content) return null;
    try {
      var cfg = JSON.parse(tpl.content.textContent);
      return cfg && cfg.refresh && cfg.refresh.graph_id ? cfg : null;
    } catch (e) { return null; }
  }

  // A file:// page sends its own path; the helper rewrites that file and the page reloads from it.
  function filePath() {
    if (location.protocol !== 'file:' || location.host) return null;
    var path = decodeURIComponent(location.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  }

  var PENDING = 'dg-refresh:';
  function storage() { try { return window.sessionStorage; } catch (e) { return null; } }

  // After a refresh reloads the page, pick up the zoom and the change report the helper wrote into the file.
  function takePending(block) {
    if (block.__dgPendingChecked) return;
    block.__dgPendingChecked = true;
    var cfg = readConfig(block), store = storage();
    if (!cfg || !store) return;
    var key = PENDING + cfg.refresh.graph_id, raw = null, pending = null;
    try { raw = store.getItem(key); store.removeItem(key); } catch (e) { return; }
    try { pending = JSON.parse(raw); } catch (e) { return; }
    var last = cfg.last_refresh || {};
    if (!pending || !last.id || pending.id !== last.id) return;
    if (pending.zoom) block.setAttribute('data-dg-zoom', pending.zoom);
    block.__dgPending = { report: pending.report, summary: last.summary || '', changes: last.changes || [] };
  }

  function report(block, summary, changes, reportChanges, note) {
    if (!reportChanges) {
      var s2 = block.querySelector('.dg-status');
      if (s2) s2.textContent = summary.replace(/ \d+ change\(s\)\.| No changes\./, '') + (note ? ' ' + note : '');
      return;
    }
    var body = '<p>' + escText(summary) + '</p>';
    if (changes.length) {
      body += '<ul>' + changes.map(function (c) { return '<li>' + escText(c) + '</li>'; }).join('') + '</ul>';
    }
    if (note) body += '<p>' + escText(note) + '</p>';
    showDialog(block, changes.length ? 'Changed since the last refresh' : 'No changes since the last refresh', body);
  }

  function initRefresh(block) {
    if (block.__dgr) return;
    block.__dgr = true;
    var btn = block.querySelector('.dg-reload');
    var gear = block.querySelector('.dg-gear');
    var menu = gear ? document.getElementById(gear.getAttribute('aria-controls')) : null;
    var outside = block.querySelector('.dg-opt-outside');
    var status = block.querySelector('.dg-status');
    if (block.__dgPending) {
      var done = block.__dgPending;
      block.__dgPending = null;
      report(block, done.summary, done.changes, done.report, '');
    }
    if (!btn) return;
    var cfg = readConfig(block);
    var port = cfg && Number(cfg.refresh.port) || 8765;
    var startCmd = block.getAttribute('data-start-cmd') || 'prd-graph-helper';

    function setMenu(open) {
      if (!menu) return;
      if (open) closeOtherMenus(block, menu);
      menu.hidden = !open;
      gear.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function request(depth) {
      if (!cfg) {
        // A block rendered before configs were embedded still refreshes through its token URL.
        return fetch(block.getAttribute('data-refresh-url') + (depth ? '&outside=' + depth : ''), { method: 'POST' });
      }
      var body = { graph: cfg.refresh.graph_id, scope: cfg.refresh.scope };
      if (depth) body.outside = depth;
      var path = filePath();
      if (path) body.path = path; else body.config = cfg;
      return fetch('http://127.0.0.1:' + port + '/v2/refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    }

    // A helper from before portable pages refuses this page's request at the CORS check, which looks
    // the same as no helper; its /health still answers, so tell the two apart.
    function unreachable() {
      return fetch('http://127.0.0.1:' + port + '/health')
        .then(function (r) { return r.json(); })
        .then(function (h) {
          if (h && h.protocol >= 2) throw new Error('The refresh helper did not accept the request.');
          showDialog(block, 'The refresh helper is out of date',
            '<p>Restart it in a terminal, then try again:</p><code>' + escText(startCmd + ' --ensure') + '</code>');
        }, function () {
          showDialog(block, 'The refresh helper is not running',
            '<p>Start it in a terminal, then try again:</p><code>' + escText(startCmd) + '</code>' +
            '<p>The command is installed the first time the prd-dependency-graph skill runs on this machine.</p>');
        });
    }

    function run(depth, reportChanges) {
      var before = status ? status.textContent : '';
      btn.disabled = true;
      if (gear) gear.disabled = true;
      if (outside) outside.disabled = true;
      if (status) status.textContent = 'Refreshing from ClosedLoop...';
      request(depth)
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok || !res.j.ok) throw new Error(res.j.error || 'refresh failed');
          if (res.j.written) {
            // The helper rewrote this file and sends no ticket data back; reload to show it.
            var store = storage();
            try {
              if (store) store.setItem(PENDING + cfg.refresh.graph_id, JSON.stringify({
                id: res.j.refresh_id, report: reportChanges, zoom: block.__dgZoom ? block.__dgZoom.zoom : null,
              }));
            } catch (e) { /* the page still reloads, just without the change report */ }
            location.reload();
            return;
          }
          var tmp = document.createElement('div');
          tmp.innerHTML = res.j.html;
          var fresh = tmp.querySelector('.depgraph-block');
          if (block.__dgZoom) fresh.setAttribute('data-dg-zoom', block.__dgZoom.zoom);
          block.replaceWith(fresh);
          // Scripts inserted through innerHTML never run; re-create them so a
          // newer renderer's script takes over from the one this page loaded.
          fresh.querySelectorAll('script').forEach(function (old) {
            var run2 = document.createElement('script');
            run2.textContent = old.textContent;
            old.replaceWith(run2);
          });
          window.__depgraph.initAll();
          var note = cfg ? 'Only this view was updated: the page was not opened from a file, so no file on disk changed.' : '';
          report(fresh, res.j.summary, res.j.changes || [], reportChanges, note);
        })
        .catch(function (e) {
          btn.disabled = false;
          if (gear) gear.disabled = false;
          if (outside) { outside.disabled = false; if (!reportChanges) outside.checked = !outside.checked; }
          if (status) status.textContent = before;
          if (e instanceof TypeError) {
            unreachable().catch(function (e2) { showDialog(block, 'Refresh failed', '<p>' + escText(e2.message) + '</p>'); });
          } else {
            showDialog(block, 'Refresh failed', '<p>' + escText(e.message) + '</p>');
          }
        });
    }

    btn.addEventListener('click', function () { setMenu(false); run('', true); });
    if (gear && menu) {
      gear.addEventListener('click', function (ev) { ev.stopPropagation(); setMenu(menu.hidden); });
      menu.addEventListener('click', function (ev) { ev.stopPropagation(); });
      document.addEventListener('click', function () { setMenu(false); });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && !menu.hidden) { setMenu(false); gear.focus(); }
      });
    }
    if (outside) {
      outside.addEventListener('change', function () { run(outside.checked ? 'all' : '1', false); });
    }
  }

  function initAll() {
    states = states.filter(function (s) { return document.contains(s.svg); });
    document.querySelectorAll('.depgraph svg').forEach(initGraph);
    document.querySelectorAll('.depgraph-block').forEach(takePending);
    document.querySelectorAll('.depgraph-block').forEach(initZoom);
    document.querySelectorAll('.depgraph-block').forEach(initRefresh);
    document.querySelectorAll('.depgraph-block').forEach(initSave);
  }

  document.addEventListener('keydown', function (ev) {
    states.forEach(function (st) {
      if (ev.key === 'Escape') { st.pinned = null; st.render(); }
      else if (ev.key === 'Shift' && !st.shiftDown) { st.shiftDown = true; st.render(); }
    });
  });
  document.addEventListener('keyup', function (ev) {
    if (ev.key === 'Shift') states.forEach(function (st) { st.shiftDown = false; st.render(); });
  });
  window.__depgraph = { initAll: initAll, version: VERSION };
  initAll();
})();
"""


VERSION = hashlib.sha1((CSS + JS_SRC).encode()).hexdigest()[:10]
JS = JS_SRC.replace("__DG_VERSION__", VERSION)


def build_svg(data):
    all_nodes = data["nodes"]
    blocks = [tuple(e) for e in data["edges"]]
    produces = [tuple(e) for e in data.get("produces") or [] if tuple(e) not in set(blocks)]
    produces_set = set(produces)
    edges = blocks + produces
    me = data.get("me")
    linked_ids = {x for e in edges for x in e}
    nodes = [n for n in all_nodes if n["id"] in linked_ids]
    isolated = [n for n in all_nodes if n["id"] not in linked_ids]
    col = assign_columns(nodes, edges)
    columns, ncols, pos, col_bottom = layout(nodes, edges, col)
    paths = route(edges, col, columns, pos)
    if len(paths) != len(edges):
        sys.exit(f"error: drew {len(paths)} of {len(edges)} edges")

    width = LEFT * 2 + ncols * BOX_W + max(0, ncols - 1) * COL_GAP
    height = max(col_bottom.values(), default=TOP) + 2 * ROW_GAP + 20
    grid_title_y = None
    if isolated:
        per_row = max(ncols, min(6, len(isolated)), 1)
        top = height + 30 if nodes else TOP
        grid_title_y = top - 14
        for i, n in enumerate(isolated):
            r, c = divmod(i, per_row)
            pos[n["id"]] = (LEFT + c * (BOX_W + GRID_GAP), top + r * (MIN_BOX_H + ROW_GAP), MIN_BOX_H)
        rows = (len(isolated) + per_row - 1) // per_row
        width = max(width, LEFT * 2 + per_row * BOX_W + (per_row - 1) * GRID_GAP)
        height = top + rows * (MIN_BOX_H + ROW_GAP) + 20
    nodes = all_nodes
    by_id = {n["id"]: n for n in nodes}
    labels = data.get("column_labels") or []
    # A BLOCKS link is still in force while its blocker is unfinished.
    open_edges = {(s, d) for s, d in blocks if status_key(by_id[s]) not in STATUS_DONE}
    n_tickets = sum(1 for n in nodes if not n.get("root"))

    out = [f'<svg viewBox="0 0 {width} {height}" style="min-width:{int(width * MIN_SCALE)}px" role="img" '
           f'aria-label="{esc(data.get("title", "Dependency graph"))}: {n_tickets} tickets, {len(blocks)} BLOCKS links">']
    out.append('<defs>'
               '<marker id="dg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk" d="M0,0 L10,5 L0,10 z"/></marker>'
               '<marker id="dg-arr-up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="mk-up" d="M0,0 L10,5 L0,10 z"/></marker>'
               '<marker id="dg-arr-down" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="mk-down" d="M0,0 L10,5 L0,10 z"/></marker>'
               '<marker id="dg-arr-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="mk-open" d="M0,0 L10,5 L0,10 z"/></marker>'
               '</defs>')

    legend = [("boxme", f"yours ({me})" if me else "yours"),
              ("boxme boxmebl", "yours, BLOCKED"), ("boxbl", "BLOCKED"),
              ("boxtr", "TRIAGE / BACKLOG"), ("boxok", "DONE"), ("box", "other open status")]
    if any(n.get("external") for n in nodes):
        legend.append(("box boxext", f"outside {data.get('scope') or 'this PRD'}"))
    x = LEFT
    out.append(f'<text x="{x}" y="30" class="small">Legend:</text>')
    x += 60
    for cls, text in legend:
        out.append(f'<rect class="{cls}" x="{x}" y="18" width="22" height="16" rx="4"/>'
                   f'<text x="{x + 30}" y="30" class="small">{esc(text)}</text>')
        x += 40 + 7 * len(text)
    # Arrow entries go on a second legend row, so they never sit under the zoom controls at the top right.
    px = LEFT + 60
    arrow_text = f"Arrow: A blocks B. {len(blocks)} BLOCKS links, all drawn."
    out.append(f'<text x="{px}" y="54" class="small">{esc(arrow_text)}</text>')
    px += 20 + 7 * len(arrow_text)
    if open_edges:
        open_text = f"Red arrow: the blocker is still open ({len(open_edges)} of {len(blocks)})"
        out.append(f'<line class="legend-open" x1="{px}" y1="50" x2="{px + 26}" y2="50"/>'
                   f'<text x="{px + 34}" y="54" class="small">{esc(open_text)}</text>')
        px += 60 + 7 * len(open_text)
    if produces:
        root_ids = sorted({s for s, _ in produces})
        produces_text = f"{', '.join(root_ids)} produces the ticket (PRODUCES link)"
        out.append(f'<line class="legend-produces" x1="{px}" y1="50" x2="{px + 26}" y2="50"/>'
                   f'<text x="{px + 34}" y="54" class="small">{esc(produces_text)}</text>')
        px += 60 + 7 * len(produces_text)
    x = max(x, px)
    # The legend can be wider than a small graph; widen the canvas so none of it is clipped.
    if x + LEFT > width:
        width = x + LEFT
        out[0] = (f'<svg viewBox="0 0 {width} {height}" style="min-width:{int(width * MIN_SCALE)}px" role="img" '
                  f'aria-label="{esc(data.get("title", "Dependency graph"))}: {n_tickets} tickets, {len(blocks)} BLOCKS links">')

    if grid_title_y is not None:
        out.append(f'<text x="{LEFT}" y="{grid_title_y}" class="grid-title">'
                   f'No BLOCKS links ({len(isolated)} ticket{"" if len(isolated) == 1 else "s"})</text>')
    for c in range(ncols):
        label = labels[c] if c < len(labels) else f"{c + 1}."
        out.append(f'<text x="{LEFT + c * (BOX_W + COL_GAP)}" y="{TOP - 20}" class="small">{esc(label)}</text>')

    out.append('<g class="edges">')
    for s, d, dpath in paths:
        if (s, d) in produces_set:
            cls = "edge produces"
        elif (s, d) in open_edges:
            cls = "edge open"
        else:
            cls = "edge"
        out.append(f'<path class="{cls}" data-from="{esc(s)}" data-to="{esc(d)}" d="{dpath}"/>')
    out.append('</g>')

    for nid, (bx, by, bh) in pos.items():
        node = by_id[nid]
        cls = box_class(node, me)
        owner = node.get("owner") or "unassigned"
        owner_shown = "YOU" if "boxme" in cls.split() and owner == me else owner
        status = str(node.get("status", "")).upper().replace("_", " ")
        label = f'{nid} {node.get("label", "")}'.strip()
        title = node.get("title") or label
        url = node.get("url", "")
        aria = f"{label}, {owner}, {status}"
        ty = by + bh / 2 - 3
        out.append(f'<g class="node" data-id="{esc(nid)}" data-url="{esc(url)}" tabindex="0" role="button" aria-label="{esc(aria)}">'
                   f'<title>{esc(title)}</title>'
                   f'<rect class="{cls}" x="{bx}" y="{by}" width="{BOX_W}" height="{bh}" rx="8"/>'
                   f'<text x="{bx + 10}" y="{ty}" class="lbl">{esc(trunc(label, 30))}</text>'
                   f'<text x="{bx + 10}" y="{ty + 17}" class="small">{esc(owner_shown)} · {esc(status)}</text>'
                   '</g>')
    out.append('</svg>')
    return "\n".join(out), n_tickets, len(blocks)


HELP = ('<p class="depgraph-help">Hover a ticket: upstream (blocks it) in <span class="k-up">purple</span>, '
        'downstream (it blocks) in <span class="k-down">teal</span>. Click to pin and show the whole chain; '
        'Esc or clicking empty space clears. Shift while hovering also shows the whole chain. Tab moves between '
        'tickets and Enter pins. Double-click opens the ticket. Zoom with the + and − buttons, '
        'pinch, or Ctrl/Cmd + scroll. The graph opens zoomed to fit; click the percentage to fit it again. '
        'With the graph focused, use +/− to zoom and 0 to fit.</p>')


ZOOM_CONTROLS = ('<div class="dg-zoom" role="group" aria-label="Graph zoom">'
                 '<button class="dg-refresh dg-zoom-out" type="button" aria-label="Zoom out" title="Zoom out">−</button>'
                 '<button class="dg-refresh dg-zoom-reset" type="button" aria-label="Reset zoom" title="Reset zoom">100%</button>'
                 '<button class="dg-refresh dg-zoom-in" type="button" aria-label="Zoom in" title="Zoom in">+</button>'
                 '</div>')


DEFAULT_PORT = 8765
LAUNCHER = Path.home() / ".local" / "bin" / "prd-graph-helper"


def start_cmd():
    """The command the "helper not running" dialog shows, chosen so it works as pasted.

    The launcher has a stable path across plugin updates and every run of the skill writes
    it, so the page names it rather than an installed script. It is written relative to
    the home directory, because the page may be opened on someone else's machine.
    """
    on_path = str(LAUNCHER.parent) in os.environ.get("PATH", "").split(os.pathsep)
    if on_path or not LAUNCHER.is_relative_to(Path.home()):
        return LAUNCHER.name
    return f"~/{LAUNCHER.relative_to(Path.home()).as_posix()}"


def embed_markers(graph_id):
    return (f"<!-- depgraph:{graph_id}:start -->", f"<!-- depgraph:{graph_id}:end -->")


SAVE_ICON = ('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
             'stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
             '<path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>')


def save_controls(menu_key):
    menu_id = f"dg-save-menu-{esc(menu_key)}"
    return ('<div class="dg-menu-wrap">'
            f'<button class="dg-refresh dg-save" type="button" aria-label="Save or copy the graph as an image" '
            f'title="Save or copy image" aria-haspopup="menu" aria-expanded="false" aria-controls="{menu_id}">{SAVE_ICON}</button>'
            f'<div class="dg-menu dg-save-menu" id="{menu_id}" role="menu" hidden>'
            '<button class="dg-menu-item" type="button" role="menuitem" data-action="save">Save Image</button>'
            '<button class="dg-menu-item" type="button" role="menuitem" data-action="copy">Copy Image</button>'
            '</div></div>')


def file_stem(title):
    return re.sub(r"[^a-z0-9]+", "-", str(title).lower()).strip("-") or "dependency-graph"


def render_block(data):
    """The graph plus its toolbar, wrapped in one element the refresh swaps in place."""
    svg, n_nodes, n_edges = build_svg(data)
    stamp = data.get("generated_at") or datetime.now().strftime("%Y-%m-%d %H:%M")
    status = f"Data as of {esc(stamp)}. {n_nodes} tickets, {n_edges} BLOCKS links."
    refresh = data.get("refresh") or {}
    attrs = ""
    config = ""
    if refreshable(refresh):
        # The page carries its own config, so any machine with the skill can refresh it.
        attrs = f' data-start-cmd="{esc(start_cmd())}"'
        config = config_html(data)
        full_chain = str(refresh.get("outside_blockers_depth", 1)) == "all"
        menu_id = f"dg-menu-{esc(refresh['graph_id'])}"
        button = ('<div class="dg-menu-wrap">'
                  f'<button class="dg-refresh dg-gear" type="button" aria-label="Graph options" title="Graph options" aria-haspopup="true" aria-expanded="false" aria-controls="{menu_id}">'
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>'
                  f'<div class="dg-menu" id="{menu_id}" hidden>'
                  f'<label><input type="checkbox" class="dg-opt-outside"{" checked" if full_chain else ""}>'
                  '<span>Show the full chain of outside blockers'
                  '<span class="dg-hint">Off shows blockers one layer outside this scope.</span></span></label>'
                  '</div></div>'
                  '<button class="dg-refresh dg-reload" type="button" aria-label="Refresh from ClosedLoop" title="Refresh from ClosedLoop">'
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
                  '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>')
        dialog = ('<dialog class="dg-dialog" aria-labelledby="dg-dialog-title-' + esc(refresh['graph_id']) + '">'
                  '<h3 id="dg-dialog-title-' + esc(refresh['graph_id']) + '"></h3><div class="dg-dialog-body"></div>'
                  '<form method="dialog"><button type="submit">Close</button></form></dialog>')
    else:
        button = dialog = ""
    stem = file_stem(data.get("title") or refresh.get("graph_id") or "dependency-graph")
    attrs += f' data-dg-name="{esc(stem)}"'
    button = '<div class="dg-controls">' + ZOOM_CONTROLS + save_controls(refresh.get("graph_id") or stem) + button + '</div>'
    toolbar = f'<div class="dg-toolbar"><span class="dg-status">{status}</span></div>'
    block = (f'<div class="depgraph-block"{attrs}>{config}<style>{CSS}</style>{toolbar}'
             f'<div class="dg-frame"><div class="depgraph">{svg}</div>{button}</div>'
             f'{HELP}{dialog}<script>{JS}</script></div>')
    return block, n_nodes, n_edges


def render_fragment(data):
    block, n_nodes, n_edges = render_block(data)
    return f"{block}\n", n_nodes, n_edges


def render_page(data):
    block, n_nodes, n_edges = render_block(data)
    graph_id = (data.get("refresh") or {}).get("graph_id")
    if refreshable(data.get("refresh") or {}):
        # Markers let a refresh replace only the graph, the same way as in a report.
        start, end = embed_markers(graph_id)
        block = f"{start}\n{block}\n{end}"
    title = esc(data.get("title", "Dependency graph"))
    subtitle = esc(data.get("subtitle", ""))
    doc = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
           "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
           f"<title>{title}</title><style>"
           "body{margin:0;background:#fbfaf8;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}"
           "@media (prefers-color-scheme: dark){body{background:#16171a;color:#e8e8ea}}"
           ".wrap{max-width:1600px;margin:0 auto;padding:28px 20px 60px}"
           "h1{font-size:24px;margin:0 0 4px}.sub{color:#8a8f98;font-size:13.5px;margin:0 0 16px}"
           "</style></head><body><div class=\"wrap\">"
           f"<h1>{title}</h1><p class=\"sub\">{subtitle}</p>"
           f"{block}</div></body></html>\n")
    return doc, n_nodes, n_edges


def embed_into(path, graph_id, fragment):
    """Replace the fragment between this graph's markers in an existing HTML file."""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    text = replace_region(text, graph_id, fragment, path)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="graph JSON file, or an HTML page or report holding a refreshable graph")
    parser.add_argument("--graph", help="with an HTML input holding several graphs: the graph id to read")
    parser.add_argument("-o", "--output", help="output .html path")
    parser.add_argument("--print-columns", action="store_true",
                        help="print the automatic column assignment as JSON and exit (use it to write column_labels)")
    parser.add_argument("--fragment", action="store_true",
                        help="emit an embeddable <style>+<div>+<script> fragment instead of a full page")
    parser.add_argument("--embed-into",
                        help="replace the graph between <!-- depgraph:<id>:start/end --> markers in this HTML file")
    args = parser.parse_args()

    data = load(args.input, args.graph)
    if args.print_columns:
        all_edges = data["edges"] + [e for e in data["produces"] if e not in data["edges"]]
        linked_ids = {x for e in all_edges for x in e}
        linked = [n for n in data["nodes"] if n["id"] in linked_ids]
        col = assign_columns(linked, all_edges)
        columns, _ = order_rows(linked, all_edges, col)
        labels = {n["id"]: n.get("label", "") for n in data["nodes"]}
        out = {str(c + 1): [f"{i} {labels[i]}" for i in columns[c]] for c in sorted(columns)}
        out["no BLOCKS links (grid, not a column)"] = [n["id"] for n in data["nodes"] if n["id"] not in linked_ids]
        print(json.dumps(out, indent=1))
        return
    if args.embed_into:
        graph_id = (data.get("refresh") or {}).get("graph_id") or data.get("graph_id")
        if not graph_id:
            parser.error("--embed-into needs refresh.graph_id in the JSON")
        fragment, n_nodes, n_edges = render_fragment(data)
        embed_into(args.embed_into, graph_id, fragment)
        print(json.dumps({"embedded_into": args.embed_into, "nodes": n_nodes, "edges": n_edges}))
        return
    if not args.output:
        parser.error("-o/--output is required unless --print-columns or --embed-into is given")
    doc, n_nodes, n_edges = (render_fragment if args.fragment else render_page)(data)
    with open(args.output, "w", encoding="utf-8") as handle:
        handle.write(doc)
    print(json.dumps({"output": args.output, "nodes": n_nodes, "edges": n_edges}))



HTML_SUFFIXES = {".html", ".htm"}
GRAPH_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MARKER_START = re.compile(r"<!-- depgraph:([a-z0-9][a-z0-9-]{0,63}):start -->")
CONFIG_TAG = re.compile(r'<template class="dg-config" data-dg-graph="([a-z0-9][a-z0-9-]{0,63})">([^<]*)</template>')
LEGACY_URL = re.compile(r'data-refresh-url="http://127\.0\.0\.1:\d+/refresh\?graph=([a-z0-9][a-z0-9-]{0,63})&amp;')
CONFIG_VERSION = 2
PORTABLE_NODE_KEYS = ("id", "label", "title", "owner", "status", "url", "external", "root", "column")
PORTABLE_REFRESH_KEYS = ("graph_id", "scope", "port", "app_issue_base", "include_plans", "outside_blockers_depth")


def refreshable(refresh):
    return bool(GRAPH_ID.match(str(refresh.get("graph_id") or "")) and (refresh.get("scope") or refresh.get("prd")))


def edge_dicts(edges):
    return [{"from": e["from"], "to": e["to"]} if isinstance(e, dict) else {"from": e[0], "to": e[1]}
            for e in edges or []]


def portable_config(data):
    """Everything a refresh needs, minus what belongs to one machine or person.

    No token, no output paths, no API base and no `me`: whoever refreshes the page
    supplies their own key, and the helper looks up who they are.
    """
    refresh = data.get("refresh") or {}
    source = dict(refresh, scope=refresh.get("scope") or refresh.get("prd"))
    config = {
        "version": CONFIG_VERSION,
        "title": data.get("title") or "",
        "subtitle": data.get("subtitle") or "",
        "generated_at": data.get("generated_at") or "",
        "column_labels": list(data.get("column_labels") or []),
        "nodes": [{k: n[k] for k in PORTABLE_NODE_KEYS if kept(n.get(k))} for n in data.get("nodes") or []],
        "edges": edge_dicts(data.get("edges")),
        "produces": edge_dicts(data.get("produces")),
        "refresh": {k: source[k] for k in PORTABLE_REFRESH_KEYS if kept(source.get(k))},
    }
    if data.get("last_refresh"):
        config["last_refresh"] = data["last_refresh"]
    return config


def kept(value):
    return value is not None and value != "" and value is not False


def config_html(data):
    # HTML-escaped JSON in a <template>: inert, never executed, and the JSON comes back unchanged
    # from template.content.textContent in the page or html.unescape in the helper.
    text = json.dumps(portable_config(data), ensure_ascii=False, separators=(",", ":"))
    graph_id = esc(data["refresh"]["graph_id"])
    return f'<template class="dg-config" data-dg-graph="{graph_id}">{html.escape(text, quote=False)}</template>'


def graph_region(text, graph_id):
    """(start, end) of the text between this graph's markers, or None."""
    start, end = embed_markers(graph_id)
    a = text.find(start)
    b = text.find(end, a + len(start)) if a >= 0 else -1
    return (a + len(start), b) if a >= 0 and b >= 0 else None


def replace_region(text, graph_id, fragment, where="the file"):
    region = graph_region(text, graph_id)
    if region is None:
        raise ValueError(f"markers for graph '{graph_id}' not found in {where}")
    return text[: region[0]] + "\n" + fragment + text[region[1]:]


def embedded_graph_ids(text):
    """Graph ids that have markers and an embedded config inside them, in page order."""
    ids = []
    for match in MARKER_START.finditer(text):
        graph_id = match.group(1)
        if graph_id not in ids and read_embedded(text, graph_id) is not None:
            ids.append(graph_id)
    return ids


def legacy_graph_ids(text):
    """Graph ids of blocks rendered before configs were embedded (they carry a token URL instead)."""
    return list(dict.fromkeys(LEGACY_URL.findall(text)))


def read_embedded(text, graph_id):
    """The config embedded between this graph's markers, or None."""
    region = graph_region(text, graph_id)
    if region is None:
        return None
    for match in CONFIG_TAG.finditer(text, region[0], region[1]):
        if match.group(1) == graph_id:
            try:
                data = json.loads(html.unescape(match.group(2)))
            except ValueError:
                return None
            return data if isinstance(data, dict) else None
    return None


if __name__ == "__main__":
    main()
