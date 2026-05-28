"""Tests for harness/registry.py.

Covers:
- register/get_adapter with a fake adapter class (AC-005)
- Successful registration and lookup
- get_adapter("nonexistent") raises a clear, actionable error naming registered keys (AC-005)
- HarnessAdapter ABC enforcement: TypeError on instantiation of incomplete subclass (AC-001)

Uses a table-driven (pytest.mark.parametrize) approach throughout.
Shared adapter classes (FakeAdapter/AnotherFakeAdapter via _FakeAdapterClass /
_AnotherFakeAdapterClass) and pytest fixtures are defined in conftest.py.
"""

from __future__ import annotations

import pytest

from harness.adapter import HarnessAdapter
from harness.registry import _REGISTRY, get_adapter, register
from harness.types import (
    Command,
    InvocationRequest,
    TerminalFailure,
    TurnResult,
)


# ---------------------------------------------------------------------------
# Helpers: registry isolation
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_registry():
    """Save and restore the registry state around each test for isolation."""
    snapshot = dict(_REGISTRY)
    yield
    _REGISTRY.clear()
    _REGISTRY.update(snapshot)


# ---------------------------------------------------------------------------
# ABC enforcement: TypeError on incomplete subclass (AC-001)
# ---------------------------------------------------------------------------
# Define incomplete subclasses at module level so parametrize can reference them.


class _MissingAllMethods(HarnessAdapter):
    """Subclass that implements none of the six abstract methods."""

    name = "missing-all"


class _MissingFiveMethods(HarnessAdapter):
    """Subclass that implements only supports(), omitting five methods."""

    name = "missing-five"

    def supports(self, command: Command) -> bool:
        return True


class _MissingOneLast(HarnessAdapter):
    """Subclass that omits only classify_terminal_failure."""

    name = "missing-one"

    def supports(self, command: Command) -> bool:
        return True

    def build_entry_prompt(
        self,
        workdir: str,
        prompt_name: str,
        prd: str,
        add_dirs: list[str],
    ) -> str:
        return ""

    def build_argv(self, request: InvocationRequest) -> list[str]:
        return []

    def parse_session_id(self, raw_output: str) -> str | None:
        return None

    def parse_turn_result(self, raw_output: str) -> TurnResult:
        return TurnResult(result_text=raw_output, is_error=False)


ABC_ENFORCEMENT_CASES = [
    ("missing all six methods", _MissingAllMethods),
    ("missing five methods", _MissingFiveMethods),
    ("missing only classify_terminal_failure", _MissingOneLast),
]


@pytest.mark.parametrize("description,incomplete_cls", ABC_ENFORCEMENT_CASES)
def test_incomplete_subclass_raises_type_error(description: str, incomplete_cls) -> None:
    """Python raises TypeError when instantiating an incomplete HarnessAdapter subclass (AC-001)."""
    with pytest.raises(TypeError):
        incomplete_cls()


# ---------------------------------------------------------------------------
# register / get_adapter: successful registration and lookup (AC-005)
# ---------------------------------------------------------------------------


def test_register_returns_the_class(FakeAdapter) -> None:
    """register() returns the same class so it can be used as a decorator."""
    result = register(FakeAdapter)
    assert result is FakeAdapter


def test_register_stores_under_name_attribute(FakeAdapter) -> None:
    """register() keys the adapter under its .name attribute."""
    register(FakeAdapter)
    assert _REGISTRY.get(FakeAdapter.name) is FakeAdapter


def test_get_adapter_returns_registered_class(FakeAdapter) -> None:
    """get_adapter(name) returns the class that was registered under that name."""
    register(FakeAdapter)
    result = get_adapter(FakeAdapter.name)
    assert result is FakeAdapter


def test_register_multiple_adapters_coexist(FakeAdapter, AnotherFakeAdapter) -> None:
    """Multiple distinct adapters can coexist in the registry under different names."""
    register(FakeAdapter)
    register(AnotherFakeAdapter)
    assert get_adapter(FakeAdapter.name) is FakeAdapter
    assert get_adapter(AnotherFakeAdapter.name) is AnotherFakeAdapter


def test_register_overwrites_existing_entry(FakeAdapter) -> None:
    """Registering a new class under the same name replaces the old entry."""

    class ReplacementAdapter(HarnessAdapter):
        name = FakeAdapter.name  # reuse the same key

        def supports(self, command: Command) -> bool:
            return False

        def build_entry_prompt(self, workdir, prompt_name, prd, add_dirs) -> str:
            return ""

        def build_argv(self, request: InvocationRequest) -> list[str]:
            return []

        def parse_session_id(self, raw_output: str) -> str | None:
            return None

        def parse_turn_result(self, raw_output: str) -> TurnResult:
            return TurnResult(result_text=raw_output, is_error=False)

        def classify_terminal_failure(self, raw_output, stderr, exit_code) -> TerminalFailure:
            return TerminalFailure(status="EXIT", subcode="NON_ZERO_EXIT", message=stderr)

    register(FakeAdapter)
    register(ReplacementAdapter)
    assert get_adapter(FakeAdapter.name) is ReplacementAdapter


def test_register_as_class_decorator(FakeAdapter) -> None:
    """register() can be applied as a class decorator and returns the class unchanged."""

    @register
    class DecoratedAdapter(HarnessAdapter):
        name = "decorated"

        def supports(self, command: Command) -> bool:
            return True

        def build_entry_prompt(self, workdir, prompt_name, prd, add_dirs) -> str:
            return ""

        def build_argv(self, request: InvocationRequest) -> list[str]:
            return []

        def parse_session_id(self, raw_output: str) -> str | None:
            return None

        def parse_turn_result(self, raw_output: str) -> TurnResult:
            return TurnResult(result_text=raw_output, is_error=False)

        def classify_terminal_failure(self, raw_output, stderr, exit_code) -> TerminalFailure:
            return TerminalFailure(status="EXIT", subcode="NON_ZERO_EXIT", message=stderr)

    assert get_adapter("decorated") is DecoratedAdapter


# ---------------------------------------------------------------------------
# get_adapter("nonexistent") raises actionable KeyError (AC-005)
# ---------------------------------------------------------------------------

# Each case: (names_to_register, lookup_name, expected_substrings_in_error)
ERROR_MESSAGE_CASES = [
    (["fake"], "missing", ["fake"]),
    (["fake", "another-fake"], "unknown", ["fake", "another-fake"]),
    ([], "anything", ["(none)"]),
]


@pytest.mark.parametrize("registered_names,lookup_name,expected_substrings", ERROR_MESSAGE_CASES)
def test_get_adapter_error_message_content(
    FakeAdapter, AnotherFakeAdapter, registered_names: list[str], lookup_name: str, expected_substrings: list[str]
) -> None:
    """get_adapter error message contains expected substrings for different registry states (AC-005)."""
    name_to_cls = {
        FakeAdapter.name: FakeAdapter,
        AnotherFakeAdapter.name: AnotherFakeAdapter,
    }
    _REGISTRY.clear()
    for name in registered_names:
        _REGISTRY[name] = name_to_cls[name]

    with pytest.raises(KeyError) as exc_info:
        get_adapter(lookup_name)

    error_message = str(exc_info.value)
    for substring in expected_substrings:
        assert substring in error_message, (
            f"Expected {substring!r} in error message, got: {error_message!r}"
        )
