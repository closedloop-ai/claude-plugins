#!/usr/bin/env python3
"""Local refresh helper for prd-dependency-graph pages.

Creating or refreshing a graph from the command line (`--new`, `--once`) starts
it in the background when it is not already running, and replaces a helper left
running from another install of this skill. To start it by hand:

    prd-graph-helper

That launcher, in ~/.local/bin, is rewritten on every run to point at this
script, so it keeps working when the plugin updates. `--ensure` starts the
helper in the background and exits; its log is
~/.local/share/prd-dependency-graph/helper.log.

It listens on 127.0.0.1 only. A graph page's refresh button
POSTs to /refresh?graph=<id>&token=<token>; the helper re-reads that graph's
tickets and BLOCKS links from the ClosedLoop API, re-renders the graph, writes
the updated HTML back to the files it was saved in, and returns the new graph
so the page can swap it in place.

Graph configs live in ~/.local/share/prd-dependency-graph/<graph-id>.json.
Each one carries its own random token, which is embedded only in the pages
generated from it, so another website open in the browser cannot drive this
helper. The API key is read from CLOSEDLOOP_API_KEY (falling back to a login
shell, which loads ~/.zprofile); it is never written to any file.

Also usable without the server: `--once <graph-id>` refreshes one graph, and
`--new <slug> --me <name> -o <page.html>` creates a graph for a PRD/document or
project (see --help).
"""

import argparse
import hmac
import importlib
import json
import os
import re
import secrets
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_graph  # noqa: E402

DATA_DIR = Path.home() / ".local" / "share" / "prd-dependency-graph"
DEFAULT_API = "https://api.closedloop.ai"
APP_ISSUE_BASE = "https://app.closedloop.ai/closedloop-ai/issues"
ISSUE_SUBTYPES = {"FEATURE", "ISSUE"}
PREFIX = re.compile(r"^\s*\[[^\]]*\]\s*")
GRAPH_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SCRIPT = Path(__file__).resolve()
LAUNCHER_MARK = "# prd-dependency-graph launcher"


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


def for_render(cfg):
    cfg = dict(cfg)
    cfg.setdefault("scope", scope_slug(cfg["refresh"]))
    return render_for(cfg)


def render_for(cfg):
    data = dict(cfg)
    data["edges"] = [(e["from"], e["to"]) for e in cfg["edges"]]
    data["produces"] = [(e["from"], e["to"]) for e in cfg.get("produces") or []]
    return data


def write_outputs(cfg):
    cfg = for_render(cfg)
    for out in cfg["refresh"].get("outputs", []):
        path = os.path.expanduser(out["path"])
        if out.get("mode") == "embed":
            fragment, _, _ = render_graph.render_fragment(cfg)
            render_graph.embed_into(path, cfg["refresh"]["graph_id"], fragment)
        else:
            doc, _, _ = render_graph.render_page(cfg)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(doc)


def config_path(graph_id):
    if not GRAPH_ID.match(graph_id or ""):
        raise ValueError("bad graph id")
    return DATA_DIR / f"{graph_id}.json"


