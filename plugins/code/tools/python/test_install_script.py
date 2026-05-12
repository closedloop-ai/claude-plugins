import os
import subprocess
import sys
import textwrap
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
INSTALL_SH = REPO_ROOT / "install.sh"
ALL_PLUGIN_REFS = [
    "bootstrap@closedloop-ai",
    "code@closedloop-ai",
    "code-review@closedloop-ai",
    "judges@closedloop-ai",
    "platform@closedloop-ai",
    "self-learning@closedloop-ai",
]
REQUIRED_PLUGIN_REFS = [
    "code@closedloop-ai",
    "code-review@closedloop-ai",
    "judges@closedloop-ai",
    "platform@closedloop-ai",
    "self-learning@closedloop-ai",
]


def write_executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def install_stub_tools(tmp_path: Path) -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    state_file = tmp_path / "plugins.json"
    state_file.write_text("{}")

    write_executable(
        bin_dir / "python3",
        "#!/usr/bin/env bash\nprintf '3.13\\n'\n",
    )
    write_executable(
        bin_dir / "jq",
        textwrap.dedent(
            f"""\
            #!{sys.executable}
            import json
            import sys

            args = sys.argv[1:]
            raw = sys.stdin.read()
            try:
                data = json.loads(raw) if raw.strip() else []
            except json.JSONDecodeError:
                data = []

            if "-e" in args:
                name = None
                if "--arg" in args:
                    index = args.index("--arg")
                    if len(args) > index + 2 and args[index + 1] == "name":
                        name = args[index + 2]
                sys.exit(0 if any(item.get("name") == name for item in data) else 1)

            for item in data:
                enabled = item.get("enabled")
                state = "enabled" if enabled is True else "disabled" if enabled is False else "unknown"
                print(f"{{item['id']}} {{item.get('version', 'unknown')}} {{state}}")
            """
        ),
    )
    write_executable(
        bin_dir / "claude",
        textwrap.dedent(
            f"""\
            #!{sys.executable}
            import json
            import os
            import sys

            state_file = {str(state_file)!r}
            all_plugins = {ALL_PLUGIN_REFS!r}

            def load():
                with open(state_file, "r", encoding="utf-8") as handle:
                    return json.load(handle)

            def save(state):
                with open(state_file, "w", encoding="utf-8") as handle:
                    json.dump(state, handle)

            args = sys.argv[1:]
            if args == ["--version"]:
                print("1.5.0")
                raise SystemExit(0)
            if args == ["plugin", "marketplace", "list", "--json"]:
                print("[]")
                raise SystemExit(0)
            if args[:3] == ["plugin", "marketplace", "add"]:
                raise SystemExit(0)
            if len(args) >= 3 and args[:2] == ["plugin", "install"]:
                ref = args[2]
                if ref == os.environ.get("TEST_FAIL_INSTALL"):
                    raise SystemExit(1)
                state = load()
                state[ref] = {{
                    "id": ref,
                    "version": "1.0.0",
                    "enabled": ref != os.environ.get("TEST_DISABLED_ON_INSTALL"),
                }}
                save(state)
                raise SystemExit(0)
            if len(args) >= 3 and args[:2] == ["plugin", "update"]:
                ref = args[2]
                if ref == os.environ.get("TEST_FAIL_INSTALL"):
                    raise SystemExit(1)
                state = load()
                state.setdefault(ref, {{"id": ref, "version": "1.0.0", "enabled": True}})
                save(state)
                raise SystemExit(0)
            if len(args) >= 3 and args[:2] == ["plugin", "enable"]:
                ref = args[2]
                if ref == os.environ.get("TEST_ENABLE_FAIL"):
                    raise SystemExit(1)
                state = load()
                if ref in state:
                    state[ref]["enabled"] = True
                save(state)
                raise SystemExit(0)
            if args == ["plugin", "list", "--json"]:
                state = load()
                print(json.dumps([state[ref] for ref in all_plugins if ref in state]))
                raise SystemExit(0)

            print(f"unexpected claude args: {{args}}", file=sys.stderr)
            raise SystemExit(2)
            """
        ),
    )
    return bin_dir


def run_install(
    tmp_path: Path, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    bin_dir = install_stub_tools(tmp_path)
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
        "TMPDIR": str(tmp_path),
        **(extra_env or {}),
    }
    return subprocess.run(
        ["bash", str(INSTALL_SH)],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_install_script_succeeds_when_all_required_plugins_are_enabled(
    tmp_path: Path,
) -> None:
    result = run_install(tmp_path)

    assert result.returncode == 0, result.stderr
    assert "Required plugins ready" in result.stdout


def test_install_script_enables_disabled_required_plugin(tmp_path: Path) -> None:
    result = run_install(
        tmp_path,
        {"TEST_DISABLED_ON_INSTALL": "code@closedloop-ai"},
    )

    assert result.returncode == 0, result.stderr
    assert "Enabled: code" in result.stdout


def test_install_script_exits_nonzero_when_enable_fails(tmp_path: Path) -> None:
    result = run_install(
        tmp_path,
        {
            "TEST_DISABLED_ON_INSTALL": "code@closedloop-ai",
            "TEST_ENABLE_FAIL": "code@closedloop-ai",
        },
    )

    assert result.returncode != 0
    assert "Required plugin is not enabled: code@closedloop-ai" in result.stdout


def test_install_script_exits_nonzero_when_required_plugin_is_missing(
    tmp_path: Path,
) -> None:
    result = run_install(
        tmp_path,
        {"TEST_FAIL_INSTALL": "code@closedloop-ai"},
    )

    assert result.returncode != 0
    assert "Required plugin is not enabled: code@closedloop-ai" in result.stdout


def test_install_script_does_not_require_bootstrap_when_missing(tmp_path: Path) -> None:
    result = run_install(
        tmp_path,
        {"TEST_FAIL_INSTALL": "bootstrap@closedloop-ai"},
    )

    assert result.returncode == 0, result.stderr
    assert (
        "Required plugin is not enabled: bootstrap@closedloop-ai" not in result.stdout
    )


def test_install_script_does_not_require_bootstrap_when_enable_fails(
    tmp_path: Path,
) -> None:
    result = run_install(
        tmp_path,
        {
            "TEST_DISABLED_ON_INSTALL": "bootstrap@closedloop-ai",
            "TEST_ENABLE_FAIL": "bootstrap@closedloop-ai",
        },
    )

    assert result.returncode == 0, result.stderr
    assert (
        "Required plugin is not enabled: bootstrap@closedloop-ai" not in result.stdout
    )
