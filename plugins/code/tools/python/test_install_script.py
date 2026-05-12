import json
import os
import subprocess
import textwrap
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
INSTALL_SCRIPT = REPO_ROOT / "install.sh"
PLUGINS = ["code", "code-review", "judges", "platform", "self-learning"]


def write_executable(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content).lstrip())
    path.chmod(0o755)


def write_fake_jq(bin_dir: Path) -> None:
    write_executable(
        bin_dir / "jq",
        r'''
        #!/usr/bin/env python3
        import json
        import sys
        from pathlib import Path

        args = sys.argv[1:]
        arg_values = {}
        filter_arg = None
        file_arg = None
        index = 0
        while index < len(args):
            arg = args[index]
            if arg in ("-r", "-e"):
                index += 1
                continue
            if arg == "--arg":
                arg_values[args[index + 1]] = args[index + 2]
                index += 3
                continue
            if filter_arg is None:
                filter_arg = arg
            elif file_arg is None:
                file_arg = arg
            index += 1

        raw = Path(file_arg).read_text() if file_arg else sys.stdin.read()
        data = json.loads(raw or "null")
        filt = filter_arg or ""

        if filt == "type == \"array\"":
            sys.exit(0 if isinstance(data, list) else 1)
        if "any(.name == $name)" in filt:
            name = arg_values["name"]
            sys.exit(0 if any(item.get("name") == name for item in data) else 1)
        if ".id + \" \"" in filt or ".id + \" \" + .version" in filt:
            for item in data:
                if item.get("scope") == "user":
                    enabled = item.get("enabled")
                    state = "enabled" if enabled is True else "disabled" if enabled is False else "unknown"
                    print(f"{item.get('id', '')} {item.get('version') or 'installed'} {state}")
            sys.exit(0)
        if "select(.id == $key and .scope == \"project\")" in filt:
            key = arg_values["key"]
            for item in data:
                if item.get("id") == key and item.get("scope") == "project":
                    print(item.get("projectPath") or "")
            sys.exit(0)
        if "select(.id == $key and .scope == \"user\")" in filt:
            key = arg_values["key"]
            matches = [
                item
                for item in data
                if item.get("id") == key and item.get("scope") == "user"
            ]
            if not matches:
                print("missing")
            elif any(item.get("enabled") is False for item in matches):
                print("disabled")
            else:
                print("enabled")
            sys.exit(0)
        if ".plugins[$key][]?" in filt and "select(.scope == \"user\")" in filt:
            key = arg_values["key"]
            for item in (data.get("plugins", {}).get(key) or []):
                if item.get("scope") == "user" and item.get("installPath"):
                    print(item["installPath"])
            sys.exit(0)

        raise SystemExit(f"unsupported jq filter: {filt}")
        ''',
    )


