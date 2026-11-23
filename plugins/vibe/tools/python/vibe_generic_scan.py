"""Finds text in vibe's runtime files that belongs to one repository, tracker or organization.

vibe and fleet run in any repository. Everything specific to the ClosedLoop tracker, its graph and memory
services, or the symphony-alpha repository lives in the optional provider plugin, which vibe reads only when a
session is bound to it. This module is the one place that says what such text looks like, and it backs three
uses:

- the regression check (`check`): a runtime file of vibe, vibe-core or the vibe-workers sources that gains a
  gating line fails;
- the inventory (`scan`, `snapshot`): every matching line with its families, for the before/after record;
- the inventory diff (`diff`): every before row is still present (in the provider plugin, in a retained
  file, or in vibe) or is named in the mapping file with what replaced it.

Gating families are literal names. Semantic families (tracker words, PR body headings, environments, browser
harnesses, model ids) only describe rows for the inventory and never gate, because generic text uses those
words too.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

from test_vibe_no_person_names_contract import names_in

REPO = Path(__file__).resolve().parents[4]

# Underscores can wrap a Markdown ID. Keep underscores inside other plugin names and the desktop profile script.
WRONG_NAMESPACE = re.compile(
    r"(?<![\w-])_*vibe:(?!profile(?![a-z0-9-]))"
    r"""(?:[a-z0-9][a-z0-9-]*|<[a-z][a-z0-9-]*>|\$\{|["'`]\s*\+)"""
)
JS_SUFFIXES = {".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"}
JS_TEXT_TOKEN = re.compile(
    # At expression start a regex can contain quotes, backticks or braces that aren't JS text delimiters.
    r"(?P<regex>(?:(?<=[=(\[!,:;?&|>])|(?<=\breturn))\s*/(?![*/])"
    r"(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\[\n])+/[a-z]*)|"
    r'''//[^\n]*|/\*[\s\S]*?(?:\*/|\Z)|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|[`{}]'''
)
JS_TEMPLATE_PART = re.compile(r"(?:\\[\s\S]|\$(?!\{)|[^`\\$])*(?P<end>\$\{|`|\Z)")
JS_ADDITION = re.compile(r"(?:\s|//[^\n]*\n|/\*[\s\S]*?\*/)*\+(?![+=])")
JS_ESCAPE = re.compile(r"\\(?:\\|[fnrtv]|x[\da-fA-F]{2}|u(?:[\da-fA-F]{4}|\{[\da-fA-F]{1,6}\}))", re.ASCII)
# ECMAScript whitespace and line terminators, including the U+2000–U+200A space separators.
JS_WHITESPACE = {ord(char) for char in "\t\n\v\f\r \xa0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff"} | set(range(0x2000, 0x200B))

# Ordered: the first family that matches a line is its primary family.
GATING: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("skill-namespace", WRONG_NAMESPACE),
    ("machine", re.compile(r"/Users/[A-Za-z]|/home/[a-z][a-z0-9._-]*/|~/Source/|\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    ("graph", re.compile(
        r"closedloop-graph|clgraph|closedloop-intel|blast_radius_tickets|query_collisions|search_memory_facts"
        r"|\bsearch_nodes\b|\bticket_detail\b|\bquery_wip\b|\bquery_shipped\b|\breadonly_sql\b|\bgraph_query\b"
        r"|\bfts_search\b|\bsync_status\b|\bcode_(?:callers|importers|symbols|tests_for(?:_changes)?|snippet|grep"
        r"|architecture|projects)\b", re.I)),
    ("memory", re.compile(r"workflow-memory", re.I)),
    ("repo-identity", re.compile(r"symphony", re.I)),
    ("artifact-root", re.compile(r"\.closedloop-ai\b")),
    ("tracker-tool", re.compile(
        r"mcp__closedloop|app\.closedloop\.ai|closedloop-stage|CLOSEDLOOP_API|\bget-me\b|\bget_me\b|list-users"
        r"|list_users|update-document|update_document|create-document|create_document|get-document|get_document"
        r"|create-artifact-link|create_artifact_link|list-artifact-links|list_artifact_links|list-projects"
        r"|list_projects|upload-attachment|upload_attachment|create_branch_artifact|create-document-thread"
        r"|create_document_thread|tag-artifact|tag_artifact|list-tags|list_tags")),
    # vibe's own marketplace (`<plugin>@closedloop-ai`), publisher repository and the generic sibling plugin
    # closedloop-core are vibe's own packaging, not the tracker or the organization's repositories.
    ("organization", re.compile(r"(?<!@)closed[\s_-]?loop(?!-core\b)(?!-ai/claude-plugins\b)", re.I)),
    ("slug", re.compile(r"\b(?:ISS|PLN|PRD|FEA|PRO)-(?:\d+|\*|N+\b|<|\{|\$|\[|\\d)|\bPLN\b")),
    ("slug-regex", re.compile(r"\[A-Z\]\{?[+{2,]?[^\n]{0,8}-\\d|\(\?:(?:ISS|PRD|FEA|PLN|PRO)\||\b(?:ISS|PRD|FEA|PLN)\|(?:ISS|PRD|FEA|PLN)\b")),
    ("repo-path", re.compile(
        r"\b(?:apps|packages)(?:/|\\/)(?:app|api|desktop|web|prototypes|storybook|mcp|relay|realtime|doc-sync"
        r"|database|design-system|golden-sessions|loops-api|github|ai|cost)\b|@repo/")),
    ("repo-command", re.compile(
        r"loops-setup|pnpm control|pnpm vibe|just vibe|vibe-up\b|vibe-remote|e2e-slot|FEATURE_MAP|Vibe Seed Walk"
        r"|test:lanes|pnpm verify|check:source-gates|check:destructive|check:migration|pnpm prepush"
        r"|SKIP_PREPUSH_GATES|PREPUSH_GATE|\^24 \|\| >=26|cleanup-preview-schemas|green-ref|stage-migrated"
        r"|\.claude/design/")),
    ("repo-workflow", re.compile(r"e2e-test\.yml|vibe-environment\.yml|ci-batch|deploy-production\.yml|pr-metadata-gates|vibe-seed-walk")),
    # The repository's own skills and agents, by the names they are invoked by: a command (`/x`, `$x`), a quoted
    # name, or a repo agent file. vibe's own step names that contain the same words (its visual QA reference,
    # a question key) are not the repository's skills.
    ("repo-skill", re.compile(r"[/$](?:visual-qa|logical-qa|design-review)\b|`(?:visual-qa|logical-qa|design-review)`|metal-andrew"
                              r"|design-system-steward|\$control\b|`/control`")),
    ("identity", re.compile(r"\bclerk|CLERK_|\bAcme\b|\basana\b", re.I)),
)

SEMANTIC: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("tracker-words", re.compile(r"\b(?:IN_PROGRESS|IN_REVIEW|TRIAGE|BACKLOG|CANCELED)\b|live ticket|liveTicket|livePlan|\bPRD\b")),
    ("pr-body", re.compile(r"Feature map:|Breaking changes|UI Feature Flag|ui-flag|warning-acknowledged|pull_request_template")),
    ("environment", re.compile(r"\bvercel\b|posthog|seeded|vibe seed|seed refresh", re.I)),
    ("browser-harness", re.compile(r"electron|playwright|storybook|\bDesktop\b", re.I)),
    ("model", re.compile(r"gpt-5|claude-(?:opus|sonnet|haiku|fable)|CODEX_MODEL|CODEX_EFFORT|reasoning_effort")),
)

