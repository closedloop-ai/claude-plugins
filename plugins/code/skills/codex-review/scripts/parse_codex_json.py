#!/usr/bin/env python3
"""Extract a completed Codex review from UTF-8 JSONL without losing old feedback."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def extract(source: Path, feedback: Path) -> str:
    messages: list[str] = []
    thread_id = ""
    completed = False
    line_number = 0
    with source.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"JSONL line {line_number}: {exc.msg}") from exc
            if not isinstance(event, dict):
                raise TypeError(f"JSONL line {line_number}: event must be an object")
            kind = event.get("type")
            if kind == "thread.started" and isinstance(event.get("thread_id"), str):
                thread_id = event["thread_id"]
            elif kind == "item.completed":
                item = event.get("item")
                if not isinstance(item, dict):
                    raise ValueError(f"JSONL line {line_number}: item must be an object")
                if item.get("type") == "agent_message":
                    message = item.get("text")
                    if not isinstance(message, str):
                        raise ValueError(f"JSONL line {line_number}: agent text must be a string")
                    if message:
                        messages.append(message)
            elif kind == "turn.completed":
                completed = True

    if not completed:
        raise ValueError(f"JSONL ended after line {line_number} without turn.completed")
    if not messages:
        raise ValueError("completed JSONL contains no agent message")

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
    """Recover an already-started session without accepting partial feedback."""
    try:
        with source.open("r", encoding="utf-8") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    return ""
                if isinstance(event, dict) and event.get("type") == "thread.started":
                    thread_id = event.get("thread_id")
                    return thread_id if isinstance(thread_id, str) else ""
    except (OSError, UnicodeError):
        pass
    return ""


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: parse_codex_json.py JSONL FEEDBACK", file=sys.stderr)
        return 2
    source, feedback = map(Path, sys.argv[1:])
    try:
        thread_id = extract(source, feedback)
    except (OSError, UnicodeError, TypeError, ValueError) as exc:
        sys.stdout.buffer.write(session_from_partial(source).encode("utf-8"))
        print(f"feedback extraction failed from {source}: {exc}", file=sys.stderr)
        return 2
    # Codex session IDs are ASCII. Avoid the host's stdout encoding for the payload.
    sys.stdout.buffer.write(thread_id.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
