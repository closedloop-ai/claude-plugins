"""Portable graph pages: a copied page refreshes anywhere, and older graphs keep working."""

import json
import os
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest
from conftest import API_KEY, FakeClosedLoop, SCRIPTS, embedded, new_graph, refresh_body, serving

LEGACY_PAGE = ('<!doctype html><html><body><div class="wrap"><h1>PRD-9 dependency graph</h1>'
               '<div class="depgraph-block" data-refresh-url="http://127.0.0.1:8765/refresh?graph=prd-9&amp;'
               'token=tok-legacy" data-start-cmd="prd-graph-helper"><div class="depgraph"><svg></svg></div>'
               '</div></div></body></html>\n')


def legacy_config(graph, out, mode="page", **extra):
    graph.server.DATA_DIR.mkdir(parents=True, exist_ok=True)
    cfg = {"title": "PRD-9 dependency graph", "subtitle": "Older graph.", "me": "Daniel",
           "column_labels": ["first", "second", "third"],
           "nodes": [{"id": "ISS-1", "label": "shell", "owner": "Ada", "status": "IN_PROGRESS"}], "edges": [],
           "refresh": {"graph_id": "prd-9", "token": "tok-legacy", "port": 8765, "scope": "PRD-9",
                       "api_base": graph.server.DEFAULT_API, "app_issue_base": graph.server.APP_ISSUE_BASE,
                       "include_plans": False, "outside_blockers_depth": 1,
                       "outputs": [{"path": str(out), "mode": mode}]}}
    cfg.update(extra)
    path = graph.server.DATA_DIR / "prd-9.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path


def run_cli(graph, monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["refresh_server.py", *argv])
    graph.server.main()


def test_new_saves_nothing_outside_the_page(graph, tmp_path):
    out = tmp_path / "author" / "graph.html"
    out.parent.mkdir()

    new_graph(graph, "PRD-9", output=out)

    text = out.read_text(encoding="utf-8")
    cfg = embedded(graph, out, "prd-9")
    assert not graph.server.DATA_DIR.exists() or not list(graph.server.DATA_DIR.glob("*.json"))
    assert cfg["refresh"]["scope"] == "PRD-9"
    assert {n["id"] for n in cfg["nodes"]} == {"PRD-9", "ISS-1", "ISS-2", "ISS-3", "ISS-4", "ISS-90"}
    assert {(e["from"], e["to"]) for e in cfg["edges"]} == {("ISS-1", "ISS-2"), ("ISS-2", "ISS-3"), ("ISS-90", "ISS-3")}
    assert "<!-- depgraph:prd-9:start -->" in text and "<!-- depgraph:prd-9:end -->" in text
    assert "yours (Ada)" in text


def test_a_copied_page_refreshes_on_another_machine_for_its_viewer(graph, helper, tmp_path):
    author = tmp_path / "author" / "graph.html"
    author.parent.mkdir()
    new_graph(graph, "PRD-9", output=author)
    author_bytes = author.read_bytes()
    # Someone else, with no config of any kind, opens a copy from their own folder.
    copy = tmp_path / "someone-else" / "Downloads" / "shared graph.html"
    copy.parent.mkdir(parents=True)
    shutil.copy(author, copy)
    graph.api.viewer = "Pat"
    graph.server._ME_CACHE.clear()  # their helper has never looked anyone up
    graph.api.tickets["ISS-3"] = ("Ship the page", "Ada", "IN_REVIEW")

    resp = helper("POST", "/v2/refresh", refresh_body(copy))

    assert resp.status == 200 and resp.json["written"] is True
    text = copy.read_text(encoding="utf-8")
    assert "yours (Pat)" in text and "yours (Ada)" not in text
    cfg = embedded(graph, copy, "prd-9")
    assert "ISS-3 Ship the page: BLOCKED -> IN_REVIEW" in cfg["last_refresh"]["changes"]
    assert author.read_bytes() == author_bytes
    assert not graph.server.DATA_DIR.exists() or not list(graph.server.DATA_DIR.glob("*.json"))


