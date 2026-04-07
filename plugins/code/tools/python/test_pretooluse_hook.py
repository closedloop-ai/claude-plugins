"""Tests for pretooluse-hook.sh security blocklist and self-learning guard."""

import json
import subprocess
from pathlib import Path

import pytest

HOOK_PATH = Path(__file__).resolve().parent.parent.parent / "hooks" / "pretooluse-hook.sh"


def run_hook(tool_name: str, tool_input: dict) -> subprocess.CompletedProcess:
    """Invoke pretooluse-hook.sh with a crafted JSON payload."""
    payload = json.dumps(
        {
            "tool_name": tool_name,
            "tool_input": tool_input,
            "session_id": "test-session",
            "cwd": "/tmp",
        }
    )
    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
    )


def run_hook_with_session(
    tool_name: str,
    tool_input: dict,
    cwd: str,
    session_id: str = "test-session",
    env_overrides: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Invoke pretooluse-hook.sh with a session-mapped CWD for self-learning tests."""
    payload = json.dumps(
        {
            "tool_name": tool_name,
            "tool_input": tool_input,
            "session_id": session_id,
            "cwd": cwd,
        }
    )
    env = dict(env_overrides) if env_overrides else {}
    import os

    env.setdefault("PATH", os.environ.get("PATH", "/usr/bin:/bin"))
    env.setdefault("HOME", os.environ.get("HOME", "/tmp"))

    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=payload,
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


def assert_denied(result: subprocess.CompletedProcess) -> None:
    """Assert the hook returned a deny decision."""
    assert result.returncode == 0, f"Hook exited with {result.returncode}: {result.stderr}"
    assert result.stdout.strip(), "Expected deny JSON output but got empty stdout"
    output = json.loads(result.stdout.strip())
    decision = output["hookSpecificOutput"]["permissionDecision"]
    assert decision == "deny", f"Expected 'deny' but got '{decision}'"
    assert output["hookSpecificOutput"]["hookEventName"] == "PreToolUse"


def assert_not_denied(result: subprocess.CompletedProcess) -> None:
    """Assert the hook did NOT return a deny decision."""
    assert result.returncode == 0, f"Hook exited with {result.returncode}: {result.stderr}"
    stdout = result.stdout.strip()
    if not stdout:
        return  # No output means no deny — pass
    # Could be an allow or additionalContext response; just verify it's not deny
    try:
        output = json.loads(stdout)
        decision = output.get("hookSpecificOutput", {}).get("permissionDecision")
        assert decision != "deny", "Hook unexpectedly denied the command"
    except json.JSONDecodeError:
        pass  # Non-JSON output is not a deny


class TestSecurityBlocklist:
    """Tests for the credential theft blocklist in pretooluse-hook.sh."""

    def test_blocks_keychain_access(self) -> None:
        """Deny security find-generic-password (macOS Keychain extraction)."""
        result = run_hook("Bash", {"command": 'security find-generic-password -wa "Chrome Safe Storage"'})
        assert_denied(result)

    def test_blocks_keychain_find_internet(self) -> None:
        """Deny security find-internet-password."""
        result = run_hook("Bash", {"command": "security find-internet-password -s example.com"})
        assert_denied(result)

    def test_blocks_keychain_dump(self) -> None:
        """Deny security dump-keychain."""
        result = run_hook("Bash", {"command": "security dump-keychain login.keychain"})
        assert_denied(result)

    def test_blocks_chrome_cookies_bash(self) -> None:
        """Deny Bash commands referencing Chrome profile directories."""
        result = run_hook(
            "Bash",
            {"command": "cp ~/Library/Application Support/Google/Chrome/Default/Cookies /tmp/cookies.db"},
        )
        assert_denied(result)

    def test_blocks_firefox_profile(self) -> None:
        """Deny Bash commands referencing Firefox profiles."""
        result = run_hook(
            "Bash",
            {"command": "ls ~/.mozilla/firefox/"},
        )
        assert_denied(result)

    def test_blocks_safari_cookies(self) -> None:
        """Deny Bash commands referencing Safari cookie store."""
        result = run_hook(
            "Bash",
            {"command": "cp ~/Library/Safari/Cookies/Cookies.binarycookies /tmp/"},
        )
        assert_denied(result)

    def test_blocks_sqlite_cookies(self) -> None:
        """Deny sqlite3 commands targeting browser Cookies database."""
        result = run_hook(
            "Bash",
            {"command": "sqlite3 ~/Library/Application\\ Support/Google/Chrome/Default/Cookies 'SELECT * FROM cookies'"},
        )
        assert_denied(result)

    def test_blocks_sqlite_login_data(self) -> None:
        """Deny sqlite3 commands targeting browser Login Data."""
        result = run_hook(
            "Bash",
            {"command": 'sqlite3 "Login Data" "SELECT * FROM logins"'},
        )
        assert_denied(result)

    def test_blocks_ssh_key_read(self) -> None:
        """Deny Read tool targeting SSH private keys."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.ssh/id_rsa"})
        assert_denied(result)

    def test_blocks_ssh_key_ed25519(self) -> None:
        """Deny Read tool targeting ed25519 SSH keys."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.ssh/id_ed25519"})
        assert_denied(result)

    def test_blocks_ssh_key_bash(self) -> None:
        """Deny Bash commands reading SSH private keys."""
        result = run_hook("Bash", {"command": "cat ~/.ssh/id_rsa"})
        assert_denied(result)

    def test_blocks_aws_credentials_read(self) -> None:
        """Deny Read tool targeting AWS credentials file."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.aws/credentials"})
        assert_denied(result)

    def test_blocks_aws_credentials_bash(self) -> None:
        """Deny Bash commands referencing AWS credentials."""
        result = run_hook("Bash", {"command": "cat ~/.aws/credentials"})
        assert_denied(result)

    def test_blocks_gcloud_print_token(self) -> None:
        """Deny gcloud auth print-access-token."""
        result = run_hook("Bash", {"command": "gcloud auth print-access-token"})
        assert_denied(result)

    def test_blocks_gcloud_adc(self) -> None:
        """Deny gcloud auth application-default."""
        result = run_hook("Bash", {"command": "gcloud auth application-default print-access-token"})
        assert_denied(result)

    def test_blocks_gcloud_credentials_db(self) -> None:
        """Deny Read on gcloud credentials.db."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.config/gcloud/credentials.db"})
        assert_denied(result)

    def test_blocks_chrome_login_data_read(self) -> None:
        """Deny Read on Chrome Login Data file."""
        result = run_hook("Read", {"file_path": "/Users/testuser/Library/Application Support/Google/Chrome/Default/Login Data"})
        assert_denied(result)

    def test_blocks_firefox_cookies_sqlite(self) -> None:
        """Deny Read on Firefox cookies.sqlite."""
        result = run_hook("Read", {"file_path": "/Users/testuser/Library/Application Support/Firefox/Profiles/abc123/cookies.sqlite"})
        assert_denied(result)

    def test_blocks_write_to_ssh_key(self) -> None:
        """Deny Write tool targeting SSH private keys."""
        result = run_hook("Write", {"file_path": "/Users/testuser/.ssh/id_rsa", "content": "malicious"})
        assert_denied(result)

    def test_blocks_brave_browser(self) -> None:
        """Deny Bash commands referencing Brave browser profiles."""
        result = run_hook(
            "Bash",
            {"command": "cp ~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies /tmp/"},
        )
        assert_denied(result)

    def test_blocks_edge_browser(self) -> None:
        """Deny Bash commands referencing Edge browser profiles."""
        result = run_hook(
            "Bash",
            {"command": "ls ~/Library/Application Support/Microsoft Edge/Default/"},
        )
        assert_denied(result)

    def test_blocks_gcloud_adc_json_read(self) -> None:
        """Deny Read on gcloud application_default_credentials.json."""
        result = run_hook(
            "Read",
            {"file_path": "/Users/testuser/.config/gcloud/application_default_credentials.json"},
        )
        assert_denied(result)

    def test_blocks_exfiltration_via_workspace(self) -> None:
        """Deny credential theft even when output targets .closedloop-ai/ workspace."""
        result = run_hook(
            "Bash",
            {"command": "cp ~/.ssh/id_rsa .closedloop-ai/loot"},
        )
        assert_denied(result)

    def test_blocks_keychain_via_workspace(self) -> None:
        """Deny keychain access even when piped to .closedloop-ai/ path."""
        result = run_hook(
            "Bash",
            {"command": "security find-generic-password -wa Chrome > .closedloop-ai/key.txt"},
        )
        assert_denied(result)

    def test_blocks_gcloud_adc_json_bash(self) -> None:
        """Deny Bash cat of gcloud application_default_credentials.json."""
        result = run_hook(
            "Bash",
            {"command": "cat ~/.config/gcloud/application_default_credentials.json"},
        )
        assert_denied(result)

    def test_blocks_gcloud_credentials_db_bash(self) -> None:
        """Deny Bash sqlite3 on gcloud credentials.db."""
        result = run_hook(
            "Bash",
            {"command": "sqlite3 ~/.config/gcloud/credentials.db 'SELECT * FROM credentials'"},
        )
        assert_denied(result)

    def test_blocks_gcloud_legacy_creds_bash(self) -> None:
        """Deny Bash access to gcloud legacy_credentials."""
        result = run_hook(
            "Bash",
            {"command": "cat ~/.config/gcloud/legacy_credentials/user@example.com/adc.json"},
        )
        assert_denied(result)


class TestAllowLegitimateCommands:
    """Ensure the blocklist does not produce false positives."""

    def test_allows_normal_bash(self) -> None:
        """npm run build should not be denied."""
        result = run_hook("Bash", {"command": "npm run build"})
        assert_not_denied(result)

    def test_allows_normal_read(self) -> None:
        """Read on a .ts file should not be denied."""
        result = run_hook("Read", {"file_path": "/Users/testuser/project/src/app.ts"})
        assert_not_denied(result)

    def test_allows_closedloop_workspace(self) -> None:
        """Bash command referencing .closedloop-ai/ should get allow (fast-path)."""
        result = run_hook("Bash", {"command": "cat /tmp/project/.closedloop-ai/learnings/patterns.toon"})
        assert_not_denied(result)
        stdout = result.stdout.strip()
        if stdout:
            output = json.loads(stdout)
            decision = output.get("hookSpecificOutput", {}).get("permissionDecision")
            assert decision == "allow", f"Expected 'allow' for .closedloop-ai/ path but got '{decision}'"

    def test_allows_ssh_config(self) -> None:
        """Read on ~/.ssh/config should not be denied (not a secret)."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.ssh/config"})
        assert_not_denied(result)

    def test_allows_ssh_known_hosts(self) -> None:
        """Read on ~/.ssh/known_hosts should not be denied."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.ssh/known_hosts"})
        assert_not_denied(result)

    def test_allows_aws_config(self) -> None:
        """Read on ~/.aws/config should not be denied (region/profile info)."""
        result = run_hook("Read", {"file_path": "/Users/testuser/.aws/config"})
        assert_not_denied(result)

    def test_allows_env_command(self) -> None:
        """env/printenv commands should not be denied."""
        result = run_hook("Bash", {"command": "env | grep NODE_ENV"})
        assert_not_denied(result)

    def test_allows_printenv(self) -> None:
        """printenv should not be denied."""
        result = run_hook("Bash", {"command": "printenv HOME"})
        assert_not_denied(result)

    def test_allows_sqlite3_non_browser(self) -> None:
        """sqlite3 on non-browser databases should not be denied."""
        result = run_hook("Bash", {"command": "sqlite3 /tmp/app.db 'SELECT * FROM users'"})
        assert_not_denied(result)

    def test_allows_git_operations(self) -> None:
        """Normal git commands should not be denied."""
        result = run_hook("Bash", {"command": "git status"})
        assert_not_denied(result)


@pytest.fixture()
def session_env(tmp_path: Path) -> tuple[Path, Path, str]:
    """Create temp CWD with session mapping and workdir with config.env.

    Returns (cwd, workdir, session_id).
    """
    session_id = "test-session-sl"
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"

    # Create session mapping: CWD/.closedloop-ai/session-$SESSION_ID.workdir -> workdir
    session_dir = cwd / ".closedloop-ai"
    session_dir.mkdir(parents=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    # Create workdir with config.env (self-learning disabled)
    closedloop_dir = workdir / ".closedloop"
    closedloop_dir.mkdir(parents=True)
    (closedloop_dir / "config.env").write_text("CLOSEDLOOP_SELF_LEARNING=false\n")

    # Create .learnings dir (hook expects it for debug log)
    (workdir / ".learnings").mkdir(parents=True)

    return cwd, workdir, session_id


class TestSelfLearningOff:
    """Tests that pretooluse-hook.sh exits cleanly when self-learning is disabled."""

    def test_exits_zero_when_disabled(self, session_env: tuple[Path, Path, str]) -> None:
        """Hook exits 0 when CLOSEDLOOP_SELF_LEARNING=false."""
        cwd, _workdir, session_id = session_env
        result = run_hook_with_session(
            "Bash", {"command": "npm run build"}, str(cwd), session_id
        )
        assert result.returncode == 0

    def test_no_pattern_injection_when_disabled(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Hook produces no additionalContext / systemPromptSuffix when disabled."""
        cwd, _workdir, session_id = session_env
        result = run_hook_with_session(
            "Bash", {"command": "npm run build"}, str(cwd), session_id
        )
        assert result.returncode == 0
        stdout = result.stdout.strip()
        # Should be empty -- no pattern injection
        assert stdout == "", f"Expected empty stdout but got: {stdout}"

    def test_write_tool_no_injection_when_disabled(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Write tool also produces no output when disabled."""
        cwd, _workdir, session_id = session_env
        result = run_hook_with_session(
            "Write", {"file_path": "/tmp/test.ts", "content": "x"}, str(cwd), session_id
        )
        assert result.returncode == 0
        assert result.stdout.strip() == ""

    def test_security_blocklist_still_fires_when_disabled(
        self, session_env: tuple[Path, Path, str]
    ) -> None:
        """Security blocklist runs before self-learning guard -- still denies credentials."""
        cwd, _workdir, session_id = session_env
        result = run_hook_with_session(
            "Bash",
            {"command": "security find-generic-password -wa Chrome"},
            str(cwd),
            session_id,
        )
        assert_denied(result)






def test_ignores_legacy_home_patterns(session_env: tuple[Path, Path, str]) -> None:
    """Should not inject patterns from legacy `~/.claude/.learnings`."""
    cwd, workdir, session_id = session_env
    (workdir / ".closedloop" / "config.env").write_text(
        "CLOSEDLOOP_SELF_LEARNING=true\n"
    )

    home_dir = workdir / "legacy-home"
    legacy_dir = home_dir / ".claude" / ".learnings"
    legacy_dir.mkdir(parents=True)
    (legacy_dir / "org-patterns.toon").write_text(
        "# TOON\npatterns[\n"
        "  p1,testing,\"Legacy pattern\",high,5,0.8,\"\",*,\"test context\"\n"
        "]\n"
    )

    result = run_hook_with_session(
        "Bash",
        {"command": "npm run build"},
        str(cwd),
        session_id,
        env_overrides={"HOME": str(home_dir)},
    )

    assert result.returncode == 0
    assert result.stdout.strip() == ""

def test_injects_when_only_plain_awk_is_available(session_env: tuple[Path, Path, str]) -> None:
    """Should continue injecting tool learnings when only plain awk is available."""
    cwd, workdir, session_id = session_env
    (workdir / ".closedloop" / "config.env").write_text(
        "CLOSEDLOOP_SELF_LEARNING=true\n"
    )

    home_dir = workdir / "plain-awk-home"
    patterns_dir = home_dir / ".closedloop-ai" / "learnings"
    patterns_dir.mkdir(parents=True)
    (patterns_dir / "org-patterns.toon").write_text(
        "# TOON\npatterns[\n"
        "  p1,testing,\"Build pattern\",high,5,0.8,\"\",*,\"build context\"\n"
        "]\n"
    )

    result = run_hook_with_session(
        "Bash",
        {"command": "npm run build"},
        str(cwd),
        session_id,
        env_overrides={"HOME": str(home_dir), "PATH": "/usr/bin:/bin"},
    )

    assert result.returncode == 0, f"Hook failed: {result.stderr}"
    output = json.loads(result.stdout.strip())
    ctx = output["hookSpecificOutput"]["additionalContext"]
    assert "<tool-learnings tool=\"Bash\">" in ctx
    assert "Build pattern" in ctx
