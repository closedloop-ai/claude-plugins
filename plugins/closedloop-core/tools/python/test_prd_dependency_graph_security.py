"""The refresh helper's threat model (prd-dependency-graph SKILL.md, "Security"), enforced.

A website open in the browser can send requests to 127.0.0.1. It must not read
ticket data through the helper, make it write files other than a graph page,
spend API calls on scopes no local file holds, or learn the API key.
"""

import contextlib
import http.client
import json
import os
import pwd
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
from conftest import API_KEY, SCRIPTS, embedded, new_graph, refresh_body

EVIL = "https://evil.example"
REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir  # the account's home, whatever HOME the test sets


@pytest.fixture
def page(graph, tmp_path):
    path = tmp_path / "pages" / "prd-9-dependency-graph.html"
    path.parent.mkdir()
    new_graph(graph, "PRD-9", output=path)
    graph.api.calls = 0
    return path


def test_file_refresh_answers_without_ticket_data(helper, page, graph):
    graph.api.tickets["ISS-2"] = ("Build the components", "Pat", "DONE")

    resp = helper("POST", "/v2/refresh", refresh_body(page))

    assert resp.status == 200
    assert set(resp.json) == {"ok", "written", "refresh_id"}
    assert b"ISS-" not in resp.raw and b"Pat" not in resp.raw
    assert resp.headers["access-control-allow-origin"] == "null"
    cfg = embedded(graph, page, "prd-9")
    assert cfg["last_refresh"]["id"] == resp.json["refresh_id"]
    assert any("ISS-2" in change and "DONE" in change for change in cfg["last_refresh"]["changes"])


def test_other_websites_are_refused_before_any_api_call(helper, page, graph):
    before = page.read_bytes()

    preflight = helper("OPTIONS", "/v2/refresh", origin=EVIL)
    post = helper("POST", "/v2/refresh", refresh_body(page), origin=EVIL)

    assert preflight.status == 403 and "access-control-allow-origin" not in preflight.headers
    assert post.status == 403 and "access-control-allow-origin" not in post.headers
    assert graph.api.calls == 0
    assert page.read_bytes() == before


def test_preflight_is_granted_to_file_pages_and_pages_from_this_machine(helper):
    for origin in ("null", "http://localhost:5173", "http://127.0.0.1:8000"):
        resp = helper("OPTIONS", "/v2/refresh", origin=origin)
        assert resp.status == 204
        assert resp.headers["access-control-allow-origin"] == origin
        assert resp.headers["access-control-allow-headers"] == "Content-Type"


def test_a_simple_cross_site_post_cannot_refresh(helper, page, graph):
    # text/plain needs no preflight, so a website could send it; JSON is required instead.
    resp = helper("POST", "/v2/refresh", refresh_body(page), content_type="text/plain")

    assert resp.status == 415
    assert graph.api.calls == 0


def test_ticket_data_is_returned_only_to_pages_from_this_machine(helper, page, graph):
    config = embedded(graph, page, "prd-9")
    body = {"graph": "prd-9", "scope": "PRD-9", "config": config}
    before = page.read_bytes()

    sandboxed = helper("POST", "/v2/refresh", body, origin="null")
    local = helper("POST", "/v2/refresh", body, origin="http://localhost:5173")

    assert sandboxed.status == 403 and b"ISS-" not in sandboxed.raw
    assert local.status == 200 and local.json["written"] is False
    assert "ISS-3" in local.json["html"]
    assert page.read_bytes() == before


def _target(kind, tmp_path, page):
    other = tmp_path / "other"
    other.mkdir()
    text = page.read_text(encoding="utf-8")
    if kind == "relative":
        return os.path.relpath(page)
    if kind == "not-html":
        target = other / "notes.txt"
        target.write_text(text, encoding="utf-8")
        return str(target)
    if kind == "missing":
        return str(other / "missing.html")
    if kind == "directory":
        target = other / "folder.html"
        target.mkdir()
        return str(target)
    if kind == "symlink-to-other-type":
        real = other / "secrets.conf"
        real.write_text(text, encoding="utf-8")
        link = other / "link.html"
        link.symlink_to(real)
        return str(link)
    if kind == "no-graph":
        target = other / "report.html"
        target.write_text("<html><body>plain report</body></html>", encoding="utf-8")
        return str(target)
    if kind == "other-graph":
        target = other / "renamed.html"
        target.write_text(text.replace("depgraph:prd-9:", "depgraph:prd-8:"), encoding="utf-8")
        return str(target)
    raise AssertionError(kind)


@pytest.mark.parametrize("kind", ["relative", "not-html", "missing", "directory", "symlink-to-other-type",
                                  "no-graph", "other-graph"])