def test_labels_and_columns_survive_a_refresh(graph, helper, tmp_path, monkeypatch, capsys):
    page = tmp_path / "graph.html"
    new_graph(graph, "PRD-9", output=page)
    capsys.readouterr()
    run_cli(graph, monkeypatch, "--export-config", str(page))
    cfg = json.loads(capsys.readouterr().out)
    cfg["column_labels"] = ["design", "build", "ship"]
    for node in cfg["nodes"]:
        if node["id"] == "ISS-2":
            node["label"] = "components"
    edited = tmp_path / "edited.json"
    edited.write_text(json.dumps(cfg), encoding="utf-8")

    run_cli(graph, monkeypatch, "--once", str(page), "--apply-config", str(edited))
    assert helper("POST", "/v2/refresh", refresh_body(page)).status == 200

    after = embedded(graph, page, "prd-9")
    assert after["column_labels"] == ["design", "build", "ship"]
    assert next(n for n in after["nodes"] if n["id"] == "ISS-2")["label"] == "components"
    assert "ISS-2 components" in page.read_text(encoding="utf-8")


def test_once_refreshes_a_page_directly(graph, tmp_path, monkeypatch, capsys):
    page = tmp_path / "graph.html"
    new_graph(graph, "PRD-9", output=page)
    graph.api.blocks.append(("ISS-1", "ISS-4"))

    run_cli(graph, monkeypatch, "--once", str(page))

    out = capsys.readouterr().out
    assert "new link: ISS-1 blocks ISS-4" in out
    assert {"from": "ISS-1", "to": "ISS-4"} in embedded(graph, page, "prd-9")["edges"]


def test_each_graph_in_a_report_carries_and_refreshes_its_own_config(graph, helper, tmp_path, monkeypatch, capsys):
    report = tmp_path / "briefing.html"
    report.write_text("<html><body><h1>Briefing</h1><p>Intro.</p>\n"
                      "<!-- depgraph:prd-9:start --><!-- depgraph:prd-9:end -->\n<p>Between.</p>\n"
                      "<!-- depgraph:pro-5:start --><!-- depgraph:pro-5:end -->\n<p>Outro.</p></body></html>\n",
                      encoding="utf-8")
    new_graph(graph, "PRD-9", embed_into=report)
    new_graph(graph, "PRO-5", embed_into=report)
    text = report.read_text(encoding="utf-8")
    pro_region = graph.render.graph_region(text, "pro-5")
    graph.api.tickets["ISS-4"] = ("Write the docs", "Lee", "DONE")

    assert helper("POST", "/v2/refresh", refresh_body(report)).status == 200

    after = report.read_text(encoding="utf-8")
    new_pro = graph.render.graph_region(after, "pro-5")
    assert after[new_pro[0]:new_pro[1]] == text[pro_region[0]:pro_region[1]]
    assert "<p>Intro.</p>" in after and "<p>Between.</p>" in after and "<p>Outro.</p>" in after
    assert embedded(graph, report, "pro-5")["refresh"]["scope"] == "PRO-5"
    assert next(n for n in embedded(graph, report, "prd-9")["nodes"] if n["id"] == "ISS-4")["status"] == "DONE"
    monkeypatch.setattr(sys, "argv", ["render_graph.py", str(report), "--graph", "pro-5", "--print-columns"])
    graph.render.main()
    assert "ISS-50" in capsys.readouterr().out


def test_highlighting_is_dropped_when_the_viewer_cannot_be_looked_up(graph, helper, tmp_path):
    page = tmp_path / "graph.html"
    new_graph(graph, "PRD-9", output=page)
    graph.api.me_fails = True
    graph.server._ME_CACHE.clear()

    assert helper("POST", "/v2/refresh", refresh_body(page)).status == 200

    text = page.read_text(encoding="utf-8")
    assert "yours (Ada)" not in text and ">YOU ·" not in text
    assert ">yours</text>" in text