# Files the gate reads: vibe's and vibe-core's runtime files and the vibe-workers sources.
GATED_ROOTS = ("plugins/vibe", "plugins/vibe-core", "tools/vibe-workers/src")
# Files kept in vibe by operator ruling (the cl-* skills and the seed refresh with its three workers), the
# generated bundles (gated through their sources), tests and fixtures (they exercise both arms), evals, and the
# contract-test tooling that has to name what it looks for.
PROVIDER_AWARE = re.compile(r"^plugins/vibe/(?:skills/(?:cl-[a-z-]+|vibe-seed-refresh)/|agents/vibe-seed-(?:check|fix|pr)-worker\.md$)")
EXEMPT = re.compile(
    r"^plugins/vibe/(?:evals/|tools/python/)"
    r"|/dist/|\.test\.(?:mjs|cjs|js|ts)$|(?:^|/)test-fixtures?[^/]*\.(?:mjs|ts)$|-test-fixtures?\.(?:mjs|ts)$|-test-support\.(?:mjs|ts)$"
    r"|(?:^|/)(?:__tests__|fixtures?|tests?)/|\.fixture\.|(?:^|/)global-setup\.ts$|\.d\.mts$"
)
SKIPPED_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".lock"})
SKIPPED_DIRS = frozenset({"node_modules", "__pycache__", ".pytest_cache"})
# Plugin manifests of vibe, vibe-core and the provider, and both marketplaces. Publisher fields (author,
# homepage, repository and the like) name the publisher on purpose and stay; descriptions are prose and gate.
MANIFESTS = (
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
)
PUBLISHER_KEYS = ("author", "homepage", "repository", "developerName", "email", "websiteURL",
                  "privacyPolicyURL", "termsOfServiceURL", "name", "source", "path", "displayName")
