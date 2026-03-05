"""Tests for amend_state.py module."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

from amend_state import (
    add_message,
    add_pending_change,
    apply_changes,
    clear_pending_changes,
    get_conversation_context,
    load_state,
    save_state,
)


@pytest.fixture
def tmp_state_file(tmp_path: Path) -> Path:
    """Return path to a temporary state file."""
    return tmp_path / "amend-session.json"


@pytest.fixture
def tmp_run_dir(tmp_path: Path) -> Path:
    """Create a temporary run directory with required files."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    # Create implementation-plan.md
    plan = run_dir / "implementation-plan.md"
    plan.write_text("# Implementation Plan\n\n## Task 001\nDo something\n")

    # Create state.json
    state_file = run_dir / "state.json"
    state_file.write_text(json.dumps({"phase": "COMPLETE", "artifacts": []}))

    # Create reviews directory with a review file
    reviews_dir = run_dir / "reviews"
    reviews_dir.mkdir()
    (reviews_dir / "security.review.json").write_text(json.dumps({"issues": []}))

    return run_dir


class TestLoadState:
    """Tests for load_state function."""

    def test_creates_new_state_when_file_missing(self, tmp_state_file: Path) -> None:
        """Should create new state when file doesn't exist."""
        state = load_state(tmp_state_file, "/some/run/dir")

        assert state["version"] == "1.0"
        assert state["run_dir"] == "/some/run/dir"
        assert state["status"] == "discussing"
        assert state["conversation"] == []
        assert state["pending_changes"] == []
        assert "created_at" in state

    def test_loads_existing_state(self, tmp_state_file: Path) -> None:
        """Should load existing state from file."""
        existing = {
            "version": "1.0",
            "run_dir": "/existing/run",
            "status": "discussing",
            "conversation": [{"role": "user", "content": "hello"}],
            "pending_changes": [],
            "created_at": "2024-01-01T00:00:00",
        }
        tmp_state_file.write_text(json.dumps(existing))

        state = load_state(tmp_state_file)

        assert state["run_dir"] == "/existing/run"
        assert len(state["conversation"]) == 1
        assert state["conversation"][0]["content"] == "hello"


class TestSaveState:
    """Tests for save_state function."""

    def test_saves_state_to_file(self, tmp_state_file: Path) -> None:
        """Should save state to file."""
        state = {"version": "1.0", "status": "discussing"}

        save_state(tmp_state_file, state)

        assert tmp_state_file.exists()
        loaded = json.loads(tmp_state_file.read_text())
        assert loaded["version"] == "1.0"
        assert "updated_at" in loaded

    def test_creates_parent_directories(self, tmp_path: Path) -> None:
        """Should create parent directories if needed."""
        state_file = tmp_path / "nested" / "dir" / "state.json"
        state = {"version": "1.0"}

        save_state(state_file, state)

        assert state_file.exists()


class TestAddMessage:
    """Tests for add_message function."""

    def test_adds_user_message(self) -> None:
        """Should add user message to conversation."""
        state: Dict[str, Any] = {"conversation": []}

        result = add_message(state, "user", "hello")

        assert len(result["conversation"]) == 1
        assert result["conversation"][0]["role"] == "user"
        assert result["conversation"][0]["content"] == "hello"
        assert "timestamp" in result["conversation"][0]

    def test_adds_assistant_message(self) -> None:
        """Should add assistant message to conversation."""
        state: Dict[str, Any] = {"conversation": []}

        result = add_message(state, "assistant", "hi there")

        assert result["conversation"][0]["role"] == "assistant"
        assert result["conversation"][0]["content"] == "hi there"

    def test_appends_to_existing_conversation(self) -> None:
        """Should append to existing conversation."""
        state: Dict[str, Any] = {
            "conversation": [{"role": "user", "content": "first", "timestamp": "t1"}]
        }

        result = add_message(state, "assistant", "second")

        assert len(result["conversation"]) == 2
        assert result["conversation"][1]["content"] == "second"