def write_fake_claude(bin_dir: Path) -> None:
    write_executable(
        bin_dir / "claude",
        r'''
        #!/usr/bin/env python3
        import json
        import os
        import sys
        from pathlib import Path

        state_path = Path(os.environ["FAKE_CLAUDE_STATE"])
        log_path = Path(os.environ["FAKE_CLAUDE_LOG"])
        scenario = os.environ.get("FAKE_CLAUDE_SCENARIO", "")
        home = Path(os.environ["HOME"])

        def load_state():
            if state_path.exists():
                return json.loads(state_path.read_text())
            return {"list": [], "list_calls": 0}

        def save_state(state):
            state_path.write_text(json.dumps(state))

        def registry_path():
            path = home / ".claude" / "plugins" / "installed_plugins.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(json.dumps({"version": 2, "plugins": {}}))
            return path

        def load_registry():
            return json.loads(registry_path().read_text())

        def save_registry(data):
            registry_path().write_text(json.dumps(data))

        def plugin_name(ref):
            return ref.split("@", 1)[0]

        def install_user(ref, enabled=True):
            name = plugin_name(ref)
            install_path = home / ".claude" / "plugins" / "cache" / "closedloop-ai" / name / "1.0.0"
            install_path.mkdir(parents=True, exist_ok=True)
            registry = load_registry()
            entries = [entry for entry in registry.setdefault("plugins", {}).get(ref, []) if entry.get("scope") != "user"]
            entries.append({"installPath": str(install_path), "scope": "user", "version": "1.0.0"})
            registry["plugins"][ref] = entries
            save_registry(registry)
            state = load_state()
            state["list"] = [entry for entry in state["list"] if not (entry.get("id") == ref and entry.get("scope") == "user")]
            state["list"].append({
                "enabled": enabled,
                "id": ref,
                "installPath": str(install_path),
                "scope": "user",
                "version": "1.0.0",
            })
            save_state(state)

        args = sys.argv[1:]
        with log_path.open("a") as log:
            log.write(f"{Path.cwd()}::claude {' '.join(args)}\n")

        if args == ["--version"]:
            print("1.0.0")
            raise SystemExit(0)
        if args == ["plugin", "marketplace", "list", "--json"]:
            print(json.dumps([{"name": "closedloop-ai"}]))
            raise SystemExit(0)
        if args[:3] == ["plugin", "marketplace", "add"]:
            raise SystemExit(0)
        if args == ["plugin", "marketplace", "update", "closedloop-ai"]:
            if scenario == "marketplace-update-fails":
                print("cannot refresh marketplace", file=sys.stderr)
                raise SystemExit(1)
            raise SystemExit(0)
        if args == ["plugin", "list", "--json"]:
            state = load_state()
            state["list_calls"] = state.get("list_calls", 0) + 1
            save_state(state)
            if scenario == "final-list-fails" and state["list_calls"] >= 13:
                raise SystemExit(1)
            print(json.dumps(state["list"]))
            raise SystemExit(0)
        if len(args) >= 5 and args[:2] == ["plugin", "install"] and args[3:] == ["--scope", "user"]:
            ref = args[2]
            if scenario == "no-user-entry" and ref == "code@closedloop-ai":
                raise SystemExit(0)
            install_user(
                ref,
                enabled=not (
                    (
                        scenario
                        in {
                            "disabled-success",
                            "enable-fails",
                            "enable-still-disabled",
                        }
                        and ref == "code@closedloop-ai"
                    )
                ),
            )
            raise SystemExit(0)
        if len(args) >= 5 and args[:2] == ["plugin", "update"] and args[3:] == ["--scope", "user"]:
            install_user(args[2])
            raise SystemExit(0)
        if len(args) >= 5 and args[:2] == ["plugin", "enable"] and args[3:] == ["--scope", "user"]:
            ref = args[2]
            if scenario == "enable-fails" and ref == "code@closedloop-ai":
                raise SystemExit(1)
            if scenario == "enable-still-disabled" and ref == "code@closedloop-ai":
                raise SystemExit(0)
            state = load_state()
            for entry in state["list"]:
                if entry.get("id") == ref and entry.get("scope") == "user":
                    entry["enabled"] = True
            save_state(state)
            raise SystemExit(0)
        if len(args) >= 5 and args[:2] == ["plugin", "uninstall"] and args[3:] == ["--scope", "project"]:
            ref = args[2]
            state = load_state()
            state["list"] = [entry for entry in state["list"] if not (entry.get("id") == ref and entry.get("scope") == "project")]
            save_state(state)
            raise SystemExit(0)

        raise SystemExit(f"unexpected fake claude call: {args}")
        ''',
    )


def run_installer(tmp_path: Path, scenario: str = "") -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    home_dir = tmp_path / "home"
    bin_dir.mkdir()
    home_dir.mkdir()
    write_fake_jq(bin_dir)
    write_fake_claude(bin_dir)
    env = {
        **os.environ,
        "FAKE_CLAUDE_LOG": str(tmp_path / "claude.log"),
        "FAKE_CLAUDE_SCENARIO": scenario,
        "FAKE_CLAUDE_STATE": str(tmp_path / "state.json"),
        "HOME": str(home_dir),
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
        "TMPDIR": str(tmp_path),
    }
    return subprocess.run(
        ["/bin/bash", str(INSTALL_SCRIPT)],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )


