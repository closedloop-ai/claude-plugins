#!/usr/bin/env python3
"""Local refresh helper for prd-dependency-graph pages.

Creating or refreshing a graph from the command line (`--new`, `--once`) starts
it in the background when it is not already running, and replaces a helper left
running from another install of this skill. To start it by hand:

    prd-graph-helper

That launcher, in ~/.local/bin, resolves the newest installed copy of this
script each time it runs, so it keeps working when a versioned plugin cache is
replaced. `--ensure` starts the helper in the background and exits; its log is
~/.local/share/prd-dependency-graph/helper.log.

Pages are portable. Each graph block carries its own config (scope, options,
labels, columns, nodes and edges) and nothing that belongs to one machine or
person: no token, no output paths, no API base and no `me`. A page opened from
a file POSTs its own path to /v2/refresh; the helper checks that the file holds
that graph and scope, re-reads the tickets with this machine's API key, rewrites
only that graph in the file, and answers without ticket data so the page reloads
from disk. Pages served from this machine (http://localhost) get the new graph
in the response instead and say that no file changed. The threat model is in
../SKILL.md.

Graphs made before pages carried their config keep working: their configs in
~/.local/share/prd-dependency-graph/<graph-id>.json are still read (through the
token URL old pages carry, through `--once <graph-id>`, and for any file such a
config lists), and every refresh writes the portable format into their pages.

The API key is read from CLOSEDLOOP_API_KEY (falling back to a login shell,
which loads ~/.zprofile); it is never written to any file and is only sent to
the ClosedLoop API.

Also usable without the server: `--once <page.html>` refreshes a page or report
in place, `--once <graph-id>` refreshes an older graph from its config, and
`--new <slug> -o <page.html>` creates a graph for a PRD/document or project
(see --help).
"""

import argparse
import contextlib
import hashlib
import hmac
import importlib
import json
import os
import re
import secrets
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_graph  # noqa: E402

DATA_DIR = Path.home() / ".local" / "share" / "prd-dependency-graph"
DEFAULT_API = "https://api.closedloop.ai"
APP_ORIGIN = "https://app.closedloop.ai"
APP_ISSUE_BASE = f"{APP_ORIGIN}/closedloop-ai/issues"
ISSUE_SUBTYPES = {"FEATURE", "ISSUE"}
PREFIX = re.compile(r"^\s*\[[^\]]*\]\s*")
SCOPE = re.compile(r"^[A-Z][A-Z0-9]{1,9}-\d{1,9}$")
SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
SCRIPT = Path(__file__).resolve()
LAUNCHER_MARK = "# prd-dependency-graph launcher"
PROTOCOL = 2
REFRESH_PATH = "/v2/refresh"
COOLDOWN_SECONDS = 3.0
MAX_CONCURRENT_REFRESHES = 2
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
ME_TTL_SECONDS = 600
LOG_HINT = "~/.local/share/prd-dependency-graph/helper.log"
_RENDERER_SOURCE_WARNING_WRITTEN = False


def api_key():
    key = os.environ.get("CLOSEDLOOP_API_KEY", "").strip()
    if key:
        return key
    try:
        out = subprocess.run(["zsh", "-lc", 'printf %s "$CLOSEDLOOP_API_KEY"'],
                             capture_output=True, text=True, timeout=15)
        key = out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        key = ""
    if not key:
        raise RuntimeError("CLOSEDLOOP_API_KEY is not set (checked the environment and a login shell)")
    return key


class Api:
    def __init__(self, base, key):
        self.base = base.rstrip("/")
        self.key = key

    def get(self, path, params):
        url = f"{self.base}{path}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.key}",
                                                   "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.load(resp)
        if isinstance(body, dict) and body.get("success") is False:
            raise RuntimeError(f"{path}: {body.get('error') or body}")
        return body.get("data", body) if isinstance(body, dict) else body

    def links(self, artifact, link_type, direction):
        items, cursor, snapshot = [], None, None
        while True:
            params = {"artifactId": artifact, "linkType": link_type, "direction": direction,
                      "paginated": "true"}
            if cursor:
                params["cursor"] = cursor
            if snapshot:
                params["snapshotId"] = snapshot
            page = self.get("/artifact-links/resolved", params)
            if isinstance(page, list):
                return items + page
            items.extend(page.get("items") or [])
            nxt = page.get("nextCursor")
            if not nxt or nxt == cursor:
                return items
            cursor, snapshot = nxt, page.get("snapshotId")


def short_label(name):
    text = PREFIX.sub("", name or "").strip()
    if len(text) <= 28:
        return text
    cut = text[:28].rsplit(" ", 1)[0]
    return cut or text[:28]


def endpoint_node(end, app_base):
    assignee = end.get("assignee") or {}
    slug = end.get("slug") or end.get("id")
    name = end.get("name") or end.get("title") or slug
    return {
        "id": slug,
        "title": name,
        "label": short_label(name),
        "owner": assignee.get("firstName") or "unassigned",
        "status": end.get("status") or "",
        "url": app_url(app_base, slug, end.get("subtype") or end.get("type")),
    }


def app_url(app_base, slug, doc_type):
    """Issue links use app_base; PRDs and plans live under their own path beside it."""
    if not app_base:
        return ""
    path = DOC_PATHS.get(str(doc_type or "").upper())
    if path:
        return f"{app_base.rstrip('/').rsplit('/', 1)[0]}/{path}/{slug}"
    return f"{app_base.rstrip('/')}/{slug}"