class TestAddPendingChange:
    """Tests for add_pending_change function."""

    def test_adds_change_without_task_id(self) -> None:
        """Should add change without task ID."""
        state: Dict[str, Any] = {"pending_changes": []}

        result = add_pending_change(state, "Keep the splash screen call")

        assert len(result["pending_changes"]) == 1
        assert result["pending_changes"][0]["description"] == "Keep the splash screen call"
        assert result["pending_changes"][0]["task_id"] is None
        assert "discussed_at" in result["pending_changes"][0]

    def test_adds_change_with_task_id(self) -> None:
        """Should add change with task ID."""
        state: Dict[str, Any] = {"pending_changes": []}

        result = add_pending_change(state, "Update caching", "task-003")

        assert result["pending_changes"][0]["task_id"] == "task-003"

    def test_appends_to_existing_changes(self) -> None:
        """Should append to existing pending changes."""
        state: Dict[str, Any] = {
            "pending_changes": [{"description": "first", "task_id": None}]
        }

        result = add_pending_change(state, "second")

        assert len(result["pending_changes"]) == 2


class TestClearPendingChanges:
    """Tests for clear_pending_changes function."""

    def test_clears_all_changes(self) -> None:
        """Should clear all pending changes."""
        state: Dict[str, Any] = {
            "pending_changes": [
                {"description": "one"},
                {"description": "two"},
            ]
        }

        result = clear_pending_changes(state)

        assert result["pending_changes"] == []


@pytest.fixture
def tmp_json_workdir(tmp_path: Path) -> Path:
    """Create a temporary workdir with plan.json (experimental workflow)."""
    workdir = tmp_path / "work"
    workdir.mkdir()

    # Create plan.json
    plan = workdir / "plan.json"
    plan.write_text(json.dumps({
        "content": "# Implementation Plan\n\n## Task T-1.1\nDo something\n",
        "acceptanceCriteria": [],
        "pendingTasks": [{"id": "T-1.1", "description": "Do something", "acceptanceCriteria": []}],
        "completedTasks": [],
        "openQuestions": [],
        "answeredQuestions": [],
        "gaps": [],
    }, indent=2))

    # Create plan.md
    plan_md = workdir / "plan.md"
    plan_md.write_text("# Implementation Plan\n\n## Task T-1.1\nDo something\n")

    # Create reviews directory with a review file
    reviews_dir = workdir / "reviews"
    reviews_dir.mkdir()
    (reviews_dir / "security.review.json").write_text(json.dumps({"issues": []}))

    return workdir