def test_only_html_files_holding_this_graph_are_written(helper, page, graph, tmp_path, kind):
    target = _target(kind, tmp_path, page)
    snapshot = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file() and not p.is_symlink()}

    resp = helper("POST", "/v2/refresh", refresh_body(target))

    assert 400 <= resp.status < 500
    assert resp.json["ok"] is False
    assert graph.api.calls == 0
    assert {p: p.read_bytes() for p in snapshot} == snapshot


def test_request_must_name_the_scope_the_file_holds(helper, page, graph):
    before = page.read_bytes()

    resp = helper("POST", "/v2/refresh", refresh_body(page, scope="PRD-10"))

    assert resp.status == 404
    assert "PRD-9" not in resp.json["error"]
    assert graph.api.calls == 0
    assert page.read_bytes() == before


@pytest.mark.parametrize("scope", ["../me", "PRD-9/../../users", "prd 9", ""])
def test_malformed_scopes_never_reach_the_api(helper, page, graph, scope):
    resp = helper("POST", "/v2/refresh", refresh_body(page, scope=scope))

    assert resp.status == 400
    assert graph.api.calls == 0


def test_repeated_refreshes_are_rate_limited(helper, page, graph):
    first = helper("POST", "/v2/refresh", refresh_body(page))
    calls = graph.api.calls

    second = helper("POST", "/v2/refresh", refresh_body(page))

    assert first.status == 200
    assert second.status == 429
    assert graph.api.calls == calls


def test_oversized_requests_are_refused_unread(helper, page, graph):
    # The helper answers from the headers alone, so the body is never sent here.
    resp = helper("POST", "/v2/refresh", content_length=5 * 1024 * 1024)

    assert resp.status == 413
    assert graph.api.calls == 0


def test_only_the_graph_region_of_a_file_changes(helper, page, graph):
    text = page.read_text(encoding="utf-8")
    region = graph.render.graph_region(text, "prd-9")
    graph.api.tickets["ISS-1"] = ("Design the shell", "Ada", "DONE")

    assert helper("POST", "/v2/refresh", refresh_body(page)).status == 200

    after = page.read_text(encoding="utf-8")
    new_region = graph.render.graph_region(after, "prd-9")
    assert after[: new_region[0]] == text[: region[0]]
    assert after[new_region[1]:] == text[region[1]:]
    assert after != text


def test_api_key_goes_only_to_the_closedloop_api_and_is_never_written(helper, page, graph, tmp_path):
    # A crafted page cannot redirect the key: the helper ignores any API base a page names.
    text = page.read_text(encoding="utf-8")
    cfg = embedded(graph, page, "prd-9")
    cfg["refresh"]["api_base"] = EVIL
    cfg["api_base"] = EVIL
    old = graph.render.CONFIG_TAG.search(text)
    crafted = graph.render.config_html({"refresh": cfg["refresh"], **{k: v for k, v in cfg.items() if k != "refresh"}})
    page.write_text(text[: old.start()] + crafted + text[old.end():], encoding="utf-8")

    assert helper("POST", "/v2/refresh", refresh_body(page)).status == 200

    assert set(graph.api.bases) == {graph.server.DEFAULT_API}
    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert API_KEY.encode() not in path.read_bytes(), path
    assert EVIL not in page.read_text(encoding="utf-8")


def test_the_page_carries_no_token_path_or_viewer(graph, page, tmp_path):
    text = page.read_text(encoding="utf-8")
    cfg = embedded(graph, page, "prd-9")

    assert set(cfg["refresh"]) <= set(graph.render.PORTABLE_REFRESH_KEYS)
    assert "me" not in cfg and "token" not in json.dumps(cfg)
    assert str(tmp_path) not in text and str(Path.home()) not in text
    assert 'data-refresh-url="' not in text
    assert 'data-start-cmd="~/.local/bin/prd-graph-helper"' in text


@pytest.mark.parametrize("origin", ["null", "http://localhost:5173", "http://127.0.0.1:8000", EVIL])
def test_health_tells_browsers_the_protocol_and_nothing_about_the_machine(helper, graph, origin):
    # Origin null may be a sandboxed frame on any website, so even file pages get no path or pid.
    resp = helper("GET", "/health", origin=origin)

    assert resp.status == 200
    assert resp.json == {"ok": True, "protocol": 2}
    text = resp.raw.decode()
    assert str(graph.server.SCRIPT.parent) not in text and str(os.getpid()) not in text
    assert REAL_HOME not in text and str(graph.home) not in text
    if origin == EVIL:
        assert "access-control-allow-origin" not in resp.headers
    else:
        assert resp.headers["access-control-allow-origin"] == origin


def test_health_identifies_the_helper_to_local_programs(helper, graph):
    resp = helper("GET", "/health", origin=None)

    assert resp.json == {"ok": True, "protocol": 2, "script": str(graph.server.SCRIPT), "pid": os.getpid()}