def wanted(kind, include_plans):
    kind = (kind or "").upper()
    return kind in ISSUE_SUBTYPES or (include_plans and kind == "IMPLEMENTATION_PLAN")


def scope_slug(source):
    return source.get("scope") or source.get("prd")


DOC_PATHS = {"PRD": "prds", "IMPLEMENTATION_PLAN": "implementation-plans"}


def scope_root(api, source, app_base, tickets):
    """The scope document itself, drawn as the root its PRODUCES children hang from.

    None for a project scope, or when the scope is a ticket that graphs itself.
    """
    scope = scope_slug(source)
    if scope.upper().startswith("PRO-") or scope in tickets:
        return None
    doc = api.get(f"/documents/{scope}", {})
    node = endpoint_node(doc, app_base)
    node["root"] = True
    return node


def scope_tickets(api, source, app_base):
    """The in-scope tickets: every ticket in a project, or a document's PRODUCES children."""
    scope = scope_slug(source)
    include_plans = bool(source.get("include_plans"))
    tickets = {}
    if scope.upper().startswith("PRO-"):
        offset = 0
        while True:
            page = api.get("/documents", {"projectId": scope, "includeTotal": "true", "recencyDays": "all",
                                          "limit": 500, "offset": offset})
            for doc in page.get("items") or []:
                if wanted(doc.get("type"), include_plans):
                    node = endpoint_node(doc, app_base)
                    tickets[node["id"]] = node
            offset += len(page.get("items") or [])
            if not page.get("hasMore") or not page.get("items"):
                return tickets
    for link in api.links(scope, "PRODUCES", "target"):
        end = link.get("target") or {}
        if end.get("type") == "DOCUMENT" and wanted(end.get("subtype"), include_plans):
            node = endpoint_node(end, app_base)
            tickets[node["id"]] = node
    if not tickets:
        # A ticket (or any document with no ticket children) graphs itself and its neighbours.
        doc = api.get(f"/documents/{scope}", {})
        node = endpoint_node(doc, app_base)
        tickets[node["id"]] = node
    return tickets


def parse_depth(value):
    if value == "all":
        return "all"
    if not str(value).isdigit() or int(value) > 50:
        raise ValueError("outside blockers depth must be a number from 0 to 50, or 'all'")
    return int(value)


def outside_depth(source):
    depth = source.get("outside_blockers_depth", 1)
    return None if depth == "all" else max(0, int(depth))


def fetch_graph(cfg, api):
    """In-scope tickets, their BLOCKS links, tickets outside the scope, and the scope root.

    A document scope is drawn as a root node with a PRODUCES link to each in-scope ticket.

    Outside tickets that an in-scope ticket blocks are shown one layer deep.
    Outside blockers are followed upstream `outside_blockers_depth` layers
    (default 1; "all" follows the chain to its roots).
    """
    source = cfg["refresh"]
    app_base = source.get("app_issue_base", "")
    tickets = scope_tickets(api, source, app_base)
    limit = outside_depth(source)
    nodes = dict(tickets)
    edges = set()
    frontier = list(tickets)  # level 0 is the scope; level n is n outside blockers up
    level = 0
    fetched = set()
    with ThreadPoolExecutor(max_workers=8) as pool:
        while frontier:
            fetched.update(frontier)
            results = list(pool.map(lambda slug: (slug, api.links(slug, "BLOCKS", "both")), frontier))
            found = set()
            for queried, link_list in results:
                in_scope = queried in tickets
                for link in link_list:
                    src, dst = link.get("source") or {}, link.get("target") or {}
                    s, d = src.get("slug"), dst.get("slug")
                    if not s or not d:
                        continue
                    if not in_scope and d != queried:
                        continue  # from an outside ticket, only follow what blocks it
                    if s not in tickets and s not in nodes and limit == 0:
                        continue  # outside blockers turned off
                    for end, slug in ((src, s), (dst, d)):
                        if slug not in nodes:
                            node = endpoint_node(end, app_base)
                            node["external"] = True
                            nodes[slug] = node
                    edges.add((s, d))
                    if s not in tickets and s not in fetched:
                        found.add(s)
            level += 1
            if limit is not None and level >= limit:
                break
            frontier = sorted(found)
    produces = set()
    root = scope_root(api, source, app_base, tickets)
    if root and root["id"] not in nodes:
        nodes[root["id"]] = root
        produces = {(root["id"], t) for t in tickets}
    return nodes, edges, produces


def norm_status(status):
    return str(status or "").upper().replace(" ", "_")


def edge_set(items):
    return {(e["from"], e["to"]) if isinstance(e, dict) else tuple(e) for e in items or []}


