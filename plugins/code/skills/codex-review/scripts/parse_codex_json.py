#!/usr/bin/env python3
"""Extract a completed Codex review from UTF-8 JSONL without losing old feedback."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from collections.abc import Iterator

INCOMPLETE = 3  # exit status: the stream never completed a turn with an agent message


class IncompleteStream(ValueError):
    """The stream ended without turn.completed or without an agent message."""


def _events(stream) -> Iterator[tuple[int, dict]]:
    """Yield (line number, event) for each JSON object line.

    The stdout format belongs to the codex CLI, not to us: a blank line, a
    deprecation notice, or a progress line must not discard a completed review.
    Lines that are not JSON objects are skipped and counted on stderr. The
    completeness gate in extract() is what decides whether a review is usable.
    """
    ignored: list[int] = []
    for line_number, line in enumerate(stream, 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            ignored.append(line_number)
            continue
        if not isinstance(event, dict):
            ignored.append(line_number)
            continue
        yield line_number, event
    if ignored:
        shown = ", ".join(map(str, ignored[:10])) + (", ..." if len(ignored) > 10 else "")
        print(f"ignored {len(ignored)} non-event JSONL line(s): {shown}", file=sys.stderr)


def extract(source: Path, feedback: Path) -> str:
    messages: list[str] = []
    thread_id = ""
    completed = False
    line_number = 0
    with source.open("r", encoding="utf-8") as stream:
        for line_number, event in _events(stream):
            kind = event.get("type")
            if kind == "thread.started" and isinstance(event.get("thread_id"), str):
                thread_id = event["thread_id"]
            elif kind == "item.completed":
                item = event.get("item")
                if isinstance(item, dict) and item.get("type") == "agent_message":
                    message = item.get("text")
                    if isinstance(message, str) and message:
                        messages.append(message)
            elif kind == "turn.completed":
                completed = True

    if not completed:
        raise IncompleteStream(f"JSONL ended after line {line_number} without turn.completed")
    if not messages:
        raise IncompleteStream("completed JSONL contains no agent message")

    payload = "\n".join(messages).encode("utf-8")
    feedback.parent.mkdir(parents=True, exist_ok=True)
    staged: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".codex-feedback-", dir=feedback.parent, delete=False,
        ) as stream:
            staged = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staged, feedback)
        staged = None
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
    return thread_id


def session_from_partial(source: Path) -> str:
    """The thread a stream started, if any, without accepting partial feedback.

    An empty result means no thread.started event: nothing resumed and nothing
    was paid for, which is what makes a fresh-session fallback safe.
    """
    try:
        with source.open("r", encoding="utf-8", errors="replace") as stream:
            for _, event in _events(stream):
                if event.get("type") == "thread.started":
                    thread_id = event.get("thread_id")
                    return thread_id if isinstance(thread_id, str) else ""
    except OSError:
        pass
    return ""


def main() -> int:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--thread-id":
        sys.stdout.buffer.write(session_from_partial(Path(args[1])).encode("utf-8"))
        return 0
    if len(args) != 2 or args[0].startswith("--"):
        print("usage: parse_codex_json.py JSONL FEEDBACK | --thread-id JSONL", file=sys.stderr)
        return 2
    source, feedback = map(Path, args)
    try:
        thread_id = extract(source, feedback)
    except (OSError, UnicodeError, ValueError) as exc:
        sys.stdout.buffer.write(session_from_partial(source).encode("utf-8"))
        print(f"feedback extraction failed from {source}: {exc}", file=sys.stderr)
        return INCOMPLETE if isinstance(exc, IncompleteStream) else 2
    # Codex session IDs are ASCII. Avoid the host's stdout encoding for the payload.
    sys.stdout.buffer.write(thread_id.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
