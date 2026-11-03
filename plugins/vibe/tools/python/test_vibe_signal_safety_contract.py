"""Signal safety checks (operator incident, 2026-10-21).

A plugin test recorded pid 1 for a helper and then stopped it. The stop path
group-killed the recorded pid, so it ran kill(-1), which signals every process
the user owns, and every app on the operator's laptop died, twice.

1. No plugin test passes 0, 1, a negative literal, its own pid or its parent's
   pid to a call that sends a signal, writes such a pid into a `pids` ledger,
   or calls `endProcesses` without injecting a fake `kill`.
2. No plugin source signals a process group (`process.kill(-x)`, `kill(-x)`,
   `kill -- -x`) unless `x` is checked above 1 on the lines just before it.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
WORKERS_SOURCE = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src"
SOURCE_SUFFIXES = (".mjs", ".js", ".cjs", ".ts", ".sh", ".zsh", ".bash")
GUARD_WINDOW = 8
UNARY_BEFORE = set("?:(,=!&|[{;")
IDENTIFIER = r"[A-Za-z_$][\w$.]*"
JS_KILL = re.compile(r"(?<![\w$])kill\(")
NEGATED = re.compile(r"-\s*(" + IDENTIFIER + r"|\d+)")
SHELL_GROUP = re.compile(r"\bkill\b[^;&|\n()]*?\s-[\"']?\$\{?(\w+)|\bkill\b[^;&|\n()]*?\s--\s+-(\d+)")
SHELL_UNSAFE = re.compile(r"\bkill\b(?:\s+-[A-Za-z0-9]+)*(?:\s+\"?\$\$\"?|\s+\"?\$PPID\"?|\s+[01]\b|\s+--\s+-?\d+)")
COMMENT = re.compile(r"(?:^|\s)(?://|/\*|#|\*)")
UNSAFE_PID = re.compile(r"^\s*(?:-\s*\d+|[01])\s*$|process\.p?pid")
UNSAFE_LEDGER = re.compile(r"pids\s*:\s*\[[^\]]*(?:process\.p?pid|(?<![\w.])-?\s*[01](?![\w.]))")


def _sources() -> list[Path]:
    return [path for root in (PLUGIN_ROOT, WORKERS_SOURCE) for path in sorted(root.rglob("*"))
            if path.is_file() and path.suffix in SOURCE_SUFFIXES
            and "node_modules" not in path.parts and "dist" not in path.parts]


def _tests() -> list[Path]:
    return [path for path in _sources() if ".test." in path.name]


def _call_args(text: str, open_paren: int) -> list[str]:
    """Top-level arguments of the call whose `(` is at `open_paren`."""
    depth, start, args = 0, open_paren + 1, []
    for index in range(open_paren, len(text)):
        char = text[index]
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
            if depth == 0:
                args.append(text[start:index])
                return [arg.strip() for arg in args]
        elif char == "," and depth == 1:
            args.append(text[start:index])
            start = index + 1
    return [arg.strip() for arg in args]


def _in_comment(text: str, at: int) -> bool:
    """Whether `at` follows a `//`, `/*`, `#` or doc-comment `*` on its line, so prose naming kill(-1) is not a call."""
    return COMMENT.search(text[text.rfind("\n", 0, at) + 1:at]) is not None


def _negated_targets(arg: str) -> list[str]:
    """Each operand a unary minus is applied to in a kill target, such as `pid` in `group ? -pid : pid`."""
    targets = []
    for match in NEGATED.finditer(arg):
        before = arg[:match.start()].rstrip()
        if not before or before[-1] in UNARY_BEFORE:
            targets.append(match.group(1))
    return targets


def _guarded(text: str, at: int, target: str, shell: bool) -> bool:
    if target.isdigit():
        return False
    line_start = text.rfind("\n", 0, at) + 1
    window_start = line_start
    for _ in range(GUARD_WINDOW):
        window_start = text.rfind("\n", 0, max(window_start - 1, 0)) + 1
        if window_start == 0:
            break
    window = text[window_start:at]
    name = re.escape(target.rstrip("!"))
    if shell:
        guard = r"\$\{?" + name + r"\}?\"?\s+-(?:gt\s+1|ge\s+2|le\s+1|lt\s+2)\b"
    else:
        guard = r"(?<![\w$.])" + name + r"!?\s*(?:>\s*1\b|>=\s*2\b|<=\s*1\b|<\s*2\b)"
    return re.search(guard, window) is not None


def group_kill_offenders(text: str) -> list[str]:
    """Group signals whose target is not checked above 1 just before the call."""
    offenders = []
    for match in JS_KILL.finditer(text):
        if _in_comment(text, match.start()):
            continue
        args = _call_args(text, match.end() - 1)
        for target in _negated_targets(args[0] if args else ""):
            if not _guarded(text, match.start(), target, shell=False):
                offenders.append(f"kill(-{target})")
    for match in SHELL_GROUP.finditer(text):
        if _in_comment(text, match.start()):
            continue
        target = match.group(1) or match.group(2)
        if not _guarded(text, match.start(), target, shell=True):
            offenders.append(f"kill -{target}")
    return offenders


def unsafe_test_signals(text: str) -> list[str]:
    """Signals a test sends, or sets up, to pid 0 or 1, a negative literal, or its own or parent pid."""
    offenders = []
    for match in JS_KILL.finditer(text):
        if not text[:match.start()].endswith("process.") or _in_comment(text, match.start()):
            continue
        args = _call_args(text, match.end() - 1)
        if len(args) > 1 and args[1] == "0":
            continue
        if args and UNSAFE_PID.search(args[0]):
            offenders.append(f"process.kill({args[0]})")
    offenders += [f"shell {match.group(0)}" for match in SHELL_UNSAFE.finditer(text)]
    offenders += [f"ledger {match.group(0)}" for match in UNSAFE_LEDGER.finditer(text)]
    for match in re.finditer(r"(?<![\w$])endProcesses\(", text):
        call = ",".join(_call_args(text, match.end() - 1))
        if not re.search(r"\bkill\s*:", call):
            offenders.append("endProcesses without an injected kill")
    return offenders


def test_no_plugin_test_signals_pid_1_or_lower_or_itself() -> None:
    offenders = [f"{path.relative_to(PLUGIN_ROOT.parents[1])}: {found}"
                 for path in _tests() for found in unsafe_test_signals(path.read_text())]
    assert offenders == []


def test_no_plugin_source_signals_a_group_it_did_not_check_above_1() -> None:
    offenders = [f"{path.relative_to(PLUGIN_ROOT.parents[1])}: {found}"
                 for path in _sources() for found in group_kill_offenders(path.read_text())]
    assert offenders == []


def test_the_scans_catch_the_shapes_that_killed_every_process() -> None:
    for unsafe in ("process.kill(1, 'SIGTERM');", "process.kill(0, 'SIGKILL');", "process.kill(-1, 'SIGTERM');",
                   "process.kill(process.pid, 'SIGKILL');", "process.kill(process.ppid, 'SIGTERM');",
                   "kill -9 $$", "kill -TERM -- -1", "kill 0", "kill -KILL \"$PPID\"",
                   "JSON.stringify({ a: { pids: [process.pid] } })", "{ pids: [1] }", "{ pids: [4242, 0] }",
                   "await endProcesses([{ pid }], 0);"):
        assert unsafe_test_signals(unsafe), unsafe
    for safe in ("process.kill(pid, 0);", "process.kill(process.pid, 0);", "process.kill(child.pid, 'SIGKILL');",
                 "{ pids: [left, 12] }", "await endProcesses(unsafe, 0, { kill: fake.kill });", "kill -0 \"$pid\"",
                 "// process.kill(-1) would signal every process the user owns."):
        assert unsafe_test_signals(safe) == [], safe

    for unguarded in ("process.kill(-pid, 'SIGTERM');", "process.kill(-child.pid, signal);",
                      "kill(group ? -pid : pid, name);", "process.kill(-1, 'SIGKILL');",
                      "kill -TERM -- -\"$pgid\"", "kill -- -$pid", "process.kill(- pid, 'SIGTERM');",
                      "if (pid > 1) log();\n" + "\n" * GUARD_WINDOW + "process.kill(-pid, 'SIGTERM');"):
        assert group_kill_offenders(unguarded), unguarded
    for guarded in ("if (!(pid > 1)) return;\nprocess.kill(-pid, 'SIGTERM');",
                    "if (child.pid > 1) process.kill(-child.pid, 'SIGKILL');",
                    "if (!child.pid || child.pid <= 1) return;\nprocess.kill(-child.pid, signal);",
                    "if (!(pid > 1)) return;\nconst whole = true;\nkill(whole ? -pid : pid, name);",
                    "[ \"$pgid\" -gt 1 ] || exit 1\nkill -TERM -- -\"$pgid\"",
                    "process.kill(pid, 'SIGTERM');", "kill(total - pid, 0);", "kill -9 \"$pid\"", "kill -0 \"$(cat \"$dir/pid\")\"",
                    "  // kill(-1) would signal every process the user owns.", "# never kill -- -$pid",
                    "/** kill(-1) reaches every process the user owns. */"):
        assert group_kill_offenders(guarded) == [], guarded