class TestApplyChanges:
    """Tests for apply_changes function."""

    def test_keeps_plan_as_implementation_plan_md(self, tmp_run_dir: Path) -> None:
        """Should keep plan as implementation-plan.md (no rename to draft)."""
        state: Dict[str, Any] = {"pending_changes": [{"description": "test change"}]}

        result = apply_changes(tmp_run_dir, state)

        assert result["applied"] is True
        assert result["plan_file"] == str(tmp_run_dir / "implementation-plan.md")
        # Plan should still exist as implementation-plan.md
        assert (tmp_run_dir / "implementation-plan.md").exists()
        # No draft should be created
        assert not (tmp_run_dir / "implementation-plan.draft.md").exists()

    def test_records_amendment_in_state_json(self, tmp_run_dir: Path) -> None:
        """Should record amendment metadata in state.json."""
        state: Dict[str, Any] = {"pending_changes": [{"description": "test"}], "conversation": []}

        apply_changes(tmp_run_dir, state)

        run_state = json.loads((tmp_run_dir / "state.json").read_text())
        assert "amended" in run_state
        assert run_state["amended"]["changes"] == ["test"]
        assert "timestamp" in run_state["amended"]

    def test_preserves_conversation_in_state_json(self, tmp_run_dir: Path) -> None:
        """Should preserve conversation history in state.json amended field."""
        state: Dict[str, Any] = {
            "pending_changes": [{"description": "test"}],
            "conversation": [
                {"role": "user", "content": "make this change", "timestamp": "t1"},
                {"role": "assistant", "content": "done", "timestamp": "t2"},
            ],
        }

        apply_changes(tmp_run_dir, state)

        run_state = json.loads((tmp_run_dir / "state.json").read_text())
        assert run_state["amended"]["conversation"] == state["conversation"]

    def test_clears_old_reviews(self, tmp_run_dir: Path) -> None:
        """Should delete old review files."""
        state: Dict[str, Any] = {"pending_changes": []}

        # Verify review exists before apply
        assert (tmp_run_dir / "reviews" / "security.review.json").exists()

        apply_changes(tmp_run_dir, state)

        # Review should be deleted
        assert not (tmp_run_dir / "reviews" / "security.review.json").exists()

    def test_updates_amend_state_status(self, tmp_run_dir: Path) -> None:
        """Should update amend state status to applied."""
        state: Dict[str, Any] = {
            "pending_changes": [{"description": "change1"}],
            "status": "discussing",
        }

        apply_changes(tmp_run_dir, state)

        assert state["status"] == "applied"
        assert state["pending_changes"] == []

    def test_deletes_state_file_on_apply(self, tmp_run_dir: Path, tmp_state_file: Path) -> None:
        """Should delete the amend session state file after successful apply."""
        state: Dict[str, Any] = {"pending_changes": [], "conversation": []}
        save_state(tmp_state_file, state)

        assert tmp_state_file.exists()

        result = apply_changes(tmp_run_dir, state, tmp_state_file)

        assert result["applied"] is True
        assert result["state_file_deleted"] is True
        assert not tmp_state_file.exists()

    def test_does_not_delete_state_file_if_not_provided(self, tmp_run_dir: Path) -> None:
        """Should not fail if state_file is not provided."""
        state: Dict[str, Any] = {"pending_changes": []}

        result = apply_changes(tmp_run_dir, state)

        assert result["applied"] is True
        assert result["state_file_deleted"] is False

    def test_returns_error_if_no_final_plan(self, tmp_path: Path) -> None:
        """Should return error if implementation-plan.md doesn't exist."""
        run_dir = tmp_path / "empty_run"
        run_dir.mkdir()
        state: Dict[str, Any] = {"pending_changes": []}

        result = apply_changes(run_dir, state)

        assert result["applied"] is False
        assert "error" in result

    def test_assistant_response_recoverable_after_apply(
        self, tmp_run_dir: Path, tmp_state_file: Path
    ) -> None:
        """Simulates full workflow: response saved, apply called, response still extractable.

        This test validates the critical behavior that the GitHub workflow depends on:
        1. User message is added
        2. Assistant response is saved to state file
        3. Apply is called (which deletes the state file)
        4. The assistant's response can still be extracted from state.json

        This is exactly what the GitHub workflow does in the 'Post Amend Response' step.
        """
        # Step 1: Create initial state and save to file
        state = load_state(tmp_state_file, str(tmp_run_dir))

        # Step 2: Add user message
        state = add_message(state, "user", "for task 001, don't remove the SplashScreen call")
        save_state(tmp_state_file, state)

        # Step 3: Add assistant response (this is what Claude does before apply)
        assistant_response = "Updated task-001 to keep the SplashScreen.setLoadingInfo call. Re-running validation now."
        state = add_message(state, "assistant", assistant_response)
        save_state(tmp_state_file, state)

        # Step 4: Add pending change and apply
        state = add_pending_change(state, "Keep SplashScreen.setLoadingInfo call", "task-001")
        save_state(tmp_state_file, state)

        # Verify state file exists before apply
        assert tmp_state_file.exists()

        # Step 5: Apply changes (this deletes the state file)
        result = apply_changes(tmp_run_dir, state, tmp_state_file)

        # Step 6: Verify state file is deleted
        assert result["applied"] is True
        assert not tmp_state_file.exists()

        # Step 7: Verify we can extract the assistant's response from state.json
        # This is what the GitHub workflow does
        run_state = json.loads((tmp_run_dir / "state.json").read_text())
        assert "amended" in run_state
        assert "conversation" in run_state["amended"]

        # Extract last assistant message (like the workflow does with jq)
        conversation = run_state["amended"]["conversation"]
        assistant_messages = [m for m in conversation if m["role"] == "assistant"]
        assert len(assistant_messages) > 0
        last_assistant_message = assistant_messages[-1]["content"]

        # Verify the response is the one we saved
        assert last_assistant_message == assistant_response

    def test_json_format_records_amendment_in_plan_json(
        self, tmp_json_workdir: Path
    ) -> None:
        """Should record amendment in plan.json amendments array for JSON format."""
        state: Dict[str, Any] = {
            "pending_changes": [{"description": "Keep splash screen call"}],
            "conversation": [
                {"role": "user", "content": "keep the splash screen", "timestamp": "t1"},
                {"role": "assistant", "content": "done", "timestamp": "t2"},
            ],
        }

        result = apply_changes(tmp_json_workdir, state, plan_format="json")

        assert result["applied"] is True
        assert result["plan_file"] == str(tmp_json_workdir / "plan.json")

        # Check plan.json has amendments
        plan = json.loads((tmp_json_workdir / "plan.json").read_text())
        assert "amendments" in plan
        assert len(plan["amendments"]) == 1
        assert plan["amendments"][0]["changes"] == ["Keep splash screen call"]
        assert "timestamp" in plan["amendments"][0]
        assert plan["amendments"][0]["conversation"] == state["conversation"]

    def test_json_format_clears_reviews(self, tmp_json_workdir: Path) -> None:
        """Should clear old review files for JSON format."""
        state: Dict[str, Any] = {"pending_changes": [], "conversation": []}

        # Verify review exists before apply
        assert (tmp_json_workdir / "reviews" / "security.review.json").exists()

        apply_changes(tmp_json_workdir, state, plan_format="json")

        # Review should be deleted
        assert not (tmp_json_workdir / "reviews" / "security.review.json").exists()

    def test_json_format_deletes_state_file(
        self, tmp_json_workdir: Path, tmp_state_file: Path
    ) -> None:
        """Should delete state file after apply for JSON format."""
        state: Dict[str, Any] = {"pending_changes": [], "conversation": []}
        save_state(tmp_state_file, state)

        assert tmp_state_file.exists()

        result = apply_changes(tmp_json_workdir, state, tmp_state_file, plan_format="json")

        assert result["applied"] is True
        assert result["state_file_deleted"] is True
        assert not tmp_state_file.exists()

    def test_json_format_error_if_no_plan_json(self, tmp_path: Path) -> None:
        """Should return error if plan.json doesn't exist for JSON format."""
        workdir = tmp_path / "empty_workdir"
        workdir.mkdir()
        state: Dict[str, Any] = {"pending_changes": []}

        result = apply_changes(workdir, state, plan_format="json")

        assert result["applied"] is False
        assert "error" in result
        assert "plan.json" in result["error"]

    def test_json_format_appends_to_existing_amendments(
        self, tmp_json_workdir: Path
    ) -> None:
        """Should append to existing amendments array in plan.json."""
        # Add existing amendment
        plan_file = tmp_json_workdir / "plan.json"
        plan = json.loads(plan_file.read_text())
        plan["amendments"] = [
            {"timestamp": "2024-01-01T00:00:00", "changes": ["previous change"], "conversation": []}
        ]
        plan_file.write_text(json.dumps(plan, indent=2))

        state: Dict[str, Any] = {
            "pending_changes": [{"description": "new change"}],
            "conversation": [],
        }

        apply_changes(tmp_json_workdir, state, plan_format="json")

        plan = json.loads(plan_file.read_text())
        assert len(plan["amendments"]) == 2
        assert plan["amendments"][0]["changes"] == ["previous change"]
        assert plan["amendments"][1]["changes"] == ["new change"]


