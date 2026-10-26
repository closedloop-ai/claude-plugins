"""Shared fixtures for the prd-dependency-graph tests.

The skill's scripts are loaded fresh for each test with HOME pointed at a
temporary directory, so configs, the launcher and the helper log never touch
the real machine, and the ClosedLoop API is replaced by an in-memory stub.
"""

import http.client
import importlib
import json
import sys
import threading
import urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "skills" / "prd-dependency-graph" / "scripts"
API_KEY = "sk_test_never_written_7f3a9c"


class FakeClosedLoop:
    """The slice of the ClosedLoop REST API the helper reads, with call accounting."""

    def __init__(self):
        self.viewer: str | None = "Ada"
        self.me_fails = False
        self.tickets = {
            "ISS-1": ("Design the shell", "Ada", "IN_PROGRESS"),
            "ISS-2": ("Build the components", "Pat", "TODO"),
            "ISS-3": ("Ship the page", "Ada", "BLOCKED"),
            "ISS-4": ("Write the docs", "Lee", "TODO"),
            "ISS-90": ("Outside blocker", "Lee", "TODO"),
            "ISS-50": ("Project task", "Pat", "TODO"),
            "ISS-51": ("Second project task", "Ada", "DONE"),
        }
        self.children = {"PRD-9": ["ISS-1", "ISS-2", "ISS-3", "ISS-4"]}
        self.projects = {"PRO-5": ["ISS-50", "ISS-51"]}
        self.blocks = [("ISS-1", "ISS-2"), ("ISS-2", "ISS-3"), ("ISS-90", "ISS-3"), ("ISS-50", "ISS-51")]
        self.calls = 0
        self.link_queries: list[str] = []
        self.bases: list[str] = []
        self.keys: list[str] = []

    def end(self, slug):
        name, owner, status = self.tickets[slug]
        return {"slug": slug, "name": name, "status": status, "assignee": {"firstName": owner},
                "type": "DOCUMENT", "subtype": "FEATURE"}

    def client(self, base, key):
        self.bases.append(base)
        self.keys.append(key)
        return FakeApi(self, base, key)


class FakeApi:
    def __init__(self, world, base, key):
        self.world = world
        self.base = base
        self.key = key

    def get(self, path, params):
        self.world.calls += 1
        if path == "/me":
            if self.world.me_fails:
                raise RuntimeError("/me: unavailable")
            return {"firstName": self.world.viewer}
        if path.startswith("/documents/"):
            slug = path.rsplit("/", 1)[1]
            if slug in self.world.tickets:
                return self.world.end(slug)
            return {"slug": slug, "title": f"{slug} title", "status": "DRAFT", "type": "PRD"}
        if path == "/documents":
            docs = [dict(self.world.end(s), type="FEATURE") for s in self.world.projects[params["projectId"]]]
            return {"items": docs, "hasMore": False}
        if path.startswith("/projects/by-slug/"):
            return {"name": "Week five"}
        raise AssertionError(f"unexpected API path {path}")

    def links(self, artifact, link_type, direction):
        self.world.calls += 1
        if link_type == "BLOCKS":
            self.world.link_queries.append(artifact)
        if link_type == "PRODUCES":
            return [{"source": {"slug": artifact}, "target": self.world.end(s)}
                    for s in self.world.children.get(artifact, [])]
        return [{"source": self.world.end(s), "target": self.world.end(d)}
                for s, d in self.world.blocks if artifact in (s, d)]


def _no_network(*args, **kwargs):
    raise AssertionError("tests must never reach the network")


@pytest.fixture
def api():
    return FakeClosedLoop()


@pytest.fixture
def graph(tmp_path, monkeypatch, api):
    """The skill's scripts, isolated: HOME in tmp_path, API stubbed, no background helper."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.syspath_prepend(str(SCRIPTS))
    for name in ("render_graph", "refresh_server"):
        sys.modules.pop(name, None)
    server = importlib.import_module("refresh_server")
    monkeypatch.setattr(server, "Api", api.client)
    monkeypatch.setattr(server, "api_key", lambda: API_KEY)
    monkeypatch.setattr(server, "ensure_helper", lambda port: "helper not started in tests")
    monkeypatch.setattr(server, "GATE", server.Gate())
    monkeypatch.setattr(urllib.request, "urlopen", _no_network)
    yield SimpleNamespace(server=server, render=server.render_graph, home=home, api=api)
    for name in ("render_graph", "refresh_server"):
        sys.modules.pop(name, None)


@contextmanager
def serving(server):
    """Serve one loaded refresh-helper module on a free loopback port."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]

    def request(method, path, body=None, origin="null", content_type="application/json", content_length=None,
                host=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if host is not None:
            headers["Host"] = host
        data = None if body is None else json.dumps(body).encode()
        if data is not None or content_length is not None:
            headers["Content-Type"] = content_type
        if content_length is not None:
            conn.putrequest(method, path)
            for name, value in dict(headers, **{"Content-Length": str(content_length)}).items():
                conn.putheader(name, value)
            conn.endheaders()
        else:
            conn.request(method, path, body=data, headers=headers)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        return SimpleNamespace(status=resp.status, headers={k.lower(): v for k, v in resp.getheaders()},
                               raw=payload, json=json.loads(payload) if payload else None)

    try:
        yield request
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.fixture
def helper(graph):
    """A helper serving on a free loopback port in this process; yields a request function."""
    with serving(graph.server) as request:
        yield request


def new_graph(graph, scope, *, output=None, embed_into=None, graph_id=None, outside_depth="1"):
    """Create a graph the way `refresh_server.py --new` does."""
    graph.server.create(SimpleNamespace(new=scope, graph_id=graph_id, output=output and str(output),
                                        embed_into=embed_into and str(embed_into), port=8765,
                                        include_plans=False, outside_depth=outside_depth, me=None))


def embedded(graph, path, graph_id):
    return graph.render.read_embedded(Path(path).read_text(encoding="utf-8"), graph_id)


def refresh_body(path, graph_id="prd-9", scope="PRD-9", **extra):
    return dict({"graph": graph_id, "scope": scope, "path": str(path)}, **extra)
