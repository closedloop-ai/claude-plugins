"""
HarnessAdapter abstract base class.

Subclasses must implement all six abstract methods plus declare a ``name``
class variable. Failing to implement any abstract method causes Python to
raise ``TypeError`` at instantiation time.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar

from harness.types import (
    AdapterName,
    Command,
    InvocationRequest,
    TerminalFailure,
    TurnResult,
)


class HarnessAdapter(ABC):
    """Abstract contract every harness implementation must satisfy.

    Class-level attributes
    ----------------------
    name : AdapterName
        Registry key used by ``register()`` / ``get_adapter()``. Constrained to
        the closed ``AdapterName`` set so every production adapter registers
        under a known runner name rather than an arbitrary string.

    Abstract methods
    ----------------
    supports(command)
        Return True if this adapter can handle the given Command.
    build_entry_prompt(workdir, prompt_name, prd, add_dirs)
        Return the string prompt to pass to the harness as the entry message.
    build_argv(request)
        Return the list of CLI arguments to invoke the harness subprocess.
    parse_session_id(raw_output)
        Extract the session identifier from raw harness stdout.
    parse_turn_result(raw_output)
        Parse raw harness stdout into a TurnResult.
    classify_terminal_failure(raw_output, stderr, exit_code)
        Classify a failed harness invocation as a TerminalFailure.
    """

    name: ClassVar[AdapterName]

    @abstractmethod
    def supports(self, command: Command) -> bool:
        """Return True if this adapter handles ``command``."""

    @abstractmethod
    def build_entry_prompt(
        self,
        workdir: str,
        prompt_name: str,
        prd: str,
        add_dirs: list[str],
    ) -> str:
        """Build the entry prompt string for the harness.

        Parameters
        ----------
        workdir:
            Absolute path to the working directory.
        prompt_name:
            Logical name of the prompt template to use.
        prd:
            PRD content to inject into the prompt.
        add_dirs:
            Additional directories to expose to the harness.
        """

    @abstractmethod
    def build_argv(self, request: InvocationRequest) -> list[str]:
        """Return the argument vector to invoke the harness subprocess."""

    @abstractmethod
    def parse_session_id(self, raw_output: str) -> str | None:
        """Extract the session identifier from the harness's raw stdout."""

    @abstractmethod
    def parse_turn_result(self, raw_output: str) -> TurnResult:
        """Parse the harness's raw stdout into a ``TurnResult``."""

    @abstractmethod
    def classify_terminal_failure(
        self,
        raw_output: str,
        stderr: str,
        exit_code: int,
    ) -> TerminalFailure:
        """Classify a failed invocation as a ``TerminalFailure``."""