def refresh(graph_id, token=None, outside=None):
    path = config_path(graph_id)
    if not path.exists():
        raise FileNotFoundError(f"no graph config at {path}")
    cfg = json.loads(path.read_text(encoding="utf-8"))
    importlib.reload(render_graph)  # pick up renderer edits without restarting the helper
    if token is not None and not hmac.compare_digest(str(cfg["refresh"].get("token", "")), token):
        raise PermissionError("bad token")
    if outside is not None:
        cfg["refresh"]["outside_blockers_depth"] = parse_depth(outside)
    api = Api(cfg["refresh"].get("api_base", DEFAULT_API), api_key())
    fetched, edges, produces = fetch_graph(cfg, api)
    changes = merge(cfg, fetched, edges, produces)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    write_outputs(cfg)
    block, n_nodes, n_edges = render_graph.render_block(for_render(cfg))
    summary = (f"Refreshed {cfg['generated_at']}: {n_nodes} tickets, {n_edges} BLOCKS links. "
               + (f"{len(changes)} change(s)." if changes else "No changes."))
    return {"ok": True, "html": block, "summary": summary, "changes": changes,
            "nodes": n_nodes, "edges": n_edges}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/health":
            # script and pid let a newer install recognise and replace this helper.
            self._send(200, {"ok": True, "script": str(SCRIPT), "pid": os.getpid()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/refresh":
            self._send(404, {"ok": False, "error": "not found"})
            return
        query = urllib.parse.parse_qs(parsed.query)
        graph_id = (query.get("graph") or [""])[0]
        token = (query.get("token") or [""])[0]
        outside = (query.get("outside") or [None])[0]
        try:
            self._send(200, refresh(graph_id, token, outside))
        except PermissionError:
            self._send(403, {"ok": False, "error": "this page's token does not match the graph config"})
        except (FileNotFoundError, ValueError) as err:
            self._send(404, {"ok": False, "error": str(err)})
        except urllib.error.HTTPError as err:
            self._send(502, {"ok": False, "error": f"ClosedLoop API returned {err.code}"})
        except Exception as err:  # report any other failure to the page instead of dropping the request
            self._send(500, {"ok": False, "error": str(err)})

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
    scope = args.new.upper()
    graph_id = args.graph_id or scope.lower()
    path = config_path(graph_id)
    if path.exists():
        raise SystemExit(f"{path} already exists; refresh it with --once {graph_id}, or pick another --graph-id")
    if not (args.output or args.embed_into):
        raise SystemExit("--new needs -o PATH (standalone page) or --embed-into PATH (report with markers)")
    if args.embed_into:
        start, end = render_graph.embed_markers(graph_id)
        text = Path(os.path.expanduser(args.embed_into)).read_text(encoding="utf-8")
        if start not in text or end not in text:
            raise SystemExit(f"add {start} and {end} to {args.embed_into} where the graph belongs")
    depth = args.outside_depth
    api = Api(DEFAULT_API, api_key())
    name = scope_name(api, scope)
    cfg = {
        "title": f"{scope} dependency graph",
        "subtitle": (name + ". " if name else "") + "Live BLOCKS links from ClosedLoop.",
        "me": args.me,
        "column_labels": [],
        "nodes": [],
        "edges": [],
        "refresh": {
            "graph_id": graph_id,
            "token": secrets.token_urlsafe(24),
            "port": args.port,
            "scope": scope,
            "api_base": DEFAULT_API,
            "app_issue_base": APP_ISSUE_BASE,
            "include_plans": bool(args.include_plans),
            "outside_blockers_depth": parse_depth(depth),
            "outputs": [{"path": args.embed_into, "mode": "embed"} if args.embed_into
                        else {"path": args.output, "mode": "page"}],
        },
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    os.chmod(path, 0o600)
    result = refresh(graph_id)
    print(f"created {path}")
    print(f"{result['nodes']} tickets, {result['edges']} BLOCKS links, written to "
          f"{cfg['refresh']['outputs'][0]['path']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=render_graph.DEFAULT_PORT)
    parser.add_argument("--once", metavar="GRAPH_ID", help="refresh one graph and exit, without starting the server")
    parser.add_argument("--new", metavar="SLUG", help="create a graph for a PRD/document (PRD-751, ISS-123) or project (PRO-67)")
    parser.add_argument("--me", help="with --new: your first name, to highlight your tickets")
    parser.add_argument("--graph-id", help="with --new: config name (default: the slug in lowercase)")
    parser.add_argument("-o", "--output", help="with --new: write a standalone page here")
    parser.add_argument("--embed-into", help="with --new: fill this report's depgraph markers instead")
    parser.add_argument("--outside-depth", default="1",
                        help='with --new: how many layers of blockers outside the scope to show (default 1; "all" for the whole chain)')
    parser.add_argument("--include-plans", action="store_true", help="with --new: include implementation plans")
    parser.add_argument("--ensure", action="store_true",
                        help="start the helper in the background if it is not running, then exit")
    args = parser.parse_args()
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
        result = refresh(args.once)
        print(result["summary"])
        for change in result["changes"]:
            print(" -", change)
        cfg = json.loads(config_path(args.once).read_text(encoding="utf-8"))
        print(ensure_helper(int(cfg["refresh"].get("port") or render_graph.DEFAULT_PORT)))
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    api_key()
    install_launcher()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"prd-dependency-graph refresh helper on http://127.0.0.1:{args.port} (Ctrl+C to stop)")
    print(f"graph configs: {DATA_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def install_launcher():
    """Write ~/.local/bin/prd-graph-helper pointing at this script; rewritten when the script moves."""
    launcher = render_graph.LAUNCHER
    body = (f"#!/bin/sh\n{LAUNCHER_MARK}: written by the prd-dependency-graph skill, rewritten on every run.\n"
            f"exec python3 {shlex.quote(str(SCRIPT))} \"$@\"\n")
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