PUBLISHER_FIELD = re.compile(r'^\s*"(?:' + "|".join(PUBLISHER_KEYS) + r')"\s*:')
JSON_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')

# Lines that name the publisher or a compatibility alias on purpose, each by its exact stripped text and the
# reason it stays. A line that changes no longer matches and gates again.
ALLOWED_LINES = Path(__file__).with_name("vibe_generic_allow.json")


def allowed_lines(path: Path = ALLOWED_LINES) -> dict[str, set[str]]:
    """{relative path: {exact stripped line}} from the allow file; every entry must carry a reason."""
    allowed: dict[str, set[str]] = {}
    for entry in json.loads(path.read_text(encoding="utf-8")):
        if not str(entry.get("reason", "")).strip():
            raise ValueError(f"allowed line without a reason: {entry}")
        allowed.setdefault(entry["path"], set()).add(entry["text"])
    return allowed


@dataclass(frozen=True)
class Row:
    path: str
    line: int
    families: tuple[str, ...]
    text: str

    @property
    def gating(self) -> bool:
        return any(family in GATING_NAMES for family in self.families)

    def digest(self) -> str:
        return text_digest(self.text)


GATING_NAMES = frozenset(name for name, _ in GATING)


def text_digest(text: str) -> str:
    """The digest a row's text is matched by: whitespace runs collapsed, then SHA-256, truncated."""
    return hashlib.sha256(re.sub(r"\s+", " ", text).strip().encode()).hexdigest()[:20]


def js_whitespace_boundary(match: re.Match[str]) -> str:
    """Expose whitespace to the namespace matcher while preserving literal backslash pairs and other escapes."""
    escape = match[0]
    if escape == r"\\":
        return escape
    if len(escape) == 2 or int(escape[2:].strip("{}"), 16) in JS_WHITESPACE:
        return " "
    return escape


def js_text_spans(source: str) -> Iterator[tuple[int, int]]:
    """Yield strings, comments and literal template parts. Substitution expressions resume code scanning."""
    offset = 0
    template = False
    braces: list[int] = []
    while offset < len(source):
        if template:
            part = JS_TEMPLATE_PART.match(source, offset)
            if part is None:
                break
            yield part.span()
            if part["end"] == "${":
                braces.append(0)
            template = False
            offset = part.end()
            continue
        token = JS_TEXT_TOKEN.search(source, offset)
        if token is None:
            break
        offset = token.end()
        if token.lastgroup == "regex":
            continue
        if token[0] == "`":
            template = True
        elif token[0] == "{":
            if braces:
                braces[-1] += 1
        elif token[0] == "}":
            if braces and braces[-1] == 0:
                braces.pop()
                template = True
            elif braces:
                braces[-1] -= 1
        else:
            yield token.span()


def js_namespace_lines(relative: str, lines: list[str]) -> set[int] | None:
    """Return source lines containing stale JS instructions, attributing concatenation to its prefix."""
    if Path(relative).suffix not in JS_SUFFIXES:
        return None
    hits: set[int] = set()
    source = "\n".join(lines)
    if "vibe:" not in source:
        return hits
    previous, number = 0, 1
    for start, end in js_text_spans(source):
        text = source[start:end]
        if "vibe:" not in text:
            continue
        number += source.count("\n", previous, start)
        previous = start
        if not text.startswith(("//", "/*")) and text.endswith(('"', "'", "`")) and JS_ADDITION.match(source, end):
            text += "+"
        for index, line in enumerate(text.split("\n"), number):
            if WRONG_NAMESPACE.search(JS_ESCAPE.sub(js_whitespace_boundary, line)):
                hits.add(index)
    return hits