class TestGetConversationContext:
    """Tests for get_conversation_context function."""

    def test_formats_conversation(self) -> None:
        """Should format conversation for display."""
        state = {
            "conversation": [
                {"role": "user", "content": "hello", "timestamp": "t1"},
                {"role": "assistant", "content": "hi there", "timestamp": "t2"},
                {"role": "user", "content": "thanks", "timestamp": "t3"},
            ]
        }

        context = get_conversation_context(state)

        assert "User: hello" in context
        assert "Assistant: hi there" in context
        assert "User: thanks" in context

    def test_handles_empty_conversation(self) -> None:
        """Should handle empty conversation."""
        state: Dict[str, Any] = {"conversation": []}

        context = get_conversation_context(state)

        assert context == ""


class TestCLI:
    """Tests for CLI interface."""

    def test_load_command(self, tmp_state_file: Path) -> None:
        """Should load state via CLI."""
        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "load",
                "--state-file",
                str(tmp_state_file),
                "--run-dir",
                "/test/run",
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["run_dir"] == "/test/run"
        assert output["status"] == "discussing"

    def test_add_message_command(self, tmp_state_file: Path) -> None:
        """Should add message via CLI."""
        # First create initial state
        save_state(tmp_state_file, {"conversation": [], "pending_changes": []})

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "add-message",
                "--state-file",
                str(tmp_state_file),
                "--role",
                "user",
                "--content",
                "test message",
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert len(output["conversation"]) == 1
        assert output["conversation"][0]["content"] == "test message"

    def test_add_change_command(self, tmp_state_file: Path) -> None:
        """Should add pending change via CLI."""
        save_state(tmp_state_file, {"conversation": [], "pending_changes": []})

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "add-change",
                "--state-file",
                str(tmp_state_file),
                "--description",
                "Keep splash screen call",
                "--task-id",
                "task-001",
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert len(output["pending_changes"]) == 1
        assert output["pending_changes"][0]["task_id"] == "task-001"

    def test_apply_command(self, tmp_run_dir: Path, tmp_state_file: Path) -> None:
        """Should apply changes via CLI and delete state file."""
        save_state(
            tmp_state_file,
            {
                "conversation": [],
                "pending_changes": [{"description": "test change"}],
                "status": "discussing",
            },
        )

        assert tmp_state_file.exists()

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "apply",
                "--state-file",
                str(tmp_state_file),
                "--run-dir",
                str(tmp_run_dir),
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["applied"] is True
        assert output["state_file_deleted"] is True

        # Verify plan stays as implementation-plan.md (no rename to draft)
        assert (tmp_run_dir / "implementation-plan.md").exists()
        assert not (tmp_run_dir / "implementation-plan.draft.md").exists()

        # Verify state file was deleted
        assert not tmp_state_file.exists()

    def test_context_command(self, tmp_state_file: Path) -> None:
        """Should get conversation context via CLI."""
        save_state(
            tmp_state_file,
            {
                "conversation": [
                    {"role": "user", "content": "hello", "timestamp": "t1"},
                    {"role": "assistant", "content": "hi", "timestamp": "t2"},
                ],
                "pending_changes": [],
            },
        )

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "context",
                "--state-file",
                str(tmp_state_file),
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        assert "User: hello" in result.stdout
        assert "Assistant: hi" in result.stdout

    def test_clear_changes_command(self, tmp_state_file: Path) -> None:
        """Should clear pending changes via CLI."""
        save_state(
            tmp_state_file,
            {
                "conversation": [],
                "pending_changes": [{"description": "to be cleared"}],
            },
        )

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "clear-changes",
                "--state-file",
                str(tmp_state_file),
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["pending_changes"] == []

    def test_apply_command_with_plan_format_json(
        self, tmp_json_workdir: Path, tmp_state_file: Path
    ) -> None:
        """Should apply changes to plan.json via CLI with --plan-format json."""
        save_state(
            tmp_state_file,
            {
                "conversation": [{"role": "user", "content": "test", "timestamp": "t1"}],
                "pending_changes": [{"description": "test change"}],
                "status": "discussing",
            },
        )

        assert tmp_state_file.exists()

        result = subprocess.run(
            [
                sys.executable,
                "amend_state.py",
                "apply",
                "--state-file",
                str(tmp_state_file),
                "--run-dir",
                str(tmp_json_workdir),
                "--plan-format",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=Path(__file__).parent,
        )

        assert result.returncode == 0
        output = json.loads(result.stdout)
        assert output["applied"] is True
        assert "plan.json" in output["plan_file"]

        # Verify amendment was recorded in plan.json
        plan = json.loads((tmp_json_workdir / "plan.json").read_text())
        assert "amendments" in plan
        assert len(plan["amendments"]) == 1
        assert plan["amendments"][0]["changes"] == ["test change"]

        # Verify state file was deleted
        assert not tmp_state_file.exists()
