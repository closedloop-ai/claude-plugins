"""The launcher and the running refresh helper only ever move to a newer installed release.

An older session's copy of the skill, or a run from a repository checkout, must never point the
launcher back at itself or replace a newer helper (ISS-13712). A developer can still swap the helper
on purpose with --take-over, which leaves the launcher alone.
"""

import json
import os
import shutil
import subprocess
import sys

import pytest
from conftest import SCRIPTS, cache_dir, fake_cached_helper, installed_copy


def install_launcher_from(script, env):
    """Run install_launcher() from another copy of the skill, the way a session on that copy would."""
    code = "import sys; sys.path.insert(0, sys.argv[1]); import refresh_server; refresh_server.install_launcher()"
    result = subprocess.run([sys.executable, "-c", code, str(script.parent)], capture_output=True, text=True,
                            env=env, timeout=60)
    assert result.returncode == 0, result.stderr


@pytest.fixture
def homes(graph, tmp_path, monkeypatch):
    codex_home = tmp_path / "codex-home"
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    env = dict(os.environ, HOME=str(graph.home), CODEX_HOME=str(codex_home),
               CLAUDE_CONFIG_DIR=str(tmp_path / "claude-home"))
    return codex_home, env


def fallback(graph):
    return graph.server.launcher_fallback(graph.render.LAUNCHER.read_text(encoding="utf-8"))


def test_an_older_release_or_a_checkout_never_moves_the_launcher_back(graph, homes):
    codex_home, env = homes
    current = installed_copy(codex_home, "9.0.0")
    older = installed_copy(codex_home, "1.0.0")
    install_launcher_from(current, env)
    assert fallback(graph) == current
    written = graph.render.LAUNCHER.read_bytes()

    install_launcher_from(older, env)
    graph.server.install_launcher()  # this checkout

    assert graph.render.LAUNCHER.read_bytes() == written
    newer = installed_copy(codex_home, "10.0.0")
    install_launcher_from(newer, env)
    assert fallback(graph) == newer


def test_a_release_takes_the_launcher_back_from_a_checkout_or_a_removed_install(graph, homes):
    codex_home, env = homes
    graph.server.install_launcher()  # no launcher yet: a checkout may write one
    assert fallback(graph) == SCRIPTS / "refresh_server.py"
    assert "FALLBACK_VERSION = None" in graph.render.LAUNCHER.read_text(encoding="utf-8")

    release = installed_copy(codex_home, "1.0.0")
    install_launcher_from(release, env)
    assert fallback(graph) == release

    shutil.rmtree(cache_dir(codex_home, "1.0.0"))
    older = installed_copy(codex_home, "0.9.0")
    install_launcher_from(older, env)
    assert fallback(graph) == older


def test_the_launcher_runs_an_installed_release_over_a_newer_checkout(graph, homes):
    codex_home, env = homes
    source_version = json.loads((SCRIPTS.parents[2] / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert source_version["version"] != "0.0.1"
    graph.server.install_launcher()  # the checkout, whose own version is above the release below
    fake_cached_helper(codex_home, "0.0.1")
    env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + env["PATH"]

    # --help, not --ensure: if the checkout were chosen it must not start or stop a helper on this
    # machine's real port 8765, which a scratch HOME does not isolate.
    result = subprocess.run([str(graph.render.LAUNCHER), "--help"], capture_output=True, text=True, timeout=30,
                            env=env)

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"version": "0.0.1", "args": ["--help"]}


@pytest.mark.parametrize(("running", "take_over", "replaces"), [
    ("1.7.0", False, False),   # a newer release keeps running
    ("1.6.1", False, False),   # so does the same release from the other home
    ("1.5.3", False, True),    # an older release is replaced
    ("checkout", False, True),
    ("removed", False, True),
    (None, False, True),       # a helper too old to report its script
    ("1.7.0", True, True),     # --take-over replaces even a newer one
])
def test_an_installed_release_replaces_only_an_older_helper(graph, tmp_path, monkeypatch, running, take_over,
                                                             replaces):
    monkeypatch.setattr(graph.server, "SCRIPT", fake_cached_helper(tmp_path / "codex-home", "1.6.1"))
    paths = {"1.7.0": fake_cached_helper(tmp_path / "codex-home", "1.7.0"),
             "1.6.1": fake_cached_helper(tmp_path / "claude-home", "1.6.1"),
             "1.5.3": fake_cached_helper(tmp_path / "claude-home", "1.5.3"),
             "checkout": SCRIPTS / "refresh_server.py",
             "removed": cache_dir(tmp_path / "codex-home", "1.4.0") / "refresh_server.py"}

    assert graph.server.replaces_helper(str(paths[running]) if running else None, take_over) is replaces


@pytest.mark.parametrize(("take_over", "replaces"), [(False, False), (True, True)])
def test_a_checkout_replaces_a_running_helper_only_when_asked(graph, tmp_path, take_over, replaces):
    release = fake_cached_helper(tmp_path / "codex-home", "0.0.1")

    assert graph.server.replaces_helper(str(release), take_over) is replaces
    assert graph.server.replaces_helper(None) is True


def test_an_older_copy_uses_a_newer_running_helper_and_signals_nothing(graph, tmp_path, monkeypatch):
    newer = fake_cached_helper(tmp_path / "codex-home", "2.0.0")
    monkeypatch.setattr(graph.server, "SCRIPT", fake_cached_helper(tmp_path / "claude-home", "1.0.0"))
    monkeypatch.setattr(graph.server, "helper_health", lambda port: {"ok": True, "script": str(newer), "pid": 4242})

    def refuse(*args, **kwargs):
        raise AssertionError("an older copy must not stop or start a helper")

    monkeypatch.setattr(graph.server.os, "kill", refuse)
    monkeypatch.setattr(graph.server.subprocess, "Popen", refuse)

    message = graph.ensure_helper(8765)

    assert message.startswith("using the refresh helper already running on 127.0.0.1:8765")
    assert str(newer) in message