def families(line: str, semantic: bool = True, *, namespace_hit: bool | None = None) -> tuple[str, ...]:
    found = []
    for name, pattern in GATING:
        match = namespace_hit if name == "skill-namespace" and namespace_hit is not None else pattern.search(line)
        if match:
            found.append(name)
    if names_in(line):
        found.append("people")
    if semantic:
        found.extend(name for name, pattern in SEMANTIC if pattern.search(line))
    return tuple(found)


def gated(relative: str) -> bool:
    """Whether the regression gate reads the file at repo-relative `relative`."""
    if relative in MANIFESTS:
        return True
    if not relative.startswith(tuple(f"{root}/" for root in GATED_ROOTS)):
        return False
    return EXEMPT.search(relative) is None and PROVIDER_AWARE.search(relative) is None


def walk(root: Path, tops: Iterable[str]) -> Iterator[str]:
    for top in tops:
        base = root / top
        if base.is_file():
            yield top
            continue
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_file() and not SKIPPED_DIRS.intersection(path.parts) and path.suffix.lower() not in SKIPPED_SUFFIXES:
                yield path.relative_to(root).as_posix()


def lines_of(root: Path, relative: str) -> list[str] | None:
    try:
        return (root / relative).read_bytes().decode("utf-8").split("\n")
    except (UnicodeDecodeError, IsADirectoryError):
        return None


def manifest_namespace_hits(lines: list[str], *, marketplace: bool) -> dict[int, list[str]] | None:
    """Map stale non-publisher string values to their source lines, or return None for malformed JSON."""
    try:
        # Ordered member pairs preserve every source token, including repeated keys. Arrays remain lists.
        document = json.loads("\n".join(lines), object_pairs_hook=tuple)
    except json.JSONDecodeError:
        return None

    # JSON strings occupy one physical line. Use tokens only to locate decoded keys and values.
    locations = (number for number, line in enumerate(lines, 1) for _ in JSON_STRING.finditer(line))
    hits: dict[int, list[str]] = {}

    def visit(value: object, path: str, exempt: bool) -> None:
        if isinstance(value, tuple):
            for key, child in value:
                next(locations)  # Skip the key's token.
                visit(child, f"{path}.{key}" if path else key, exempt or key in PUBLISHER_KEYS)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                # Only the generic distribution's entry promises to resolve generic skill IDs.
                other_plugin = (marketplace and path == "plugins" and isinstance(child, tuple)
                                and dict(child).get("name") != "vibe-generic")
                visit(child, f"{path}[{index}]", exempt or other_plugin)
        elif isinstance(value, str):
            number = next(locations)
            if not exempt and WRONG_NAMESPACE.search(value):
                hits.setdefault(number, []).append(f"{path}: {value}")

    visit(document, "", False)
    return hits


def scan(root: Path, tops: Iterable[str]) -> list[Row]:
    """Every line under `tops` (repo-relative) that matches a family, gating or semantic."""
    rows: list[Row] = []
    for relative in walk(root, tops):
        text = lines_of(root, relative)
        if text is None:
            continue
        js_hits = js_namespace_lines(relative, text)
        for number, line in enumerate(text, 1):
            found = families(line, namespace_hit=number in js_hits if js_hits is not None else None)
            if found:
                rows.append(Row(relative, number, found, line.strip()))
    return rows