def seed_project_entry(tmp_path: Path, project_path: Path | None) -> None:
    state_path = tmp_path / "state.json"
    entry = {
        "id": "code@closedloop-ai",
        "scope": "project",
        "version": "0.9.0",
    }
    if project_path is not None:
        entry["projectPath"] = str(project_path)
    state_path.write_text(json.dumps({"list": [entry]}))


def read_log(tmp_path: Path) -> str:
    return (tmp_path / "claude.log").read_text()


def test_installs_runtime_plugins_at_user_scope(tmp_path: Path) -> None:
    result = run_installer(tmp_path)

    assert result.returncode == 0, result.stderr
    log = read_log(tmp_path)
    assert "claude plugin marketplace update closedloop-ai" in log
    for plugin in PLUGINS:
        assert f"claude plugin install {plugin}@closedloop-ai --scope user" in log
    assert "bootstrap@closedloop-ai" not in log


def test_fails_when_marketplace_refresh_fails(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="marketplace-update-fails")

    assert result.returncode != 0
    combined = f"{result.stdout}\n{result.stderr}"
    assert "Marketplace refresh failed" in combined
    assert "cannot refresh marketplace" in combined


def test_repairs_project_scoped_plugin_from_project_path(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    seed_project_entry(tmp_path, project_path)

    result = run_installer(tmp_path)

    assert result.returncode == 0, result.stderr
    log = read_log(tmp_path)
    assert f"{project_path}::claude plugin uninstall code@closedloop-ai --scope project" in log


def test_warns_for_project_scoped_plugin_without_project_path(tmp_path: Path) -> None:
    seed_project_entry(tmp_path, None)

    result = run_installer(tmp_path)

    assert result.returncode == 0, result.stderr
    combined = f"{result.stdout}\n{result.stderr}"
    assert "without a usable projectPath" in combined
    assert 'claude plugin uninstall "code@closedloop-ai" --scope project' in combined


def test_enables_disabled_user_scoped_plugin_after_install(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="disabled-success")

    assert result.returncode == 0, result.stderr
    log = read_log(tmp_path)
    assert "claude plugin enable code@closedloop-ai --scope user" in log


def test_fails_when_enable_command_fails(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="enable-fails")

    assert result.returncode != 0
    combined = f"{result.stdout}\n{result.stderr}"
    assert "claude plugin enable code@closedloop-ai --scope user" in read_log(tmp_path)
    assert "Repair ClosedLoop plugins at user scope" in combined


def test_fails_when_enable_reread_still_reports_disabled(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="enable-still-disabled")

    assert result.returncode != 0
    combined = f"{result.stdout}\n{result.stderr}"
    assert "claude plugin enable code@closedloop-ai --scope user" in read_log(tmp_path)
    assert "Plugin remains disabled after enable: code@closedloop-ai" in combined
    assert "Repair ClosedLoop plugins at user scope" in combined


def test_fails_when_user_scoped_registry_entry_is_missing(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="no-user-entry")

    assert result.returncode != 0
    combined = f"{result.stdout}\n{result.stderr}"
    assert "Missing user-scoped registry entry with existing installPath: code@closedloop-ai" in combined
    assert "Repair ClosedLoop plugins at user scope" in combined


def test_fails_when_final_enabled_state_check_is_unavailable(tmp_path: Path) -> None:
    result = run_installer(tmp_path, scenario="final-list-fails")

    assert result.returncode != 0
    combined = f"{result.stdout}\n{result.stderr}"
    assert "Could not read final Claude plugin list for enabled-state verification" in combined
    assert "Could not verify final enabled state for required plugin: code@closedloop-ai" in combined
    assert "Repair ClosedLoop plugins at user scope" in combined