def merge(cfg, fetched_nodes, edges, produces: set[tuple[str, str]] | None = None):
    produces = produces or set()
    old_nodes = {n["id"]: n for n in cfg.get("nodes", [])}
    old_edges = edge_set(cfg.get("edges"))
    old_produces = edge_set(cfg.get("produces"))
    changes = []
    nodes = []
    for nid, fresh in fetched_nodes.items():
        prev = old_nodes.get(nid)
        node = dict(fresh)
        if prev:
            for keep in ("label", "column", "mine"):
                if prev.get(keep) not in (None, ""):
                    node[keep] = prev[keep]
            if norm_status(prev.get("status")) != norm_status(fresh["status"]):
                changes.append(f"{nid} {node.get('label', '')}: {prev.get('status')} -> {fresh['status']}")
            if prev.get("owner") != fresh["owner"]:
                changes.append(f"{nid} {node.get('label', '')}: owner {prev.get('owner')} -> {fresh['owner']}")
        else:
            changes.append(f"{nid} added ({fresh['label']}, {fresh['owner']}, {fresh['status']})")
        nodes.append(node)
    for nid in old_nodes:
        if nid not in fetched_nodes:
            changes.append(f"{nid} removed from the graph")
    for s, d in sorted(edges - old_edges):
        changes.append(f"new link: {s} blocks {d}")
    for s, d in sorted(old_edges - edges):
        changes.append(f"link removed: {s} no longer blocks {d}")
    for s, d in sorted(produces - old_produces):
        changes.append(f"new link: {s} produces {d}")
    for s, d in sorted(old_produces - produces):
        changes.append(f"link removed: {s} no longer produces {d}")
    order = {n["id"]: i for i, n in enumerate(cfg.get("nodes", []))}
    nodes.sort(key=lambda n: (order.get(n["id"], len(order)), n["id"]))
    cfg["nodes"] = nodes
    cfg["edges"] = [{"from": s, "to": d} for s, d in sorted(edges)]
    cfg["produces"] = [{"from": s, "to": d} for s, d in sorted(produces)]
    cfg["generated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    old_all = old_edges | old_produces
    old_cols = column_count(list(old_nodes.values()), [e for e in old_all if e[0] in old_nodes and e[1] in old_nodes])
    new_cols = column_count(nodes, list(edges | produces))
    if old_nodes and old_cols != new_cols:
        changes.append(f"the graph now has {new_cols} columns (was {old_cols}); column names may need updating")
    return changes


def column_count(nodes, edges):
    linked = {x for e in edges for x in e}
    cols = render_graph.assign_columns([n for n in nodes if n["id"] in linked], edges)
    return len(set(cols.values()))


class Refused(Exception):
    """A request the helper turns down, with the HTTP status and a message that carries no ticket data."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Gate:
    """Caps what a page (or a website posing as one) can make the helper spend on the API.

    The same target cannot be refreshed again within the cooldown, and only a few
    refreshes run at once. Entries older than the cooldown are swept, so the map stays small.
    """

    def __init__(self, cooldown=COOLDOWN_SECONDS, concurrent=MAX_CONCURRENT_REFRESHES):
        self.cooldown = cooldown
        self.lock = threading.Lock()
        self.started: dict[tuple[str, str], float] = {}
        self.slots = threading.BoundedSemaphore(concurrent)

    @contextlib.contextmanager
    def enter(self, key):
        now = time.monotonic()
        with self.lock:
            self.started = {k: t for k, t in self.started.items() if now - t < self.cooldown}
            if key in self.started:
                raise Refused(429, "This graph was refreshed a moment ago. Wait a few seconds and try again.")
            if len(self.started) >= 256:
                raise Refused(429, "The refresh helper is busy. Try again shortly.")
            self.started[key] = now
        if not self.slots.acquire(blocking=False):
            raise Refused(429, "The refresh helper is busy with other refreshes. Try again shortly.")
        try:
            yield
        finally:
            self.slots.release()


GATE = Gate()
_ME_CACHE: dict[str, tuple[float, str | None]] = {}


def viewer_name(api):
    """First name of whoever owns the API key, so "yours" follows the person refreshing.

    None when the lookup fails; the refresh still goes ahead, without highlighting.
    """
    key = hashlib.sha256(api.key.encode()).hexdigest()
    hit = _ME_CACHE.get(key)
    if hit and time.monotonic() - hit[0] < ME_TTL_SECONDS:
        return hit[1]
    try:
        me = api.get("/me", {})
        name = (me.get("firstName") or None) if isinstance(me, dict) else None
    except (OSError, RuntimeError, ValueError):
        return None
    _ME_CACHE.clear()  # one key per helper in practice; never let it grow
    _ME_CACHE[key] = (time.monotonic(), name)
    return name


def for_render(cfg, me=None):
    data = dict(cfg)
    data["me"] = me
    data.setdefault("scope", scope_slug(cfg["refresh"]))
    data["edges"] = [(e["from"], e["to"]) for e in cfg["edges"]]
    data["produces"] = [(e["from"], e["to"]) for e in cfg.get("produces") or []]
    return data


def record(cfg, changes) -> dict[str, Any]:
    """Note the refresh in the config, which the page carries, so a reloaded page can report it."""
    tickets = sum(1 for n in cfg["nodes"] if not n.get("root"))
    summary = (f"Refreshed {cfg['generated_at']}: {tickets} tickets, {len(cfg['edges'])} BLOCKS links. "
               + (f"{len(changes)} change(s)." if changes else "No changes."))
    cfg["last_refresh"] = {"id": secrets.token_hex(8), "summary": summary, "changes": changes}
    return {"ok": True, "summary": summary, "changes": changes, "nodes": tickets,
            "edges": len(cfg["edges"]), "refresh_id": cfg["last_refresh"]["id"]}


def write_atomic(path, text, expected=None):
    """Replace the file in one step, keeping its mode; refuse if it changed since `expected` was read."""
    path = Path(path)
    current = os.stat(path) if path.exists() else None
    if expected is not None and (current is None or (current.st_mtime_ns, current.st_size)
                                 != (expected.st_mtime_ns, expected.st_size)):
        raise Refused(409, "The file changed while the graph was refreshing. Try again.")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(tmp, stat.S_IMODE(current.st_mode) if current else 0o644)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def write_outputs(cfg, me):
    """Rewrite every file an older graph's config lists, in the portable format."""
    data = for_render(cfg, me)
    for out in cfg["refresh"].get("outputs", []):
        path = Path(os.path.expanduser(out["path"]))
        if out.get("mode") == "embed":
            fragment, _, _ = render_graph.render_fragment(data)
            text = path.read_text(encoding="utf-8")
            write_atomic(path, render_graph.replace_region(text, cfg["refresh"]["graph_id"], fragment, str(path)))
        else:
            doc, _, _ = render_graph.render_page(data)
            write_atomic(path, doc)


def config_path(graph_id):
    if not render_graph.GRAPH_ID.match(graph_id or ""):
        raise ValueError("bad graph id")
    return DATA_DIR / f"{graph_id}.json"


def reload_renderer() -> None:
    """Reload the renderer when its install still exists, otherwise keep the loaded copy.

    Plugin managers may remove a versioned cache directory while this helper is
    still running. The module already in memory is complete, so losing its source
    must not turn every subsequent page refresh into a 500 response.
    """
    global _RENDERER_SOURCE_WARNING_WRITTEN
    source_name = getattr(render_graph, "__file__", None)
    source = Path(source_name) if isinstance(source_name, str) and source_name else None
    if source is not None and source.is_file():
        try:
            importlib.reload(render_graph)  # pick up renderer edits within the same install
            return
        except ModuleNotFoundError:
            # The cache may have disappeared between the existence check and reload.
            if source.is_file():
                raise
    if not _RENDERER_SOURCE_WARNING_WRITTEN:
        sys.stderr.write("refresh-helper: the plugin install was removed; continuing with the loaded renderer. "
                         "Run prd-graph-helper --ensure to start the newest installed helper.\n")
        _RENDERER_SOURCE_WARNING_WRITTEN = True


def refresh(graph_id, token=None, outside=None, gate=None) -> dict[str, Any]:
    """Refresh a graph that still has a config file (made before pages carried their own)."""
    path = config_path(graph_id)
    if not path.exists():
        raise FileNotFoundError(f"no graph config at {path}")
    cfg = json.loads(path.read_text(encoding="utf-8"))
    reload_renderer()
    if token is not None and not hmac.compare_digest(str(cfg["refresh"].get("token", "")), token):
        raise PermissionError("bad token")
    if outside is not None:
        cfg["refresh"]["outside_blockers_depth"] = parse_depth(outside)
    with gate.enter(("graph", graph_id)) if gate else contextlib.nullcontext():
        # This config was written on this machine, so its API base is trusted.
        api = Api(cfg["refresh"].get("api_base", DEFAULT_API), api_key())
        fetched, edges, produces = fetch_graph(cfg, api)
        result = record(cfg, merge(cfg, fetched, edges, produces))
        me = viewer_name(api) or cfg.get("me")
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    write_outputs(cfg, me)
    block, _, _ = render_graph.render_block(for_render(cfg, me))
    return dict(result, html=block)


def legacy_config_for(graph_id, real):
    """An older graph's config that lists this file as an output; it stays the source of truth."""
    path = DATA_DIR / f"{graph_id}.json"
    if not path.exists():
        return None
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
        outputs = cfg["refresh"].get("outputs") or []
    except (OSError, ValueError, KeyError, AttributeError):
        return None
    for out in outputs:
        if os.path.realpath(os.path.expanduser(str(out.get("path", "")))) == str(real):
            return path
    return None


def read_target(path):
    """Validate a file a refresh may rewrite: an existing .html file of this user, not too large."""
    if not isinstance(path, str) or not path or "\0" in path or len(path) > 4096:
        raise Refused(400, "The request does not name a file.")
    given = Path(path)
    if not given.is_absolute():
        raise Refused(400, "The file path must be absolute.")
    real = Path(os.path.realpath(given))
    if given.suffix.lower() not in render_graph.HTML_SUFFIXES or real.suffix.lower() not in render_graph.HTML_SUFFIXES:
        raise Refused(400, "Only .html files can be refreshed.")
    try:
        info = os.stat(real)
    except OSError:
        raise Refused(404, f"{given.name} was not found on this machine.") from None
    if not stat.S_ISREG(info.st_mode):
        raise Refused(400, f"{given.name} is not a regular file.")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise Refused(403, f"{given.name} belongs to another user.")
    if info.st_size > MAX_FILE_BYTES:
        raise Refused(413, f"{given.name} is too large to refresh.")
    try:
        text = real.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise Refused(400, f"{given.name} could not be read as UTF-8 HTML.") from None
    return real, text, info


def choose_graph(text, graph_id, name):
    ids = list(dict.fromkeys(render_graph.embedded_graph_ids(text) + render_graph.legacy_graph_ids(text)))
    if graph_id:
        if graph_id not in ids:
            raise Refused(404, f"{name} holds no graph '{graph_id}'.")
        return graph_id
    if len(ids) == 1:
        return ids[0]
    if not ids:
        raise Refused(404, f"{name} holds no refreshable graph.")
    raise Refused(400, f"{name} holds several graphs ({', '.join(ids)}); name one with --graph.")


def list_of(value) -> list:
    return value if isinstance(value, list) else []


def text_field(value, limit, default=""):
    return value[:limit] if isinstance(value, str) else default


def sanitize(raw, graph_id):
    """A config that came from a page or file, reduced to known fields with the right types.

    Nothing in it can choose where the API key goes: the helper always uses DEFAULT_API.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("refresh"), dict):
        raise Refused(400, "The graph config is malformed.")
    source = raw["refresh"]
    if source.get("graph_id") != graph_id:
        raise Refused(400, "The graph config names a different graph.")
    scope = str(source.get("scope") or source.get("prd") or "").upper()
    if not SCOPE.match(scope):
        raise Refused(400, "The graph config names no valid scope.")
    try:
        depth = parse_depth(source.get("outside_blockers_depth", 1))
    except ValueError as err:
        raise Refused(400, str(err)) from None
    port = source.get("port")
    app_base = source.get("app_issue_base")
    nodes = []
    for node in list_of(raw.get("nodes"))[:5000]:
        if not isinstance(node, dict) or not SLUG.match(str(node.get("id", ""))):
            continue
        column = node.get("column")
        url = node.get("url")
        nodes.append({
            "id": node["id"],
            "label": text_field(node.get("label"), 120),
            "title": text_field(node.get("title"), 500),
            "owner": text_field(node.get("owner"), 80, "unassigned"),
            "status": text_field(node.get("status"), 40),
            "url": url if isinstance(url, str) and url.startswith(APP_ORIGIN + "/") else "",
            "external": node.get("external") is True,
            "root": node.get("root") is True,
            "column": column if type(column) is int and 0 <= column <= 500 else None,
        })
    known = {n["id"] for n in nodes}

    def links(items):
        pairs = []
        for e in list_of(items)[:50000]:
            if isinstance(e, dict) and e.get("from") in known and e.get("to") in known:
                pairs.append({"from": e["from"], "to": e["to"]})
        return pairs

    labels = list_of(raw.get("column_labels"))
    return {
        "title": text_field(raw.get("title"), 300, f"{scope} dependency graph"),
        "subtitle": text_field(raw.get("subtitle"), 500),
        "generated_at": text_field(raw.get("generated_at"), 40),
        "column_labels": [text_field(x, 80) for x in labels[:100]],
        "nodes": nodes,
        "edges": links(raw.get("edges")),
        "produces": links(raw.get("produces")),
        "refresh": {
            "graph_id": graph_id,
            "scope": scope,
            "port": port if type(port) is int and 1 <= port <= 65535 else render_graph.DEFAULT_PORT,
            "app_issue_base": app_base if isinstance(app_base, str) and app_base.startswith(APP_ORIGIN + "/")
            else APP_ISSUE_BASE,
            "include_plans": source.get("include_plans") is True,
            "outside_blockers_depth": depth,
        },
    }


def refresh_embedded(cfg, outside, gate_key, gate, me=None):
    """Fetch and merge a portable config in place; returns (result, viewer)."""
    if outside is not None:
        try:
            cfg["refresh"]["outside_blockers_depth"] = parse_depth(outside)
        except ValueError as err:
            raise Refused(400, str(err)) from None
    with gate.enter(gate_key) if gate else contextlib.nullcontext():
        api = Api(DEFAULT_API, api_key())
        fetched, edges, produces = fetch_graph(cfg, api)
        result = record(cfg, merge(cfg, fetched, edges, produces))
        return result, viewer_name(api) or me


def refresh_file(path, graph_id=None, scope=None, outside=None, replacement=None, gate=None,
                 me=None) -> dict[str, Any]:
    """Refresh one graph inside an HTML page or report, rewriting only that graph.

    A page's request names its scope, which must be the one its file holds; that check and
    the path checks run before any API call. The command line passes no scope.
    """
    real, text, info = read_target(path)
    # Errors name the file as the request gave it: a symlink's target name is not the requester's to learn.
    name = Path(path).name
    reload_renderer()
    graph_id = choose_graph(text, graph_id, name)
    embedded = render_graph.read_embedded(text, graph_id)
    if scope is not None and (embedded is None or str((embedded.get("refresh") or {}).get("scope")) != scope):
        raise Refused(404, f"{name} holds no graph '{graph_id}' for {scope}.")
    side = legacy_config_for(graph_id, real)
    if side is not None:
        if replacement is not None:
            raise Refused(400, f"This graph still refreshes from {side}; edit that file, then run --once {graph_id}.")
        return dict(refresh(graph_id, outside=outside, gate=gate), written=True, file=str(real))
    if replacement is None and embedded is None:
        raise Refused(404, f"{name} was made by an older version of the skill and its config is not on "
                           "this machine. Ask its author to refresh it once, or create the graph again with --new.")
    if render_graph.graph_region(text, graph_id) is None:
        raise Refused(404, f"{name} has no depgraph markers for '{graph_id}'.")
    cfg = sanitize(embedded if replacement is None else replacement, graph_id)
    result, viewer = refresh_embedded(cfg, outside, ("file", str(real)), gate, me)
    fragment, _, _ = render_graph.render_fragment(for_render(cfg, viewer))
    write_atomic(real, render_graph.replace_region(text, graph_id, fragment, real.name), info)
    return dict(result, written=True, file=str(real), port=cfg["refresh"]["port"])


def refresh_config(raw, graph_id, scope, outside, gate=None):
    """Refresh a graph whose page is not a file (served from this machine); nothing is written."""
    cfg = sanitize(raw, graph_id)
    if cfg["refresh"]["scope"] != scope:
        raise Refused(400, "The request and its config name different scopes.")
    result, viewer = refresh_embedded(cfg, outside, ("config", graph_id), gate)
    block, _, _ = render_graph.render_block(for_render(cfg, viewer))
    return dict(result, html=block, written=False)


def origin_kind(origin):
    """absent (a local program, not a browser), null (a file page, or a sandboxed frame), loopback, or other."""
    if origin is None:
        return "absent"
    if origin == "null":
        return "null"
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme in ("http", "https") and parsed.hostname in LOOPBACK_HOSTS:
        return "loopback"
    return "other"


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload, cors: str | None = "*"):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if cors:
            self.send_header("Access-Control-Allow-Origin", cors)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            if cors != "*":
                self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _page_origin(self):
        """The Origin to echo for a page this helper serves: file pages and pages from this machine."""
        origin = self.headers.get("Origin")
        return origin if origin_kind(origin) in ("null", "loopback") else None

    def do_OPTIONS(self):
        if urllib.parse.urlparse(self.path).path == REFRESH_PATH:
            # The JSON body makes browsers ask first; only pages that may refresh get a yes.
            origin = self._page_origin()
            if origin is None:
                self.send_response(403)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _from_local_program(self):
        """True for --ensure: no Origin, addressed to loopback (a DNS-rebound page sends no Origin on a GET)."""
        host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
        return origin_kind(self.headers.get("Origin")) == "absent" and host in LOOPBACK_HOSTS

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/health":
            # protocol lets a page tell an out-of-date helper from a missing one. script and pid let a
            # newer install recognise and replace this helper; the script path holds the username, so
            # no browser gets them, not even a file page (Origin null may be any website's sandboxed frame).
            health: dict[str, Any] = {"ok": True, "protocol": PROTOCOL}
            if self._from_local_program():
                health.update(script=str(SCRIPT), pid=os.getpid())
            self._send(200, health, cors=self._page_origin())
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == REFRESH_PATH:
            self._refresh_v2()
            return
        if parsed.path != "/refresh":
            self._send(404, {"ok": False, "error": "not found"})
            return
        # Pages made before configs were embedded: the per-graph token in the URL authorizes the answer.
        query = urllib.parse.parse_qs(parsed.query)
        graph_id = (query.get("graph") or [""])[0]
        token = (query.get("token") or [""])[0]
        outside = (query.get("outside") or [None])[0]
        # Any website can call this endpoint, so its errors name no paths (they would reveal the username).
        try:
            self._send(200, refresh(graph_id, token, outside, gate=GATE))
        except PermissionError:
            self._send(403, {"ok": False, "error": "this page's token does not match the graph config"})
        except FileNotFoundError:
            self._send(404, {"ok": False, "error": f"no graph config for '{graph_id}' on this machine"})
        except ValueError:
            self._send(404, {"ok": False, "error": "bad graph id or option"})
        except Refused as err:
            self._send(err.status, {"ok": False, "error": str(err)})
        except urllib.error.HTTPError as err:
            self._send(502, {"ok": False, "error": f"ClosedLoop API returned {err.code}"})
        except Exception as err:  # report any other failure to the page instead of dropping the request
            sys.stderr.write(f"refresh-helper: refresh failed: {err!r}\n")
            self._send(500, {"ok": False, "error": f"The refresh failed; see {LOG_HINT}."})

    def _refresh_v2(self):
        origin = self.headers.get("Origin")
        kind = origin_kind(origin)
        cors = self._page_origin()
        try:
            body = self._json_body(kind)
            graph_id, scope = body.get("graph"), body.get("scope")
            if not isinstance(graph_id, str) or not render_graph.GRAPH_ID.match(graph_id):
                raise Refused(400, "The request names no valid graph.")
            if not isinstance(scope, str) or not SCOPE.match(scope):
                raise Refused(400, "The request names no valid scope.")
            outside = body.get("outside")
            if "path" in body:
                result = refresh_file(body["path"], graph_id=graph_id, scope=scope, outside=outside, gate=GATE)
                # No ticket data goes back: the page reloads and reads the rewritten file itself.
                self._send(200, {"ok": True, "written": True, "refresh_id": result["refresh_id"]}, cors)
            elif "config" in body:
                if kind == "null":
                    # A null origin may be a sandboxed frame on any website, so it gets no ticket data.
                    raise Refused(403, "Only pages opened from a file or served from this machine can refresh.")
                result = refresh_config(body["config"], graph_id, scope, outside, gate=GATE)
                self._send(200, {k: result[k] for k in ("ok", "html", "summary", "changes", "nodes", "edges", "written")}, cors)
            else:
                raise Refused(400, "The request names neither a file nor a config.")
        except Refused as err:
            self._send(err.status, {"ok": False, "error": str(err)}, cors)
        except urllib.error.HTTPError as err:
            self._send(502, {"ok": False, "error": f"ClosedLoop API returned {err.code}"}, cors)
        except Exception as err:  # never echo details (they can hold ticket data) to a page
            sys.stderr.write(f"refresh-helper: refresh failed: {err!r}\n")
            self._send(500, {"ok": False, "error": f"The refresh failed; see {LOG_HINT}."}, cors)

    def _json_body(self, kind):
        if kind == "other":
            raise Refused(403, "This website may not use the refresh helper.")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise Refused(415, "The request must be JSON.")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise Refused(400, "Bad Content-Length.") from None
        if length <= 0 or length > MAX_BODY_BYTES:
            raise Refused(413, "The request is empty or too large.")
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            raise Refused(400, "The request is not valid JSON.") from None
        if not isinstance(body, dict):
            raise Refused(400, "The request must be a JSON object.")
        return body

    def log_message(self, format, *args):  # noqa: A002 (the base class names it format)
        sys.stderr.write("refresh-helper: " + (format % args).replace(self.path, self.path.split("&token=")[0]) + "\n")


def scope_name(api, scope):
    try:
        if scope.upper().startswith("PRO-"):
            return api.get(f"/projects/by-slug/{scope}", {}).get("name") or ""
        doc = api.get(f"/documents/{scope}", {})
        return doc.get("title") or doc.get("name") or ""
    except (urllib.error.URLError, RuntimeError, AttributeError):
        return ""


def create(args):
    """Create a graph and write it into a page or report; nothing is saved outside that file."""
    scope = args.new.upper()
    if not SCOPE.match(scope):
        raise SystemExit(f"{args.new} is not a document or project slug (for example PRD-751 or PRO-67)")
    graph_id = args.graph_id or scope.lower()
    if not render_graph.GRAPH_ID.match(graph_id):
        raise SystemExit("--graph-id must be lowercase letters, digits and dashes")
    if not (args.output or args.embed_into):
        raise SystemExit("--new needs -o PATH (standalone page) or --embed-into PATH (report with markers)")
    target = Path(os.path.expanduser(args.embed_into or args.output)).resolve()
    try:
        text = target.read_text(encoding="utf-8")
    except (FileNotFoundError, UnicodeDecodeError):
        text = ""
    if args.embed_into and render_graph.graph_region(text, graph_id) is None:
        start, end = render_graph.embed_markers(graph_id)
        raise SystemExit(f"add {start} and {end} to {args.embed_into} where the graph belongs")
    if render_graph.read_embedded(text, graph_id) is not None or legacy_config_for(graph_id, target):
        raise SystemExit(f"{target} already holds graph '{graph_id}'; refresh it with --once {shlex.quote(str(target))}, "
                         "or pick another --graph-id")
    api = Api(DEFAULT_API, api_key())
    name = scope_name(api, scope)
    cfg = {
        "title": f"{scope} dependency graph",
        "subtitle": (name + ". " if name else "") + "Live BLOCKS links from ClosedLoop.",
        "column_labels": [],
        "nodes": [],
        "edges": [],
        "refresh": {
            "graph_id": graph_id,
            "port": args.port,
            "scope": scope,
            "app_issue_base": APP_ISSUE_BASE,
            "include_plans": bool(args.include_plans),
            "outside_blockers_depth": parse_depth(args.outside_depth),
        },
    }
    fetched, edges, produces = fetch_graph(cfg, api)
    result = record(cfg, merge(cfg, fetched, edges, produces))
    cfg.pop("last_refresh")  # a new page has nothing to report
    me = viewer_name(api) or args.me
    data = for_render(cfg, me)
    if args.embed_into:
        fragment, _, _ = render_graph.render_fragment(data)
        write_atomic(target, render_graph.replace_region(text, graph_id, fragment, str(target)))
    else:
        doc, _, _ = render_graph.render_page(data)
        write_atomic(target, doc)
    print(f"{result['nodes']} tickets, {result['edges']} BLOCKS links, written to {target}")
    print(f"highlighted as yours: {me}" if me else "could not look up who you are, so no tickets are highlighted as yours")


def export_config(path, graph_id):
    real, text, _ = read_target(os.path.abspath(os.path.expanduser(path)))
    graph_id = choose_graph(text, graph_id, real.name)
    cfg = render_graph.read_embedded(text, graph_id)
    if cfg is None:
        raise Refused(404, f"{real.name} carries no embedded config for '{graph_id}'.")
    return cfg


def once(args):
    target = args.once
    if render_graph.GRAPH_ID.match(target) and not os.path.exists(target):
        result = refresh(target)  # a graph that still has a config file
        port = json.loads(config_path(target).read_text(encoding="utf-8"))["refresh"].get("port")
    else:
        replacement = json.loads(Path(args.apply_config).read_text(encoding="utf-8")) if args.apply_config else None
        result = refresh_file(os.path.abspath(os.path.expanduser(target)), graph_id=args.graph,
                              replacement=replacement, me=args.me)
        port = result.get("port")
    print(result["summary"])
    for change in result["changes"]:
        print(" -", change)
    return int(port or render_graph.DEFAULT_PORT)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=render_graph.DEFAULT_PORT)
    parser.add_argument("--once", metavar="PAGE_OR_GRAPH_ID",
                        help="refresh a page or report in place (or an older graph by its config id) and exit")
    parser.add_argument("--graph", help="with --once or --export-config: which graph, when a file holds several")
    parser.add_argument("--export-config", metavar="PAGE",
                        help="print the config a page or report carries, to edit labels and column_labels")
    parser.add_argument("--apply-config", metavar="JSON",
                        help="with --once PAGE: refresh from this edited config instead of the one in the page")
    parser.add_argument("--new", metavar="SLUG", help="create a graph for a PRD/document (PRD-751, ISS-123) or project (PRO-67)")
    parser.add_argument("--me", help="first name to highlight if looking up the API key's owner fails (normally not needed)")
    parser.add_argument("--graph-id", help="with --new: the graph's id in the page (default: the slug in lowercase)")
    parser.add_argument("-o", "--output", help="with --new: write a standalone page here")
    parser.add_argument("--embed-into", help="with --new: fill this report's depgraph markers instead")
    parser.add_argument("--outside-depth", default="1",
                        help='with --new: how many layers of blockers outside the scope to show (default 1; "all" for the whole chain)')
    parser.add_argument("--include-plans", action="store_true", help="with --new: include implementation plans")
    parser.add_argument("--ensure", action="store_true",
                        help="start the helper in the background if it is not running, then exit")
    args = parser.parse_args()
    try:
        if args.export_config:
            print(json.dumps(export_config(args.export_config, args.graph), indent=1, ensure_ascii=False))
            return
        if args.ensure:
            install_launcher()
            print(ensure_helper(args.port))
            return
        if args.new:
            install_launcher()  # first, so the page's start command can name it
            create(args)
            print(ensure_helper(args.port))
            return
        if args.once:
            install_launcher()
            print(ensure_helper(once(args)))
            return
    except Refused as err:
        raise SystemExit(f"error: {err}") from None
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    api_key()
    install_launcher()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"prd-dependency-graph refresh helper on http://127.0.0.1:{args.port} (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def launcher_body() -> str:
    """Return a launcher that resolves the newest surviving plugin cache at execution time."""
    try:
        fallback_version = json.loads((SCRIPT.parents[3] / ".claude-plugin" / "plugin.json")
                                      .read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        fallback_version = None
    if not isinstance(fallback_version, str):
        fallback_version = "0.0.0-dev"
    return f'''#!/usr/bin/env python3
{LAUNCHER_MARK}: written by the prd-dependency-graph skill; resolves plugin updates at runtime.
import os
import re
import sys
from pathlib import Path

FALLBACK = {str(SCRIPT)!r}
FALLBACK_VERSION = {fallback_version!r}
PLUGIN_CACHE = Path("plugins/cache/closedloop-ai/closedloop-core")
HELPER = Path("skills/prd-dependency-graph/scripts/refresh_server.py")


def version_key(name):
    match = re.fullmatch(r"(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?", name)
    if not match:
        return (-1, -1, -1, 0, name)
    prerelease = match.group(4)
    return (*(int(match.group(i)) for i in range(1, 4)), 1 if prerelease is None else 0, prerelease or "")


roots = [
    Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex"),
    Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"),
]
candidates = []
if Path(FALLBACK).is_file():
    candidates.append((version_key(FALLBACK_VERSION), 1, FALLBACK))
for root in roots:
    cache = root.expanduser() / PLUGIN_CACHE
    try:
        installs = list(cache.iterdir())
    except OSError:
        continue
    for install in installs:
        helper = install / HELPER
        if helper.is_file():
            candidates.append((version_key(install.name), 0, str(helper)))

if not candidates:
    raise SystemExit("prd-graph-helper: no installed dependency-graph helper was found; run the skill once to repair it")
script = max(candidates)[2]
os.execv(sys.executable, [sys.executable, script, *sys.argv[1:]])
'''


def install_launcher() -> None:
    """Write ~/.local/bin/prd-graph-helper without pinning it to one cache version."""
    launcher = render_graph.LAUNCHER
    body = launcher_body()
    try:
        if launcher.exists():
            current = launcher.read_text(encoding="utf-8", errors="replace")
            if LAUNCHER_MARK not in current:
                return  # someone else's file; leave it alone
            if current == body:
                return
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text(body, encoding="utf-8")
        launcher.chmod(0o755)
    except OSError as err:
        print(f"could not write {launcher}: {err}", file=sys.stderr)


def helper_health(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as resp:
            body = json.load(resp)
        return body if isinstance(body, dict) and body.get("ok") else None
    except (OSError, ValueError):
        return None


def listening_pid(port, health):
    """The pid of the helper on this port, read from /health or, for older helpers, from lsof."""
    pid = health.get("pid")
    if isinstance(pid, int):
        return pid
    try:
        out = subprocess.run(["lsof", "-tnP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0]) if out else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def is_refresh_helper(pid):
    try:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "refresh_server.py" in cmd


def wait_for(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


def ensure_helper(port):
    """Make sure this install's helper is serving `port`, starting or replacing one as needed."""
    health = helper_health(port)
    if health and health.get("script") == str(SCRIPT):
        return f"refresh helper already running on 127.0.0.1:{port}"
    if health:
        pid = listening_pid(port, health)
        if not pid or not is_refresh_helper(pid):
            return f"port {port} is in use by something else; the refresh button will not work until it is free"
        os.kill(pid, signal.SIGTERM)
        if not wait_for(lambda: helper_health(port) is None, 5):
            return f"could not stop the old refresh helper (pid {pid}) on port {port}"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(DATA_DIR / "helper.log", "a", encoding="utf-8") as log:
        subprocess.Popen([sys.executable, str(SCRIPT), "--port", str(port)], stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    if wait_for(lambda: (helper_health(port) or {}).get("script") == str(SCRIPT), 10):
        verb = "replaced the old refresh helper and started" if health else "started"
        return f"{verb} the refresh helper on 127.0.0.1:{port} (log: {DATA_DIR / 'helper.log'})"
    return f"the refresh helper did not start; see {DATA_DIR / 'helper.log'}"


if __name__ == "__main__":
    main()