def findings(root: Path = REPO) -> list[str]:
    """`path:line family: text` for each gating line in a gated file; empty when vibe is generic."""
    found: list[str] = []
    allowed = allowed_lines()
    tops = [*GATED_ROOTS, *MANIFESTS]
    for relative in walk(root, tops):
        # Provider-aware skills ship in the generic plugin. Only their namespace is checked.
        namespace_only = PROVIDER_AWARE.search(relative) is not None and EXEMPT.search(relative) is None
        if not namespace_only and not gated(relative):
            continue
        text = lines_of(root, relative)
        if text is None:
            continue
        manifest = relative.endswith("plugin.json") or relative in MANIFESTS
        manifest_hits = manifest_namespace_hits(text, marketplace=relative in MANIFESTS) if manifest else None
        js_hits = js_namespace_lines(relative, text)
        for number, line in enumerate(text, 1):
            if manifest_hits is not None:
                for detail in manifest_hits.get(number, ()):
                    found.append(f"{relative}:{number} skill-namespace: {detail[:160]}")
            if line.strip() in allowed.get(relative, ()) or (manifest and PUBLISHER_FIELD.search(line)):
                continue
            hit = families(line, semantic=False, namespace_hit=number in js_hits if js_hits is not None else None)
            if manifest_hits is not None:
                hit = tuple(family for family in hit if family != "skill-namespace")
            if namespace_only:
                hit = tuple(family for family in hit if family == "skill-namespace")
            if hit:
                found.append(f"{relative}:{number} {','.join(hit)}: {line.strip()[:160]}")
    return found


class Record(TypedDict):
    path: str
    line: int
    families: list[str]
    digest: str


def snapshot(rows: list[Row]) -> list[Record]:
    """The rows with their text replaced by its digest, so the record names no machine, person or literal."""
    return [{"path": row.path, "line": row.line, "families": list(row.families), "digest": row.digest()} for row in rows]


def present_digests(root: Path, tops: Iterable[str]) -> dict[str, set[str]]:
    """Digest of every line under `tops` mapped to the paths that hold it."""
    held: dict[str, set[str]] = {}
    for relative in walk(root, tops):
        for line in lines_of(root, relative) or []:
            if line.strip():
                held.setdefault(text_digest(line), set()).add(relative)
    return held


def diff(before: list[Record], root: Path, mapping: dict[str, str], tops: Iterable[str]) -> list[str]:
    """Before rows found neither in the tree under `tops` nor in `mapping` (digest to what replaced the row).

    A runtime row counts as kept only where runtime text lives (a gated file or the provider plugin), never because a
    test, fixture or eval still quotes it; a test or eval row may be kept anywhere."""
    held = present_digests(root, tops)
    runtime = {digest for digest, paths in held.items()
               if any(gated(path) or path.startswith("plugins/vibe-closedloop-provider/") for path in paths)}
    missing = []
    for row in before:
        digest = row["digest"]
        if digest in mapping or digest in (runtime if gated(row["path"]) else held):
            continue
        missing.append(f"{row['path']}:{row['line']} {','.join(row['families'])} {digest}")
    return missing


SCAN_TOPS = (*GATED_ROOTS, "tools/vibe-bench", "tools/vibe-release-smoke", "tools/shared", *MANIFESTS)
DIFF_TOPS = (*SCAN_TOPS, "plugins/vibe-closedloop-provider")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="vibe generic regression check and inventory")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    snap = sub.add_parser("snapshot")
    snap.add_argument("out")
    snap.add_argument("--root", default=str(REPO))
    changed = sub.add_parser("diff")
    changed.add_argument("before", help="a snapshot JSON file, or a checkout of the base commit to snapshot")
    changed.add_argument("--mapping", required=True)
    changed.add_argument("--root", default=str(REPO))
    args = parser.parse_args(argv)
    if args.command == "check":
        hits = findings()
        print("\n".join(hits) if hits else "vibe runtime files are generic")
        return 1 if hits else 0
    if args.command == "snapshot":
        rows = [row for row in scan(Path(args.root), SCAN_TOPS) if row.gating]
        Path(args.out).write_text(json.dumps(snapshot(rows), indent=0) + "\n")
        print(f"{len(rows)} gating rows")
        return 0
    base = Path(args.before)
    before: list[Record] = (snapshot([row for row in scan(base, SCAN_TOPS) if row.gating]) if base.is_dir()
                            else json.loads(base.read_text()))
    mapping = json.loads(Path(args.mapping).read_text())
    missing = diff(before, Path(args.root), mapping, DIFF_TOPS)
    print("\n".join(missing) if missing else f"all {len(before)} rows accounted for")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