def test_health_identifies_nothing_to_a_dns_rebound_page(helper):
    # A website whose name resolves to 127.0.0.1 makes same-origin GETs, which carry no Origin.
    resp = helper("GET", "/health", origin=None, host="evil.example:8765")

    assert resp.json == {"ok": True, "protocol": 2}


def test_refresh_errors_name_the_file_as_requested_not_a_symlink_target(helper, graph, tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    target = other / f"{Path(REAL_HOME).name}-private-notes.html"
    target.write_text("<html><body>plain report</body></html>", encoding="utf-8")
    link = other / "guess.html"
    link.symlink_to(target)

    resp = helper("POST", "/v2/refresh", refresh_body(link))

    assert resp.status == 404
    assert "guess.html" in resp.json["error"]
    assert target.name not in resp.raw.decode()
    assert graph.api.calls == 0


def test_ensure_recognizes_and_replaces_a_helper_from_another_install(tmp_path):
    # Real processes on a free port with a scratch HOME: an older install's helper is running, and
    # --ensure from this install must still read its script and pid from /health and take over.
    home = tmp_path / "home"
    home.mkdir()
    other = tmp_path / "other-install" / "scripts"
    shutil.copytree(SCRIPTS, other, ignore=shutil.ignore_patterns("__pycache__"))
    old_script = (other / "refresh_server.py").resolve()
    new_script = (SCRIPTS / "refresh_server.py").resolve()
    env = dict(os.environ, HOME=str(home), CLOSEDLOOP_API_KEY=API_KEY)
    port = _free_port()
    old = subprocess.Popen([sys.executable, str(old_script), "--port", str(port)], env=env,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           start_new_session=True)
    try:
        before = _wait_for_health(port, old_script)
        assert before["pid"] == old.pid

        ensure = [sys.executable, str(new_script), "--ensure", "--port", str(port)]
        first = subprocess.run(ensure, env=env, capture_output=True, text=True, timeout=60)
        assert "replaced the old refresh helper" in first.stdout, first.stdout + first.stderr
        assert old.wait(timeout=10) is not None
        after = _local_health(port)
        assert after is not None and after["script"] == str(new_script) and after["pid"] != old.pid

        second = subprocess.run(ensure, env=env, capture_output=True, text=True, timeout=60)
        assert "already running" in second.stdout, second.stdout + second.stderr
        assert _local_health(port) == after
    finally:
        if old.poll() is None:
            old.kill()
            old.wait(timeout=10)
        _stop_helper(port, {str(old_script), str(new_script)})


def test_old_token_endpoint_errors_reveal_no_paths(helper, graph):
    resp = helper("POST", "/refresh?graph=prd-404&token=x", origin=EVIL)

    assert resp.status == 404
    assert str(graph.home) not in resp.raw.decode() and "/" not in resp.json["error"]
    assert graph.api.calls == 0


def test_old_token_endpoint_still_requires_its_token(helper, graph, tmp_path):
    out = tmp_path / "old.html"
    data_dir = graph.server.DATA_DIR
    data_dir.mkdir(parents=True)
    cfg = {"title": "PRD-9 dependency graph", "me": "Daniel", "nodes": [], "edges": [],
           "refresh": {"graph_id": "prd-9", "token": "tok-123", "port": 8765, "scope": "PRD-9",
                       "api_base": graph.server.DEFAULT_API, "outside_blockers_depth": 1,
                       "outputs": [{"path": str(out), "mode": "page"}]}}
    (data_dir / "prd-9.json").write_text(json.dumps(cfg), encoding="utf-8")

    bad = helper("POST", "/refresh?graph=prd-9&token=wrong", origin=EVIL)
    assert bad.status == 403 and graph.api.calls == 0

    good = helper("POST", "/refresh?graph=prd-9&token=tok-123", origin="null")
    assert good.status == 200 and "ISS-3" in good.json["html"]
    assert "tok-123" not in out.read_text(encoding="utf-8")
    assert json.loads((data_dir / "prd-9.json").read_text(encoding="utf-8"))["refresh"]["token"] == "tok-123"


def _free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _local_health(port):
    """/health as --ensure sees it: no Origin, addressed to 127.0.0.1."""
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        conn.request("GET", "/health")
        body = json.loads(conn.getresponse().read())
        conn.close()
        return body
    except (OSError, ValueError):
        return None


def _wait_for_health(port, script, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        health = _local_health(port)
        if health and health.get("script") == str(script):
            return health
        time.sleep(0.1)
    raise AssertionError(f"no helper for {script} on port {port}")


def _stop_helper(port, scripts):
    health = _local_health(port)
    if health and health.get("script") in scripts and isinstance(health.get("pid"), int):
        with contextlib.suppress(ProcessLookupError):
            os.kill(health["pid"], signal.SIGTERM)
