"""Contract checks for the workflow-code-review skill.

Ported from the workflow repo prompt-pack tests when the skill moved here (ISS-12046).
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = PLUGIN_ROOT / "skills" / "workflow-code-review"
BUNDLED_PROMPT_PACK = SKILL_ROOT / "references" / "prompt-pack"
LENS_PATH_RE = re.compile(r"`(sections/[A-Za-z0-9_./-]+\.md)`")
GRAPH_ROUTES = (
    "ticket_detail",
    "query_collisions",
    "search_nodes",
    "search_memory_facts",
    "code_projects",
    "code_symbols",
    "code_callers",
    "code_snippet",
    "blast_radius_tickets",
    "code_tests_for",
    "code_architecture",
)


def read_skill_file(relative_path: str) -> str:
    return (SKILL_ROOT / relative_path).read_text()


def assert_matches(text: str, pattern: str, flags: int = 0) -> None:
    assert re.search(pattern, text, flags), pattern


def assert_not_matches(text: str, pattern: str) -> None:
    assert not re.search(pattern, text), pattern


def test_prevents_duplicate_inline_findings_without_broadening_the_target_snapshot() -> None:
    skill = read_skill_file("SKILL.md")
    assert_matches(skill, r"Immediately before posting each proposed new actionable finding")
    assert_matches(skill, r"Record the pinned PR head SHA during target resolution")
    assert_matches(skill, r"If the current head differs from the pinned head, fail closed")
    assert_matches(skill, r"current diff-anchored inline review comments")
    assert_matches(skill, r"regardless of author")
    assert_matches(skill, r"Exclude top-level pull request conversation comments and review summary bodies")
    assert_matches(skill, r"do not post the duplicate finding; do count it in `<total_findings>`")
    assert_matches(skill, r"do not count it in `<commented_findings>`")
    assert_matches(skill, r"exactly one mutually exclusive outcome based on findings before and after duplicate suppression")
    assert_matches(skill, r"Leave exactly one concise general PR comment stating that the review is complete")
    assert_matches(skill, r"`approval` only when no actionable finding existed before duplicate suppression")
    assert_matches(skill, r"This clean branch is mutually exclusive with `duplicate_comment`")
    assert_matches(skill, r"Never finish with only the beginning-review comment")
    assert_matches(skill, r"gh api --paginate")
    assert_matches(skill, r"never combine `--slurp` with `--jq` or `--template`")
    assert_matches(skill, r"If the latest inline-review-comment fetch fails, fail closed")
    assert_matches(skill, r"diff line could not be resolved")
    assert_matches(skill, r"retry once on another valid changed line")
    assert_matches(skill, r"Inline Finding Publication")
    assert_matches(skill, r"target the pinned diff with GitHub's diff `position` field")
    assert_matches(skill, r"direct endpoint calls can reject `line` and `subject_type`")
    assert_matches(skill, r"pulls/NUMBER/files\?per_page=100")
    assert_matches(skill, r"Compute `POSITION` only from the exact matching `filename` object's `patch`")
    assert_matches(skill, r"Do not compute publishable inline-comment positions from `git diff`, `gh pr diff`, PR `baseRefOid`, or any local worktree diff")
    assert_matches(skill, r"Verify the path exists in the GitHub PR file list before posting")
    assert_matches(skill, r"If the path is absent, or its `patch` is absent or truncated")
    assert_matches(skill, r"the first line below the first `@@` hunk header is position 1")
    assert_matches(skill, r"each later `@@` hunk header also consumes one position")
    assert_matches(skill, r"do not pass the source file line number as `position`")
    assert_matches(skill, r"Run the publication shell under `set -euo pipefail`")
    assert_matches(skill, r"verify that `POSITION` is a non-empty decimal integer")
    assert_matches(skill, r"Use a checked Node/JavaScript parser or an equivalently explicit parser")
    assert_matches(skill, r"do not use inline `awk`/`sed` one-liners")
    assert_matches(skill, r"quoted heredoc")
    assert_matches(skill, r"set -euo pipefail")
    assert_matches(skill, r'case "\$POSITION" in')
    assert_matches(skill, r"jq -e -n")
    assert_matches(skill, r'--rawfile body "\$BODY_FILE"')
    assert_matches(skill, r'--argjson position "\$POSITION"')
    assert_matches(skill, r'test -s "\$PAYLOAD_FILE"')
    assert_matches(skill, r'--input "\$PAYLOAD_FILE"')
    assert_matches(skill, r"Never continue to `gh api` after any anchor, body, payload, or integer validation command fails")
    assert_matches(skill, r"Avoid shell-interpolated `--raw-field body=\.\.\.` values")
    assert_matches(skill, r"Do not add shell cleanup traps or `rm -f` cleanup to publication commands")
    assert_matches(skill, r"`POSITION` must be an integer in the JSON payload")
    assert_matches(skill, r"Do not add `line` or `subject_type` fields")
    assert_not_matches(skill, r'rm -f "\$BODY_FILE"')
    assert_not_matches(skill, r'rm -f "\$BODY_FILE" "\$PAYLOAD_FILE"')
    assert_matches(skill, r"<review_publication_status>STATUS</review_publication_status>")
    assert_matches(skill, r"<review_completion_action>ACTION</review_completion_action>")
    assert_matches(skill, r"Use `blocked` when any required fetch, duplicate gate, comment post, or approval fails")
    assert_matches(skill, r"`<commented_findings>N</commented_findings>` as the count actually posted after duplicate suppression")
    assert_matches(skill, r"PR file-list patch fetch, inline-comment refresh, and current-head identity check are the only permitted post-snapshot fetches")
    assert_matches(skill, r"compute valid GitHub inline anchors and prevent duplicate or stale publication")
    assert_matches(skill, r"pinned base SHA, head SHA, requirements, review scope, and validation evidence remain unchanged")


def test_gates_version_skew_findings_on_production_reachability() -> None:
    skill = read_skill_file("SKILL.md")
    assert_matches(skill, r"classify the producer/consumer\s+deployment topology from repo evidence")
    assert_matches(skill, r"Independently deployed services,\s+packages, clients, external APIs, persisted or replayed payloads, cached\s+artifacts, and generated files can have old/new skew")
    assert_matches(skill, r"Peers that ship atomically\s+inside one production artifact")
    assert_matches(skill, r"do not have old-peer/new-peer production skew unless the PR shows a\s+production path that can load mismatched artifacts")
    assert_matches(skill, r"still review tolerant parsing of missing, unknown, persisted, or corrupt data")
    assert_matches(skill, r"treat dev-only or partial-install\s+skew as residual risk rather than a required fix")
    assert_matches(skill, r"old producer/new consumer and new producer/old consumer behavior only when the boundary can actually deploy, persist, replay, or load those versions independently in production")


def test_prioritizes_concrete_runtime_defects_over_product_direction_opinions() -> None:
    skill = read_skill_file("SKILL.md")
    lens_map = read_skill_file("references/review-lens-map.md")
    assert_matches(skill, r"## Actionable Finding Standard")
    assert_matches(skill, r"off-by-one errors, division by zero")
    assert_matches(skill, r"cache keys and invalidation")
    assert_matches(skill, r"unbounded work or memory/API cost")
    assert_matches(skill, r"specific input or state, the execution path, and the observable incorrect result, crash, data loss, or security effect")
    assert_matches(skill, r"not substitute their preferred product behavior for the requested change")
    assert_matches(skill, r'"this will break migrations" needs a named migration or schema change')
    assert_matches(skill, r'Desktop and web "will drift" needs a named shared contract, both production consumers')
    assert_matches(skill, r'Do not return high-severity findings for "wrong product change,"')
    assert_matches(skill, r"missing, stale, or insufficient validation is normally a validation gap", re.IGNORECASE)
    assert_matches(skill, r"Apply the Actionable Finding Standard to every worker candidate")
    assert_not_matches(skill, r"highest-value part of the skill")
    assert_matches(lens_map, r"preferred architecture or product choice is not an actionable code finding")
    assert_matches(lens_map, r"Claim breakage only after identifying the specific mismatched object and failing production path")
    assert_matches(lens_map, r"human architecture concerns against production behavior without treating the comment's authority as proof")


def test_pins_closedloop_document_fetch_argument_shape() -> None:
    skill = read_skill_file("SKILL.md")
    assert_matches(skill, r'get_document\(\{ "documentId": "ISS-8254", "includeContent": true \}\)')
    assert_matches(skill, r"do not use an `identifier` argument")
    assert_matches(skill, r"Primary requirement references are `FEA-\*`, `ISS-\*`, `PRD-\*`, `PLN-\*`")
    assert_matches(skill, r"Other body mentions are supporting references")
    assert_matches(skill, r"only supporting references failed after primary grounding succeeded")


def test_uses_closedloop_graph_intelligence_as_advisory_context() -> None:
    skill = read_skill_file("SKILL.md")
    assert_matches(skill, r"## ClosedLoop Graph Intelligence")
    assert_matches(skill, r"closedloop-intel")
    assert_matches(skill, r"closedloop-graph")
    assert_matches(skill, r"get_routing_protocol")
    assert_matches(skill, r"closedloop_graph_packet: <ClosedLoop graph intelligence packet or unavailable/not_applicable>")
    assert_matches(skill, r"closedloop_graph_packet_path: <absolute path to full packet artifact, or none>")
    assert_matches(skill, r"graph_review_focus: <orchestrator-derived graph focus packet, or pending until built>")
    assert_matches(skill, r"Gather ClosedLoop graph intelligence with this deterministic sequence")
    assert_matches(skill, r"Call `get_routing_protocol` once")
    assert_matches(skill, r"set every route section below to `skipped: graph_unavailable`")
    assert_matches(skill, r"query_collisions: skipped: route_unscoped_for_target")
    assert_matches(skill, r"## Review Orchestrator Graph Use")
    assert_matches(skill, r"must actively use graph intelligence before worker")
    assert_matches(skill, r"Do not treat `closedloop_graph_packet` as passive context")
    assert_matches(skill, r"Before launching workers, build and pass this `graph_review_focus` packet")
    assert_matches(skill, r"Use the packet to decide which optional lanes are applicable")
    assert_matches(skill, r"## Supplemental Lane Graph Calls")
    assert_matches(skill, r"The precomputed packet is the shared baseline, not a ceiling")
    assert_matches(skill, r"Start with the `closedloop-intel` skill when it is available")
    assert_matches(skill, r"Start from pinned target seeds")
    assert_matches(skill, r"follow material graph leads for one adjacent pass")
    assert_matches(skill, r"exact path, qualified symbol, test file, model/table name, route string")
    assert_matches(skill, r"database reviewer checking callers of code that consumes a changed persisted model")
    assert_matches(skill, r"normally at most three supplemental route calls per lane")
    assert_matches(skill, r"finish a material one-hop lead")
    assert_matches(skill, r"Prefer these routes by lane, but treat the live routing protocol and the concrete review question as authoritative")
    assert_matches(skill, r"Graph intelligence is advisory review context")
    assert_matches(skill, r"must not broaden the pinned review target")
    assert_matches(skill, r"default branch or main mirror, not the PR head")
    assert_matches(skill, r"verified against the pinned target packet, local source, frozen diff, or fetched requirement packet")
    assert_matches(skill, r"Never use local closedloop-intel checkouts, local ledger files, direct database access")
    assert_matches(skill, r"Record graph gaps instead of blocking")
    assert_matches(skill, r"Review workers use `closedloop-graph` because a diff-only review is naturally")
    assert_matches(skill, r"off-diff callers, consumers, tests, ownership boundaries")
    assert_matches(skill, r"approach reviewers use it to find the source-of-truth module")
    assert_matches(skill, r"correctness and contract reviewers use it to find callers, consumers")
    assert_matches(skill, r"guardrail and E2E reviewers use it to find existing tests")
    assert_matches(skill, r"database reviewers use it to find persisted consumers")
    assert_matches(skill, r"security reviewers use it to find entrypoints, trust boundaries")
    assert_matches(skill, r"ClosedLoop graph: <packet source; packet routes used; supplemental data-bearing lane calls; no-material reasons/caveats \| unavailable \| not_applicable>")
    assert_not_matches(skill, r"mcp__closedloop_graph")


def test_names_concrete_closedloop_graph_routes_for_review_lanes() -> None:
    skill = read_skill_file("SKILL.md")
    for route in GRAPH_ROUTES:
        assert f"`{route}`" in skill, route
    assert_matches(skill, r"if `closedloop_graph_packet.blast_radius` contains callers, dependents, prior related tickets, or source snippets")
    assert_matches(skill, r"if `closedloop_graph_packet.test_impact` contains `code_tests_for` results")
    assert_matches(skill, r"if `closedloop_graph_packet.blast_radius`, `scope_overlap`, or `architecture_context` contains entrypoints")
    assert_matches(skill, r"A graph-only concern that cannot be verified against the pinned target snapshot must be returned as residual risk")
    assert_matches(skill, r"Every reviewer\s+worker must perform a bounded live graph check before finalizing its lane")
    assert_matches(skill, r"must not treat the packet as\s+sufficient merely because it exists")
    assert_matches(skill, r"one `get_routing_protocol` call per worker session")
    assert_matches(skill, r"at least one lane-owned route call from the pinned seeds")
    assert_matches(skill, r"Acceptable\s+reasons are `graph_unavailable`, `route_unavailable`, `no_lane_seed`, or\s+`no_material_graph_evidence`")
    assert_matches(skill, r'do not use a vague reason such as "not needed"')
    assert_matches(skill, r"Every worker return must include:")
    assert_matches(skill, r"Graph Evidence Used")
    assert_matches(skill, r"packet_routes_used:")
    assert_matches(skill, r"supplemental_graph_calls:")
    assert_matches(skill, r"verified_source_paths:")
    assert_matches(skill, r"Reconcile every worker's `Graph Evidence Used` section against `graph_review_focus`")


def test_scopes_closedloop_graph_queries_to_the_pinned_target_snapshot() -> None:
    skill = read_skill_file("SKILL.md")
    assert_matches(skill, r"after the target is pinned and before launching reviewers")
    assert_matches(skill, r"Build deterministic seeds only from the pinned target packet")
    assert_matches(skill, r"`documentSeeds`: ClosedLoop slugs or URLs already found during Requirement Grounding")
    assert_matches(skill, r"`fileSeeds`: every path in `included_files`")
    assert_matches(skill, r"`symbolSeeds`: changed exported functions, classes, types, commands, route handlers, schema objects, or configuration keys visible in the pinned diff")
    assert_matches(skill, r"frozen into the target packet too")
    assert_matches(skill, r"do not rebuild or refresh that shared packet")
    assert_matches(skill, r"add files from graph results to the target")
    assert_matches(skill, r"update requirements from graph results")
    assert_matches(skill, r"broaden review scope from graph results")
    assert_matches(skill, r"Bounded supplemental lane graph calls are allowed only under")
    assert_matches(skill, r"PR file-list patch fetch, inline-comment refresh, and current-head identity check are the only permitted post-snapshot fetches")


def test_bundled_prompt_pack_resolves_every_lens_path() -> None:
    lens_map = read_skill_file("references/review-lens-map.md")
    lens_paths = sorted(set(LENS_PATH_RE.findall(lens_map)))

    assert lens_paths
    for lens_path in lens_paths:
        assert (BUNDLED_PROMPT_PACK / lens_path).is_file(), lens_path


def test_prompt_pack_discovery_defaults_to_bundled_root() -> None:
    skill = read_skill_file("SKILL.md")

    assert "WORKFLOW_PROMPT_PACK_ROOT" in skill
    assert "`references/prompt-pack/`" in skill
    assert "Verify the bundled root contains a `sections/` directory" in skill
    assert (BUNDLED_PROMPT_PACK / "sections").is_dir()
    assert not (BUNDLED_PROMPT_PACK / "orchestrator.md").exists()


def test_guardrail_assessment_points_fixers_at_prevent_recurrence() -> None:
    skill = read_skill_file("SKILL.md")

    assert_matches(skill, r"This assessment only recommends\.")
    assert_matches(skill, r"`/closedloop-core:prevent-recurrence`")
    assert (PLUGIN_ROOT / "skills" / "prevent-recurrence" / "SKILL.md").is_file()