def test_new_will_not_overwrite_a_graph(graph, tmp_path):
    page = tmp_path / "graph.html"
    new_graph(graph, "PRD-9", output=page)

    with pytest.raises(SystemExit, match="already holds graph 'prd-9'"):
        new_graph(graph, "PRD-9", output=page)


def test_older_graph_config_keeps_working_and_migrates_its_page(graph, helper, tmp_path, monkeypatch):
    page = tmp_path / "Desktop" / "prd-9-dependency-graph.html"
    page.parent.mkdir()
    page.write_text(LEGACY_PAGE, encoding="utf-8")
    config = legacy_config(graph, page)

    run_cli(graph, monkeypatch, "--once", "prd-9")

    text = page.read_text(encoding="utf-8")
    assert "tok-legacy" not in text and 'data-refresh-url="' not in text
    cfg = embedded(graph, page, "prd-9")
    assert cfg["column_labels"] == ["first", "second", "third"]
    assert next(n for n in cfg["nodes"] if n["id"] == "ISS-1")["label"] == "shell"
    # The config file stays the source of truth on the machine that has it.
    saved = json.loads(config.read_text(encoding="utf-8"))
    saved["column_labels"] = ["one", "two", "three"]
    config.write_text(json.dumps(saved), encoding="utf-8")
    assert helper("POST", "/v2/refresh", refresh_body(page)).status == 200
    assert embedded(graph, page, "prd-9")["column_labels"] == ["one", "two", "three"]
    assert json.loads(config.read_text(encoding="utf-8"))["refresh"]["token"] == "tok-legacy"


def test_older_report_migrates_through_its_token_url(graph, helper, tmp_path):
    report = tmp_path / "Downloads" / "prd-9-scope-briefing.html"
    report.parent.mkdir()
    report.write_text("<html><body><p>Prose.</p><!-- depgraph:prd-9:start -->\n" + LEGACY_PAGE
                      + "<!-- depgraph:prd-9:end --><p>More prose.</p></body></html>\n", encoding="utf-8")
    config = legacy_config(graph, report, mode="embed")
    saved = json.loads(config.read_text(encoding="utf-8"))
    saved["refresh"]["outside_blockers_depth"] = "all"
    config.write_text(json.dumps(saved), encoding="utf-8")

    resp = helper("POST", "/refresh?graph=prd-9&token=tok-legacy")

    assert resp.status == 200 and "dg-config" in resp.json["html"]
    text = report.read_text(encoding="utf-8")
    assert "<p>Prose.</p>" in text and "<p>More prose.</p>" in text and "tok-legacy" not in text
    assert embedded(graph, report, "prd-9")["refresh"]["outside_blockers_depth"] == "all"


def test_a_copied_old_page_explains_why_it_cannot_refresh(graph, tmp_path, monkeypatch):
    page = tmp_path / "old-copy.html"
    page.write_text(LEGACY_PAGE, encoding="utf-8")

    with pytest.raises(SystemExit, match="older version of the skill"):
        run_cli(graph, monkeypatch, "--once", str(page))
    assert graph.api.calls == 0


def test_hand_written_graphs_without_a_scope_still_render_without_refresh(graph, tmp_path, monkeypatch):
    example = graph.render.Path(graph.render.__file__).parents[1] / "examples" / "prd-751.json"
    out = tmp_path / "example.html"
    monkeypatch.setattr(sys, "argv", ["render_graph.py", str(example), "-o", str(out)])

    graph.render.main()

    text = out.read_text(encoding="utf-8")
    assert '<template class="dg-config"' not in text and 'class="dg-refresh dg-reload"' not in text
    assert 'class="dg-refresh dg-save"' in text


