"""End-to-end prefix golden harness (PLN-1229 Phase 0 / P0-A).

This is the *front-half* counterpart to ``golden_fixture_harness.py``. That
module snapshots the back half of the pipeline (``collect-findings`` →
``validate`` → ``finalize-result``); its docstring deferred the front half —
the deterministic prefix walk — to "Phase 4b", which was never built. This
module builds it.

Why it exists (PLN-1229): the ``run-prefix`` refactor collapses the
orchestrator's stage-by-stage walk of the deterministic prefix into one
in-process batch runner. That refactor is a pure batching wrapper, so the
safety net is an **artifact-parity oracle**: the exact intermediate artifacts
the current per-stage walk produces are pinned here, byte-for-byte (modulo
normalization), so a batched runner that drifts is caught immediately.

Coverage: the harness walks the whole deterministic prefix — stages ``01``
through ``19b_derive_spawn_spec`` — stopping at the reviewer fleet
(``stage_20``). That includes the two behaviors the orchestrator drives in
prose today and the ``run-prefix`` refactor must take over in Python:

- **PLN-725 singletons** (``stage_11`` signal extraction, ``stage_15`` coverage
  critic): after each prepare stage the harness reads the manifest and, on
  ``needs_agent``, injects a canned ``pln725_*.json`` (the deterministic stand-in
  for the live LLM Task) so the sibling consolidate stage runs the real
  agent-driven path with no model call.
- **Gate A** (hygiene-only early exit) and **Gate B** (``route`` →
  ``fast_path`` → skip ``stage_17_partition`` / augment its args and swap in
  ``uncached_diff_data.json``).

How it stays deterministic:

- **Real git fixture repo** built in ``tmp_path`` with pinned commit identity
  and dates, so blob/tree content — and everything derived from the diff — is
  stable across runs and hosts.
- **Hermetic environment**: ``HOME`` is redirected to a tmp dir (so
  ``finalize-cache``'s ``~/.claude/cr-cache-*`` makedirs never touches the real
  home and its absolute path is normalizable), ``CR_GLOBAL_CACHE`` is pinned,
  and ``_detect_open_pr`` is neutralized (no ``gh``/network — models the
  "no open PR" branch deterministically).
- **In-process stage execution** through the *real* CLI parser
  (``_register_subparsers``), so each stage's ``argparse.Namespace`` is built
  exactly as production builds it — no forked arg wiring.
- **Angle-bracket token resolution** replicating the ``start.md`` walker
  contract table (``<DIFF_SCOPE>``, ``<CACHE_DIR>``, ``<DIFF_TIP>``, …) by
  reading prior-stage artifacts, including the ``stage_07`` ``<DIFF_SCOPE>``
  override.
- **Per-artifact normalization** scrubbing absolute paths (cr_dir / repo / home
  / plugin root), ``review_id``, timestamps, and ``prompt_hash`` so unrelated
  churn (a prompt-wording edit, a new tmp path) never breaks the snapshot.

The subprocess A/B parity oracle (run the prefix two ways and assert byte
equality) is Phase 1; this module is its committed-snapshot foundation.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import code_review_helpers
from golden_fixture_harness import run_with_stdout_capture

# The plugin root (…/plugins/code-review) — this module lives at
# <plugin_root>/tools/python/prefix_golden_harness.py. Resolved from __file__
# so it is independent of the harness's chdir into the fixture repo.
PLUGIN_ROOT = Path(__file__).resolve().parents[2]

# Pinned git identity + author/committer dates. Fixed values → deterministic
# commit SHAs, which matters for any prefix artifact that embeds a commit hash
# (context_key, PR-head SHAs in later fixtures). Even where the plain-branch
# prefix does not embed a SHA, pinning is free insurance.
_GIT_IDENTITY_ENV = {
    "GIT_AUTHOR_NAME": "Fixture Author",
    "GIT_AUTHOR_EMAIL": "fixture@example.com",
    "GIT_COMMITTER_NAME": "Fixture Author",
    "GIT_COMMITTER_EMAIL": "fixture@example.com",
    # Fully isolate git config so the host's config can neither break commits
    # (commit.gpgsign, hooks) nor make them host-dependent. GIT_CONFIG_NOSYSTEM
    # blocks /etc/gitconfig, but the operator's ~/.gitconfig is *global*, not
    # system — so it also needs GIT_CONFIG_GLOBAL. Pointing GLOBAL and SYSTEM at
    # os.devnull is unambiguous and order-independent: the fixture repo is built
    # (via _git) BEFORE the hermetic HOME redirect, so relying on HOME alone
    # would leave those commits exposed to the real ~/.gitconfig.
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}

# The reviewer fleet — the first non-deterministic (LLM) stage. The prefix walk
# stops *before* this id; everything earlier is deterministic (the two PLN-725
# singletons are stubbed).
REVIEWER_FLEET_STAGE = "stage_20_spawn_reviewers"

# The first LLM-singleton stage. A pre-singleton-only walk (used by one guard
# test) stops before this; in run-plan array order stage_12_hygiene is the
# stage immediately before it, so that stop lands on the Gate A boundary.
PRE_SINGLETON_STOP_STAGE = "stage_11_extract_signals"

# stage_01_setup is a walker no-op — start.md runs it inline in stage 0b
# (capturing stdout to write setup.json) and the walker skips the plan entry.
_SETUP_STAGE_ID = "stage_01_setup"
_HYGIENE_STAGE_ID = "stage_12_hygiene"
_CACHE_CHECK_STAGE_ID = "stage_19_cache_check"
_PARTITION_STAGE_ID = "stage_17_partition"

# PLN-725 singleton prepare stages → the by-convention agent write target the
# sibling consolidate stage reads (see the singleton-dispatch skill).
_SINGLETON_AGENT_OUTPUT = {
    "stage_11_extract_signals": "pln725_extract_signals.json",
    "stage_15_coverage_critic": "pln725_coverage_critic.json",
}


# ---------------------------------------------------------------------------
# Fixture git repo construction
# ---------------------------------------------------------------------------


@dataclass
class Commit:
    """One commit in a fixture repo: a message plus a set of file writes.

    ``deletes`` names paths to ``git rm`` before committing. Dates are pinned
    per commit via ``GIT_AUTHOR_DATE`` / ``GIT_COMMITTER_DATE``.
    """

    message: str
    writes: dict[str, str] = field(default_factory=dict)
    deletes: list[str] = field(default_factory=list)
    date: str = "2020-01-01T00:00:00 +0000"


@dataclass
class FixtureRepoSpec:
    """A deterministic git repo: a base commit on ``main`` then a feature branch.

    ``diff_scope`` for local branch review is ``main...HEAD`` (what resolve-scope
    computes), which is why ``head`` lands on a separate branch — so the
    symmetric diff is non-empty. ``head`` may be ``None`` for the degenerate
    empty-diff fixture (base commit only; HEAD stays on ``main``).
    """

    base: Commit
    head: Commit | None = None
    feature_branch: str = "feature"


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    """Run a git command inside ``repo`` and return stdout (raises on failure)."""
    full_env = {**os.environ, **_GIT_IDENTITY_ENV}
    if env:
        full_env.update(env)
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        env=full_env,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _apply_commit(repo: Path, commit: Commit) -> None:
    for rel, content in commit.writes.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for rel in commit.deletes:
        _git(repo, "rm", "--quiet", rel)
    _git(repo, "add", "-A")
    date_env = {"GIT_AUTHOR_DATE": commit.date, "GIT_COMMITTER_DATE": commit.date}
    _git(repo, "commit", "--quiet", "-m", commit.message, env=date_env)


def build_fixture_repo(repo: Path, spec: FixtureRepoSpec) -> None:
    """Materialize ``spec`` as a real git repo rooted at ``repo``.

    Layout: base commit on ``main`` → (optional) checkout ``feature_branch`` →
    head commit. With a head commit, HEAD is left on the feature branch (so
    ``git rev-parse --abbrev-ref HEAD`` reports the feature branch as the review
    branch); with ``head=None``, HEAD stays on ``main`` and ``main...HEAD`` is
    empty.
    """
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "--quiet", "-b", "main")
    _apply_commit(repo, spec.base)
    if spec.head is not None:
        _git(repo, "checkout", "--quiet", "-b", spec.feature_branch)
        _apply_commit(repo, spec.head)


# ---------------------------------------------------------------------------
# Hermetic environment
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def hermetic_prefix_env(repo: Path, home: Path) -> Iterator[None]:
    """chdir into ``repo`` with a pinned, hermetic environment for the walk.

    Sets ``HOME`` → ``home`` (so ``finalize-cache`` writes its cache dir under a
    tmp home, never the operator's real ``~/.claude``), pins
    ``CR_GLOBAL_CACHE=0``, and neutralizes ``_detect_open_pr`` (→ None) so
    resolve-scope takes the deterministic no-PR branch without shelling to
    ``gh``. All mutations are restored on exit.
    """
    home.mkdir(parents=True, exist_ok=True)
    prev_cwd = os.getcwd()
    mutated = {
        "HOME": str(home),
        "CR_GLOBAL_CACHE": "0",
        **_GIT_IDENTITY_ENV,
    }
    saved: dict[str, str | None] = {k: os.environ.get(k) for k in mutated}
    original_detect = code_review_helpers._detect_open_pr
    try:
        os.chdir(str(repo))
        os.environ.update(mutated)
        code_review_helpers._detect_open_pr = lambda *a, **k: None  # type: ignore[assignment]
        yield
    finally:
        code_review_helpers._detect_open_pr = original_detect  # type: ignore[assignment]
        for key, val in saved.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        os.chdir(prev_cwd)


# ---------------------------------------------------------------------------
# Singleton stubs (PLN-725)
# ---------------------------------------------------------------------------


def default_extract_signals_stub() -> dict[str, Any]:
    """A minimal, taxonomy-valid canned ``pln725_extract_signals.json``.

    Picks the first taxonomy signal name (so the name is always valid without
    hardcoding a specific one) at a realistic confidence with non-empty
    evidence — the shape ``validate_signal_extraction_output`` accepts. This
    drives the consolidate stage's ``status: "ok"`` path (the healthy run),
    rather than the fail-closed default an absent agent output would trigger.
    """
    taxonomy, _ = code_review_helpers.load_signal_taxonomy(None)
    names = sorted(taxonomy.get("signals", {}).keys())
    first = names[0] if names else "unknown"
    return {
        "signals": [
            {
                "name": first,
                "evidence": "fixture: representative signal for the changed diff",
                "confidence": 0.9,
            },
        ],
    }


# ---------------------------------------------------------------------------
# In-process stage execution
# ---------------------------------------------------------------------------


def _build_cli_parser() -> argparse.ArgumentParser:
    """Build the same top-level parser ``main()`` uses.

    Reusing ``_register_subparsers`` guarantees each stage's Namespace is
    constructed exactly as production constructs it — the alternative
    (hand-rolling Namespaces per subcommand) would silently drift from cli.json.
    """
    parser = argparse.ArgumentParser(description="prefix-golden-harness dispatch")
    subparsers = parser.add_subparsers(dest="command", required=True)
    code_review_helpers._register_subparsers(subparsers)
    return parser


def _read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open() as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


@dataclass
class PrefixContext:
    """Mutable state threaded through the walk for token resolution + gates."""

    cr_dir: Path
    flags: dict[str, Any]
    #: Seeded constants + runtime overrides keyed by the literal token string,
    #: e.g. {"<PLUGIN_ROOT>": "...", "<DIFF_SCOPE>": "<override>"}.
    overrides: dict[str, str] = field(default_factory=dict)
    #: Gate B route decision, populated after stage_19_cache_check.
    fast_path: bool = False
    max_bha_agents: int | None = None


def _resolve_token(token: str, ctx: PrefixContext) -> str:
    """Resolve a single ``<TOKEN>`` per the start.md walker-contract table.

    Missing source files degrade to "" exactly as the walker does ("pass an
    empty string" for a not-yet-produced artifact).
    """
    if token in ctx.overrides:
        return ctx.overrides[token]

    cr = ctx.cr_dir
    scope = _read_json(cr / "scope.json")
    if token == "<DIFF_SCOPE>":
        return str(scope.get("diff_scope", ""))
    if token == "<BASE_REF>":
        return str(scope.get("base_ref", ""))
    if token == "<DIFF_TIP>":
        return str(scope.get("diff_tip", ""))
    if token == "<SCOPE_KIND>":
        return str(scope.get("scope_kind", ""))
    if token == "<REVIEW_ROOT>":
        return str(scope.get("review_root", ""))
    if token == "<STATE_KEY>":
        review_branch = str(scope.get("review_branch", ""))
        base_ref = str(scope.get("base_ref", ""))
        if not review_branch and not base_ref:
            return ""
        return f"{review_branch}:{base_ref}"
    if token == "<CACHE_DIR>":
        return str(_read_json(cr / "cache_config.json").get("cache_dir", ""))
    if token == "<PROMPT_HASH>":
        return str(_read_json(cr / "hashes.json").get("prompt_hash", ""))
    if token == "<CONTEXT_KEY>":
        return str(_read_json(cr / "hashes.json").get("context_key", ""))
    if token == "<INTENT>":
        return str(_read_json(cr / "intent.json").get("intent", ""))
    # Constants (<PLUGIN_ROOT>, <MODEL_ID>, <START_TIME>, <GLOBAL_CACHE>) are
    # seeded into overrides at context construction; an unseeded token here is
    # a contract gap, surfaced rather than silently blanked.
    raise KeyError(f"unresolved prefix token: {token}")


# Every angle-bracket token the prefix stage args reference. Kept explicit (vs
# regex-scanning) so an unrecognized token in a future stage fails loudly.
_KNOWN_TOKENS = (
    "<PLUGIN_ROOT>", "<DIFF_SCOPE>", "<BASE_REF>", "<DIFF_TIP>", "<SCOPE_KIND>",
    "<REVIEW_ROOT>", "<CACHE_DIR>", "<GLOBAL_CACHE>", "<PROMPT_HASH>",
    "<CONTEXT_KEY>", "<MODEL_ID>", "<INTENT>", "<START_TIME>", "<STATE_KEY>",
)


def _resolve_args(raw_args: list[str], ctx: PrefixContext) -> list[str]:
    """Substitute every ``<TOKEN>`` occurrence within each arg string."""
    out: list[str] = []
    for arg in raw_args:
        resolved = arg
        for token in _KNOWN_TOKENS:
            if token in resolved:
                resolved = resolved.replace(token, _resolve_token(token, ctx))
        out.append(resolved)
    return out


@dataclass
class StageResult:
    stage_id: str
    status: str  # "ran" | "skipped" | "skipped_fast_path" | "failed_continue"
    returncode: int | None = None


def _run_stage_cmd(ns: argparse.Namespace, stdout_path: Path | None) -> int:
    """Dispatch ``ns.func(ns)`` with stdout redirected per the stage contract.

    When ``stdout_path`` is set the helper's stdout is the artifact (``> file``
    redirect); otherwise the helper writes its own file and prints a summary we
    discard.
    """
    captured_rc: dict[str, int] = {}

    def _invoke(inner_ns: argparse.Namespace) -> None:
        captured_rc["rc"] = inner_ns.func(inner_ns)

    run_with_stdout_capture(_invoke, ns, stdout_to=stdout_path)
    return captured_rc.get("rc", 0)


def _expected_outputs_present(stage: dict[str, Any]) -> bool:
    """True when *every* declared literal output exists.

    Glob patterns (``patches_p<N>.txt``, ``agent_*.json``) and unresolved
    ``<TOKEN>`` residue are treated as satisfied — the walker defers those to
    the fleet enforcers. This is intentionally stricter than the walker's
    "at least one exists" wording (start.md walker-contract step 4): a
    multi-output stage like ``stage_16_arbitrate_budget`` (``coverage.json`` +
    ``coverage_gaps.json``, ``on_failure: abort``) always writes both on the
    happy path, so requiring all of them lets the harness catch a partial-output
    regression at the abort gate instead of only at the golden artifact-set
    diff. An ANY-of check would silently pass when an earlier stage had already
    written one of the two files.
    """
    for out in stage.get("expected_outputs", []):
        if "*" in out or "<" in out:
            continue
        if not Path(out).exists():
            return False
    return True


def _augment_partition_args(resolved: list[str], ctx: PrefixContext) -> list[str]:
    """Apply Gate B's partition augmentation (start.md Gate B step 4).

    The walker, for the standard (non-fast-path) flow, passes
    ``--loc-budget 500 --max-files 25 --max-bha-agents <N>`` on top of the
    plan args and — when a cache dir is active — swaps ``--diff-data`` to
    ``uncached_diff_data.json`` so partitions only contain uncached files.
    """
    out = list(resolved)
    cache_dir = _resolve_token("<CACHE_DIR>", ctx)
    uncached = ctx.cr_dir / "uncached_diff_data.json"
    if cache_dir and uncached.exists():
        out = [
            str(uncached) if a.endswith("/diff_data.json") else a
            for a in out
        ]
    out += ["--loc-budget", "500", "--max-files", "25"]
    if ctx.max_bha_agents is not None:
        out += ["--max-bha-agents", str(ctx.max_bha_agents)]
    return out


def _execute_stage(
    stage: dict[str, Any],
    ctx: PrefixContext,
    parser: argparse.ArgumentParser,
    completed: set[str],
) -> StageResult:
    """Execute one helper stage in-process, honoring stdout + on_failure.

    Mirrors start.md walker-contract steps 1-5 for ``kind == "helper"`` stages.
    Non-helper stages (agent_fleet / present) never appear in the prefix and
    are an explicit error if encountered.
    """
    stage_id = stage["id"]

    if not stage.get("enabled", True):
        return StageResult(stage_id, "skipped")
    if any(dep not in completed for dep in stage.get("depends_on", [])):
        return StageResult(stage_id, "skipped")
    if stage_id == _SETUP_STAGE_ID:
        completed.add(stage_id)  # already run inline; mark so dependents resolve
        return StageResult(stage_id, "ran")
    if stage_id == _PARTITION_STAGE_ID and ctx.fast_path:
        # Gate B fast-path: partition is skipped entirely (the fast-path
        # reviewer consumes patches_all.txt directly).
        return StageResult(stage_id, "skipped_fast_path")

    kind = stage.get("kind")
    if kind != "helper":
        raise AssertionError(
            f"prefix must be helper-only; got kind={kind!r} for {stage_id!r}",
        )

    resolved = _resolve_args(stage.get("args", []), ctx)
    if stage_id == _PARTITION_STAGE_ID:
        resolved = _augment_partition_args(resolved, ctx)
    ns = parser.parse_args([stage["subcommand"], *resolved])

    stdout_target = stage.get("stdout")
    rc = _run_stage_cmd(ns, Path(stdout_target) if stdout_target else None)

    outputs_ok = _expected_outputs_present(stage)
    if rc != 0 or not outputs_ok:
        on_failure = stage.get("on_failure", "abort")
        if on_failure == "abort":
            raise AssertionError(
                f"stage {stage_id!r} failed (rc={rc}, outputs_ok={outputs_ok}) "
                f"with on_failure=abort",
            )
        # continue / continue_with_coverage_gap: proceed, but do NOT mark the
        # stage as satisfying its dependents' inputs.
        return StageResult(stage_id, "failed_continue", rc)

    _apply_post_stage_overrides(stage_id, ctx)
    completed.add(stage_id)
    return StageResult(stage_id, "ran", rc)


def _apply_post_stage_overrides(stage_id: str, ctx: PrefixContext) -> None:
    """Apply the cross-stage ``<DIFF_SCOPE>`` override the walker does in prose.

    stage_07 auto-incremental may narrow the diff scope; per start.md's stage_07
    note the walker updates the cached ``<DIFF_SCOPE>`` token when
    ``auto_incremental.json.diff_scope`` is non-null.
    """
    if stage_id == "stage_07_auto_incremental":
        override = _read_json(ctx.cr_dir / "auto_incremental.json").get("diff_scope")
        if override:
            ctx.overrides["<DIFF_SCOPE>"] = str(override)


# ---------------------------------------------------------------------------
# Gates + singleton dispatch (walker prose the harness owns)
# ---------------------------------------------------------------------------


def _singleton_dispatch(
    stage_id: str,
    ctx: PrefixContext,
    stubs: dict[str, dict[str, Any]],
) -> None:
    """Replicate walker-contract step 6 for the two PLN-725 singletons.

    Reads the prepare stage's manifest ``status``. On ``needs_agent`` the live
    orchestrator would spawn one synchronous Task; here we inject the canned
    ``pln725_*.json`` stub (deterministic stand-in) at the by-convention agent
    write target. ``cache_hit`` / ``skipped`` need no agent (the sibling
    consolidate stage no-ops).
    """
    if stage_id == "stage_11_extract_signals":
        status = str(_read_json(ctx.cr_dir / "extract_signals_manifest.json").get("status", ""))
    elif stage_id == "stage_15_coverage_critic":
        status = str(_read_json(ctx.cr_dir / "coverage.json").get("critic", {}).get("status", ""))
    else:
        return

    if status != "needs_agent":
        return
    stub = stubs.get(stage_id)
    if stub is None:
        raise AssertionError(
            f"{stage_id} manifest is 'needs_agent' but no canned stub was "
            f"supplied — the fixture would dispatch a live LLM agent",
        )
    target = ctx.cr_dir / _SINGLETON_AGENT_OUTPUT[stage_id]
    target.write_text(json.dumps(stub, indent=2))


def _run_route_gate_b(ctx: PrefixContext, parser: argparse.ArgumentParser) -> None:
    """Replicate Gate B: run ``route`` between cache-check and partition.

    ``route`` is not a plan stage — the walker invokes it after
    ``stage_19_cache_check`` to compute ``fast_path`` / ``max_bha_agents`` before
    ``stage_17_partition``. It writes ``spawn.json`` (``route`` section). The
    fast-path branch also deletes any cached BHA artifact; replicated for
    fidelity (a no-op on a cold cache).
    """
    cr = ctx.cr_dir
    intent = _resolve_token("<INTENT>", ctx)
    ns = parser.parse_args([
        "route",
        "--diff-data", str(cr / "diff_data.json"),
        "--critic-gates", ".closedloop-ai/settings/critic-gates.json",
        "--intent", intent or "mixed",
        "--cr-dir", str(cr),
    ])
    _run_stage_cmd(ns, None)

    route = _read_json(cr / "spawn.json").get("route", {})
    ctx.fast_path = bool(route.get("fast_path", False))
    mba = route.get("max_bha_agents")
    ctx.max_bha_agents = int(mba) if isinstance(mba, (int, float)) else None
    if ctx.fast_path:
        cached_bha = cr / "agent_cached_bha.json"
        if cached_bha.exists():
            cached_bha.unlink()


# ---------------------------------------------------------------------------
# Setup + run-plan (stage 0)
# ---------------------------------------------------------------------------


def run_setup_and_prepare(
    cr_dir: Path,
    *,
    mode: str = "local",
    depth: str = "standard",
    scope_args: str = "",
    hygiene_only: bool = False,
    since_last_review: bool = False,
    full_review: bool = False,
    base_ref_override: str = "",
    pr_number: int | None = None,
) -> dict[str, Any]:
    """Replicate start.md stage 0: run setup, write setup.json, emit run_plan.

    Runs ``setup`` in-process (no ``--cr-dir-prefix`` so it does not create a
    randomized cr dir — the harness owns ``cr_dir``), writes the captured JSON
    to ``cr_dir/setup.json`` exactly as the walker does, then invokes
    ``prepare-run`` and returns the loaded ``run_plan`` (with ``_setup`` stashed
    for constant-token seeding).
    """
    cr_dir.mkdir(parents=True, exist_ok=True)

    setup_ns = argparse.Namespace(mode=mode, cr_dir_prefix=None)
    setup_out = run_with_stdout_capture(code_review_helpers.cmd_setup, setup_ns)
    setup = json.loads(setup_out)
    (cr_dir / "setup.json").write_text(json.dumps(setup, indent=2) + "\n")

    prepare_ns = argparse.Namespace(
        cr_dir=str(cr_dir),
        mode=mode,
        hygiene_only=hygiene_only,
        since_last_review=since_last_review,
        full_review=full_review,
        base_ref_override=base_ref_override,
        scope_args=scope_args,
        pr_number=pr_number,
        depth=depth,
        output=None,
    )
    run_with_stdout_capture(code_review_helpers.cmd_prepare_run, prepare_ns)
    run_plan = json.loads((cr_dir / "run_plan.json").read_text())
    run_plan["_setup"] = setup
    return run_plan


# ---------------------------------------------------------------------------
# Prefix walk
# ---------------------------------------------------------------------------


def walk_prefix(
    run_plan: dict[str, Any],
    ctx: PrefixContext,
    *,
    stop_before: str = REVIEWER_FLEET_STAGE,
    singleton_stubs: dict[str, dict[str, Any]] | None = None,
) -> list[StageResult]:
    """Walk plan stages in array order until ``stop_before`` (exclusive).

    Interleaves the walker's prose-driven behaviors at their stage boundaries:
    Gate A (hygiene-only early exit after stage_12), the PLN-725 singleton
    dispatch after stage_11 / stage_15, and Gate B (route) after
    stage_19_cache_check. Returns one StageResult per visited stage.
    """
    parser = _build_cli_parser()
    stubs = singleton_stubs or {}
    completed: set[str] = set()
    results: list[StageResult] = []
    for stage in run_plan["stages"]:
        stage_id = stage["id"]
        if stage_id == stop_before:
            break
        results.append(_execute_stage(stage, ctx, parser, completed))

        if stage_id in _SINGLETON_AGENT_OUTPUT:
            _singleton_dispatch(stage_id, ctx, stubs)
        if stage_id == _HYGIENE_STAGE_ID and ctx.flags.get("hygiene_only"):
            break  # Gate A — hygiene-only present-and-exit
        if stage_id == _CACHE_CHECK_STAGE_ID:
            _run_route_gate_b(ctx, parser)
    return results


# ---------------------------------------------------------------------------
# Normalization + snapshots
# ---------------------------------------------------------------------------

# Artifacts the prefix produces, in roughly production order. Prompt-asset
# copies (shared_prompt.txt, bha_suffix.txt, …) are deliberately excluded: they
# are inputs copied verbatim from the plugin, not derived pipeline state, and
# pinning them would couple the golden to unrelated prompt-wording edits.
PREFIX_ARTIFACTS = (
    "setup.json",
    "scope.json",
    "cache_config.json",
    "auto_incremental.json",
    "diff_data.json",
    "patches_all.txt",
    "intent_context.json",
    "injection_report.json",
    "intent.json",
    "hygiene.json",
    "extract_signals_manifest.json",
    "extract_signals.json",
    "coverage.json",
    "available_reviewers.json",
    "coverage_gaps.json",
    "hashes.json",
    "cache_result.json",
    # The cached-BHA replay artifact cache-check writes for a hit — the findings
    # that skip re-review and flow into collect-findings. Present only on the
    # non-fast-path fixtures (Gate B deletes it in fast-path); snapshotted where
    # it exists so the cache-hit fixture actually pins the replay payload.
    "agent_cached_bha.json",
    "uncached_diff_data.json",
    "partitions.json",
    "spawn.json",
)

# JSON keys whose values are non-deterministic (wall-clock / per-run identity /
# prompt-coupled) and are replaced with a stable placeholder before snapshot.
_VOLATILE_KEYS = {
    "start_time": 0,
    "review_id": "<REVIEW_ID>",
    "prompt_hash": "<PROMPT_HASH>",
    "cache_key": "<CACHE_KEY>",
    "taxonomy_hash": "<TAXONOMY_HASH>",
    # Cache-keying hashes computed over extract_signals.json, whose generated_at
    # is wall-clock — so these vary run-to-run. The underlying .initial plan and
    # signal set are snapshotted un-normalized, so pinning the hashes would add
    # only nondeterminism, not coverage.
    "signals_hash": "<SIGNALS_HASH>",
    "coverage_plan_initial_hash": "<PLAN_INITIAL_HASH>",
    "emitted_at": "<TS>",
    "timestamp": "<TS>",
    "generated_at": "<TS>",
}


def _normalize_json(obj: Any) -> Any:
    """Recursively replace volatile-keyed values with stable placeholders."""
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for key, val in obj.items():
            if key in _VOLATILE_KEYS:
                out[key] = _VOLATILE_KEYS[key]
            elif isinstance(key, str) and key.endswith("_at"):
                out[key] = "<TS>"
            else:
                out[key] = _normalize_json(val)
        return out
    if isinstance(obj, list):
        return [_normalize_json(v) for v in obj]
    return obj


def _scrub_paths(text: str, path_subs: list[tuple[str, str]]) -> str:
    """Replace absolute-path substrings (longest first) with placeholders."""
    for needle, placeholder in path_subs:
        if needle:
            text = text.replace(needle, placeholder)
    return text


def normalize_artifact(path: Path, path_subs: list[tuple[str, str]]) -> str:
    """Return the normalized textual snapshot for one artifact.

    JSON artifacts are parsed, volatile keys placeheld, and re-serialized
    (sorted keys) for a stable canonical form; non-JSON artifacts (patches
    text) are scrubbed as-is. Absolute-path scrubbing runs last over the
    serialized text so nested path values are caught regardless of key.
    """
    raw = path.read_text()
    if path.suffix == ".json":
        normalized = _normalize_json(json.loads(raw))
        raw = json.dumps(normalized, indent=2, sort_keys=True) + "\n"
    return _scrub_paths(raw, path_subs)


def collect_snapshots(
    cr_dir: Path,
    repo: Path,
    home: Path,
    *,
    artifacts: tuple[str, ...] = PREFIX_ARTIFACTS,
) -> dict[str, str]:
    """Normalize every present prefix artifact into name → snapshot text.

    Path scrubs are ordered longest-first so a nested path can't be partially
    shadowed by a shorter prefix.
    """
    path_subs = sorted(
        [
            (str(cr_dir), "<CR_DIR>"),
            (str(repo), "<REPO>"),
            (str(home), "<HOME>"),
            (str(PLUGIN_ROOT), "<PLUGIN_ROOT>"),
        ],
        key=lambda pair: len(pair[0]),
        reverse=True,
    )
    snapshots: dict[str, str] = {}
    for name in artifacts:
        path = cr_dir / name
        if path.exists():
            snapshots[name] = normalize_artifact(path, path_subs)
    return snapshots


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------


@dataclass
class PrefixFixture:
    """A declarative prefix fixture: repo + invocation flags + optional seeding.

    ``pre_seed`` runs inside the hermetic env *before* the walk (after the repo
    is built) with ``(home, repo, cr_dir)`` — used to warm a cache dir or plant
    a ``review_state.json`` for the cache-hit / since-last-review fixtures.
    """

    name: str
    repo: FixtureRepoSpec
    depth: str = "standard"
    scope_args: str = ""
    hygiene_only: bool = False
    since_last_review: bool = False
    full_review: bool = False
    base_ref_override: str = ""
    pr_number: int | None = None
    pre_seed: Callable[[Path, Path, Path], None] | None = None
    #: Canned agent output for the stage_15 coverage-critic singleton. Only the
    #: coverage-critic fixture (which plants a non-empty reviewer roster) drives
    #: stage_15 to ``needs_agent``; every other fixture leaves the roster empty
    #: so stage_15 short-circuits to ``skipped`` and no stub is needed.
    coverage_critic_stub: dict[str, Any] | None = None


@dataclass
class PrefixRun:
    """Result of one full harness run: stage results + normalized snapshots."""

    results: list[StageResult]
    snapshots: dict[str, str]
    #: Every top-level file the walk left in cr_dir (relative names), whether or
    #: not it was snapshotted — lets a test assert nothing is produced-but-
    #: undeclared (see test_no_undeclared_artifacts).
    all_artifacts: list[str]


def cache_dir_for(home: Path, repo_name: str = "fixture_repo") -> Path:
    """The cache dir ``finalize-cache`` resolves for a local branch review.

    Mirrors ``cmd_finalize_cache`` (global_cache=0, local, no PR):
    ``~/.claude/cr-cache-repo-<repo_name>``. Exposed so ``pre_seed`` callbacks
    can warm the exact directory cache-check will read.
    """
    return home / ".claude" / f"cr-cache-repo-{repo_name}"


def run_prefix_fixture(
    tmp_root: Path,
    fixture: PrefixFixture,
    *,
    stop_before: str = REVIEWER_FLEET_STAGE,
) -> PrefixRun:
    """Build the fixture repo, walk the prefix, and return normalized snapshots.

    ``tmp_root`` is a per-test temp dir; the repo, cr_dir, and hermetic HOME are
    created as siblings beneath it so their absolute paths normalize cleanly.
    """
    repo = tmp_root / "fixture_repo"
    cr_dir = tmp_root / "cr"
    home = tmp_root / "home"

    build_fixture_repo(repo, fixture.repo)
    home.mkdir(parents=True, exist_ok=True)

    with hermetic_prefix_env(repo, home):
        if fixture.pre_seed is not None:
            fixture.pre_seed(home, repo, cr_dir)
        run_plan = run_setup_and_prepare(
            cr_dir,
            depth=fixture.depth,
            scope_args=fixture.scope_args,
            hygiene_only=fixture.hygiene_only,
            since_last_review=fixture.since_last_review,
            full_review=fixture.full_review,
            base_ref_override=fixture.base_ref_override,
            pr_number=fixture.pr_number,
        )
        setup = run_plan["_setup"]
        ctx = PrefixContext(
            cr_dir=cr_dir,
            flags=run_plan.get("flags", {}),
            overrides={
                "<PLUGIN_ROOT>": str(PLUGIN_ROOT),
                "<MODEL_ID>": "opus",
                "<START_TIME>": str(setup.get("start_time", 0)),
                "<GLOBAL_CACHE>": str(setup.get("global_cache", "0")),
            },
        )
        stubs: dict[str, dict[str, Any]] = {
            "stage_11_extract_signals": default_extract_signals_stub(),
        }
        if fixture.coverage_critic_stub is not None:
            stubs["stage_15_coverage_critic"] = fixture.coverage_critic_stub
        results = walk_prefix(run_plan, ctx, stop_before=stop_before, singleton_stubs=stubs)
        snapshots = collect_snapshots(cr_dir, repo, home)
        all_artifacts = sorted(p.name for p in cr_dir.iterdir() if p.is_file())

    return PrefixRun(results=results, snapshots=snapshots, all_artifacts=all_artifacts)


# ---------------------------------------------------------------------------
# Fixture library
# ---------------------------------------------------------------------------


def _numbered_lines(prefix: str, count: int) -> str:
    """A deterministic multi-line body (``<prefix>0 = 0`` …) of ``count`` lines."""
    return "".join(f"{prefix}{i} = {i}\n" for i in range(count))


def standard_fixture() -> PrefixFixture:
    """P0-B (1): a >200 LOC diff → non-fast-path → partition runs (unified).

    210 added lines clears ``FAST_PATH_MAX_LOC`` (200) but stays under the
    5000-LOC unified threshold, so partition emits a single unified partition —
    exercising the partition + derive-spawn-spec path without a huge golden.
    """
    return PrefixFixture(
        name="golden_prefix_standard",
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/app.py": "def greet(name):\n    return name\n"},
            ),
            head=Commit(
                message="feat: add generated constants module",
                writes={
                    "src/app.py": "def greet(name):\n    return name.upper()\n",
                    "src/constants.py": _numbered_lines("C", 210),
                },
                date="2020-01-02T00:00:00 +0000",
            ),
        ),
    )


def fast_path_fixture() -> PrefixFixture:
    """P0-B (3): a small (≤200 LOC) diff → fast_path → partition skipped."""
    return PrefixFixture(
        name="golden_prefix_fast_path",
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/app.py": 'def greet(name):\n    return "Hello, " + name\n'},
            ),
            head=Commit(
                message="fix: correct off-by-one in greeting",
                writes={"src/app.py": 'def greet(name):\n    return "Hello, " + name + "!"\n'},
                date="2020-01-02T00:00:00 +0000",
            ),
        ),
    )


def hygiene_only_fixture() -> PrefixFixture:
    """P0-B (2): hygiene-only run → Gate A early exit after stage_12."""
    return PrefixFixture(
        name="golden_prefix_hygiene_only",
        hygiene_only=True,
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/app.py": "def greet(name):\n    return name\n"},
            ),
            head=Commit(
                message="fix: uppercase the greeting",
                writes={"src/app.py": "def greet(name):\n    return name.upper()\n"},
                date="2020-01-02T00:00:00 +0000",
            ),
        ),
    )


def empty_diff_fixture() -> PrefixFixture:
    """P0-B (6): base commit only → ``main...HEAD`` is empty (degenerate path)."""
    return PrefixFixture(
        name="golden_prefix_empty_diff",
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/app.py": "def greet(name):\n    return name\n"},
            ),
            head=None,
        ),
    )


def _seed_cache_hit(home: Path, repo: Path, cr_dir: Path) -> None:
    """Warm the cache dir so ``cache-check`` reports ``src/constants.py`` cached.

    Runs the real ``parse-diff`` + hash helpers so the pre-seeded manifest entry
    matches exactly what the walk will compute (no reimplemented derivation):

    - ``patch_hash`` via ``_compute_patch_hash(file, patch_lines[file])``.
    - ``prompt_hash`` via ``compute_canonical_prompt_hash`` over the same three
      prompt files ``compute-hashes`` folds (shared / bha-suffix / verifier),
      read from the plugin so they are byte-identical to prep-assets' copies.

    ``cached_at`` is set to *now* (freshness TTL is 30 days) — it is a cache
    input, never a snapshotted artifact, so its non-determinism doesn't leak.
    """
    parse_ns = argparse.Namespace(scope="main...HEAD", workdir=None)
    diff_data = json.loads(
        run_with_stdout_capture(code_review_helpers.cmd_parse_diff, parse_ns),
    )
    cached_file = "src/constants.py"
    patch_hash = code_review_helpers._compute_patch_hash(
        cached_file, diff_data["patch_lines"][cached_file],
    )

    prompts = PLUGIN_ROOT / "tools" / "prompts"
    parts = [
        (prompts / "shared_prompt.txt").read_bytes(),
        (prompts / "bha_suffix.txt").read_bytes(),
        (prompts / "verifier_prompt.txt").read_bytes(),
    ]
    prompt_hash = code_review_helpers.compute_canonical_prompt_hash(parts)

    # A representative cached finding so the hit actually replays content into
    # agent_cached_bha.json (a bare [] would pin nothing). emitted_at is
    # normalized to <TS> in the snapshot.
    cached_finding = {
        "reviewer": "bha_p0",
        "source": "agent",
        "finding_scope": "diff",
        "file": cached_file,
        "line": 1,
        "category": "Correctness",
        "severity": "MEDIUM",
        "issue": "Cached: magic constant should be named.",
        "explanation": "Prior review flagged an unnamed constant here.",
        "recommendation": "Extract the literal into a named constant.",
        "confidence": 0.8,
        "code_snippet": "C0 = 0",
        "emitted_at": "2020-01-02T00:00:00+00:00",
    }
    cache_dir = cache_dir_for(home)
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        cached_file: {
            "schema_version": code_review_helpers.SCHEMA_VERSION,
            "model_id": "opus",
            "prompt_hash": prompt_hash,
            "patch_hash": patch_hash,
            "findings": [cached_finding],
            "cached_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    (cache_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def cache_hit_fixture() -> PrefixFixture:
    """P0-B (4): a warm cache entry → cache-check hit → uncached subset.

    Reuses the standard (>200 LOC) repo so the run stays non-fast-path; the
    pre-seeded cache marks ``src/constants.py`` fresh, so cache-check narrows the
    uncached set to ``src/app.py`` and partition operates on that remainder.
    """
    return PrefixFixture(
        name="golden_prefix_cache_hit",
        repo=standard_fixture().repo,
        pre_seed=_seed_cache_hit,
    )


def _seed_review_state(home: Path, repo: Path, cr_dir: Path) -> None:
    """Plant a prior review at the base commit so auto-incremental narrows scope.

    The state key is ``<review_branch>:<base_ref>`` = ``feature:main`` (what the
    walker resolves for this repo). ``sha`` is the base commit — a genuine
    ancestor of HEAD — so ``--since-last-review`` yields ``<base_sha>...HEAD``.
    ``completed_at`` is a cache input, never snapshotted.
    """
    base_sha = _git(repo, "rev-parse", "main").strip()
    cache_dir = cache_dir_for(home)
    cache_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "reviews": {
            "feature:main": {
                "sha": base_sha,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "success": True,
                "tier": "standard",
            },
        },
    }
    (cache_dir / "review_state.json").write_text(json.dumps(state, indent=2) + "\n")


def since_last_review_fixture() -> PrefixFixture:
    """P0-B (5): prior review state → ``--since-last-review`` scope override."""
    return PrefixFixture(
        name="golden_prefix_since_last_review",
        since_last_review=True,
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/app.py": "def greet(name):\n    return name\n"},
            ),
            head=Commit(
                message="fix: uppercase the greeting",
                writes={"src/app.py": "def greet(name):\n    return name.upper()\n"},
                date="2020-01-02T00:00:00 +0000",
            ),
        ),
        pre_seed=_seed_review_state,
    )


def _seed_reviewer_roster(home: Path, repo: Path, cr_dir: Path) -> None:
    """Plant a project reviewer so the coverage critic has a candidate.

    ``load-available-reviewers`` scans ``.claude/agents/*.md`` (relative to cwd
    = the fixture repo) and parses each file's ``name`` frontmatter. A single
    project agent not already in the deterministic plan makes
    ``coverage-critic-prepare`` reach ``needs_agent`` (rather than the
    no-roster / no-candidates skips every other fixture takes). Written
    untracked so it never enters the diff.
    """
    agents_dir = repo / ".claude" / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / "security-critic.md").write_text(
        "---\n"
        "name: security-critic\n"
        "description: Reviews authentication and cryptography changes.\n"
        "---\n\n"
        "You are a security reviewer.\n",
    )


def coverage_critic_fixture() -> PrefixFixture:
    """P0-B (bonus): drive the stage_15 coverage-critic singleton end-to-end.

    The other fixtures leave ``.claude/agents/`` empty, so stage_15 always
    short-circuits to ``skipped`` and its agent-driven path never runs. Here a
    planted roster makes ``coverage-critic-prepare`` emit ``needs_agent``; the
    canned ``additions`` stub then consolidates into ``coverage.json.final``
    (``critic_status: "ok"``) — the second singleton's contract the run-prefix
    refactor must preserve.
    """
    return PrefixFixture(
        name="golden_prefix_coverage_critic",
        repo=FixtureRepoSpec(
            base=Commit(
                message="chore: initial project skeleton",
                writes={"src/auth.py": "def login(user):\n    return user\n"},
            ),
            head=Commit(
                message="feat: add token verification to login",
                writes={
                    "src/auth.py": "def login(user):\n    return verify(user)\n",
                },
                date="2020-01-02T00:00:00 +0000",
            ),
        ),
        pre_seed=_seed_reviewer_roster,
        coverage_critic_stub={
            "additions": [
                {
                    "reviewer": "security-critic",
                    "evidence": "fixture: login path adds token verification",
                },
            ],
        },
    )