def test_scripts_run_as_commands(graph, tmp_path):
    env = dict(os.environ, HOME=str(graph.home))
    example = SCRIPTS.parent / "examples" / "prd-751.json"
    out = tmp_path / "cli.html"

    render = subprocess.run([sys.executable, str(SCRIPTS / "render_graph.py"), str(example), "-o", str(out)],
                            capture_output=True, text=True, env=env, timeout=60)
    helper_help = subprocess.run([sys.executable, str(SCRIPTS / "refresh_server.py"), "--help"],
                                 capture_output=True, text=True, env=env, timeout=60)

    assert render.returncode == 0, render.stderr
    assert json.loads(render.stdout)["edges"] == 50
    assert helper_help.returncode == 0 and "--export-config" in helper_help.stdout


def test_launcher_follows_plugin_update_after_old_cache_is_removed(graph, tmp_path, monkeypatch):
    codex_home = tmp_path / "codex-home"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))

    def cached_helper(version):
        script = (codex_home / "plugins" / "cache" / "closedloop-ai" / "closedloop-core" / version
                  / "skills" / "prd-dependency-graph" / "scripts" / "refresh_server.py")
        script.parent.mkdir(parents=True)
        script.write_text("import json, sys\nprint(json.dumps({'version': %r, 'args': sys.argv[1:]}))\n" % version,
                          encoding="utf-8")
        return script

    old_script = cached_helper("0.0.1")
    graph.server.install_launcher()
    # Newer than this checkout's own version, which the launcher prefers on a tie.
    source_version = json.loads((SCRIPTS.parents[2] / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    newer = f"{int(source_version['version'].split('.')[0]) + 1}.0.0"
    new_script = cached_helper(newer)
    shutil.rmtree(old_script.parents[3])
    launcher_env = dict(os.environ, PATH=os.path.dirname(sys.executable) + os.pathsep + os.environ["PATH"])

    result = subprocess.run([str(graph.render.LAUNCHER), "--ensure"], capture_output=True, text=True, timeout=30,
                            env=launcher_env)

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"version": newer, "args": ["--ensure"]}
    assert new_script.exists()

    shutil.rmtree(new_script.parents[3])
    fallback = subprocess.run([str(graph.render.LAUNCHER), "--help"], capture_output=True, text=True, timeout=30,
                              env=launcher_env)
    assert fallback.returncode == 0, fallback.stderr
    assert "--export-config" in fallback.stdout


def test_running_helper_refreshes_after_its_plugin_cache_is_removed(tmp_path, monkeypatch):
    install = tmp_path / "cache" / "closedloop-core" / "1.5.1"
    scripts = install / "skills" / "prd-dependency-graph" / "scripts"
    shutil.copytree(SCRIPTS, scripts)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.syspath_prepend(str(scripts))
    for name in ("render_graph", "refresh_server"):
        sys.modules.pop(name, None)
    server = __import__("refresh_server")
    api = FakeClosedLoop()
    monkeypatch.setattr(server, "Api", api.client)
    monkeypatch.setattr(server, "api_key", lambda: API_KEY)
    monkeypatch.setattr(server, "GATE", server.Gate())
    page = tmp_path / "prd-9-dependency-graph.html"
    server.create(SimpleNamespace(new="PRD-9", graph_id=None, output=str(page), embed_into=None, port=8765,
                                  include_plans=False, outside_depth="1", me=None))

    try:
        with serving(server) as request:
            shutil.rmtree(install)
            api.tickets["ISS-3"] = ("Ship the page", "Ada", "IN_REVIEW")
            response = request("POST", "/v2/refresh", refresh_body(page))

        assert response.status == 200, response.json
        config = server.render_graph.read_embedded(page.read_text(encoding="utf-8"), "prd-9")
        assert next(node for node in config["nodes"] if node["id"] == "ISS-3")["status"] == "IN_REVIEW"
    finally:
        for name in ("render_graph", "refresh_server"):
            sys.modules.pop(name, None)
