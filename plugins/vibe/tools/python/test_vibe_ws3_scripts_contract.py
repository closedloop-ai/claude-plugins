"""Contract checks for the WS3 deterministic scripts (PRD-823, ISS-13343 to ISS-13351).

1. Each script wraps what already exists and never copies it: the wrapped scripts and the target
   repository's own gates are named in the script, and the script is wired into the worker or
   reference that its mechanical steps came from.
2. Behavior-preserving: every worker keeps working without the script ("Without the script ...
   unchanged"), and no existing path was deleted.
3. No script writes words for the person: the sentences it can return are the ones the plugin's own
   docs already carry, word for word.
4. A skipped, absent, cached or not-run step is never a pass.
5. The guardrails findings file keeps exactly the shape WS4's reviewer reads.
6. ticket-ctl holds no credential source (D9 is blocked on the owner's ruling).
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
HANDOFF = PLUGIN_ROOT / "skills" / "handoff"
SCRIPTS = VIBE / "scripts"
HANDOFF_SCRIPTS = HANDOFF / "scripts"
REFERENCES = VIBE / "references"

ALL_SCRIPTS = {
    "setup-ctl.mjs": SCRIPTS,
    "env-ctl.mjs": SCRIPTS,
    "graph-pack.mjs": SCRIPTS,
    "guardrails-gate.mjs": HANDOFF_SCRIPTS,
    "verify-run.mjs": SCRIPTS,
    "req-gather.mjs": SCRIPTS,
    "inventory-bundle.mjs": HANDOFF_SCRIPTS,
    "prototype-share.mjs": SCRIPTS,
    "ticket-ctl.mjs": SCRIPTS,
    "ws3-exec.mjs": SCRIPTS,
}


def source(name: str) -> str:
    return (ALL_SCRIPTS[name] / name).read_text()


def code_lines(name: str) -> str:
    """The script's lines with the `//` comment lines removed."""
    return "\n".join(line for line in source(name).split("\n") if not line.strip().startswith("//"))


def test_every_script_has_node_tests_beside_it() -> None:
    for name, folder in ALL_SCRIPTS.items():
        if name == "ws3-exec.mjs":
            continue
        assert (folder / name.replace(".mjs", ".test.mjs")).exists(), name


def test_each_worker_points_at_its_script_and_keeps_working_without_it() -> None:
    pointers = {
        "vibe-setup-worker": ("setup-ctl.mjs", "Without the script, follow the steps below unchanged."),
        "vibe-environment-worker": ("env-ctl.mjs", "Without the script, or for a case it"),
        "vibe-verify-worker": ("verify-run.mjs", "Without\nthe script, run the checks below unchanged."),
        "vibe-guardrails-reviewer": ("guardrails-gate.mjs", "Without the script, run the checks below\nunchanged."),
        "vibe-requirements-worker": ("req-gather.mjs", "Without the script, work as below."),
        "vibe-prototype-worker": ("prototype-share.mjs", "Without the script, follow the\nparagraphs below unchanged."),
        "vibe-ticket-worker": ("ticket-ctl.mjs", "Without\nthe script, edit the body by hand as the rules above say."),
        "vibe-handoff-summarizer": ("inventory-bundle.mjs", "is derived by hand as\nbefore."),
    }
    for name, (script, fallback) in pointers.items():
        text = agent(name)
        assert script in text, (name, script)
        assert flat(fallback) in flat(text), (name, fallback)


def test_the_graph_pack_is_wired_into_the_graph_reference_and_never_claims_the_graph() -> None:
    text = flat((REFERENCES / "closedloop-graph.md").read_text())
    assert "graph-pack.mjs" in text
    assert "It is not graph evidence" in text
    assert "the Graph block below is not satisfied by the pack" in text
    pack = source("graph-pack.mjs")
    assert "not the closedloop-graph" in pack
    for call in ("code_tests_for", "blast_radius_tickets", "query_collisions", "code_callers", "code_importers", "code_symbols"):
        assert f'"{call}"' in pack, call


def test_scripts_wrap_the_existing_scripts_and_gates_instead_of_copying_them() -> None:
    expectations = {
        "setup-ctl.mjs": ("vibe-preflight.sh", "run-bounded.mjs", "vibe-sessions.mjs", "loops-setup.sh"),
        "env-ctl.mjs": ("vibe-sessions.mjs", "posthog-key.mjs", "local-plans.mjs", "migration-publish.mjs", "pr-preflight.mjs", "DISPATCH_WORKFLOW"),
        "verify-run.mjs": ("run-bounded.mjs", "pre-pr-lanes.mjs", "reportLanes", "check:source-gates", "typecheck:affected", "biome"),
        "guardrails-gate.mjs": ("runDiffRules", "parseUnifiedDiff", "check:source-gates", "biome", "isTestFile"),
        "prototype-share.mjs": ("local-plans.mjs", "main-sync-share", "main-sync-push", "prototype-result"),
        "inventory-bundle.mjs": ("createGraphPack", "storyId", "parseUnifiedDiff"),
        "req-gather.mjs": ("createGraphPack",),
        "ticket-ctl.mjs": ("parseSections", "TICKET_SECTIONS", "ticket-sections"),
    }
    for name, needles in expectations.items():
        text = source(name)
        for needle in needles:
            assert needle in text, (name, needle)


def test_the_gate_scripts_do_not_reimplement_the_repository_rules() -> None:
    gate = source("guardrails-gate.mjs")
    verify = source("verify-run.mjs")
    for text in (gate, verify):
        assert '"exec", "biome", "check"' in text
        assert "check:source-gates" in text
    # No rule engine of its own: the wrapped gates are invoked, their rule files never read.
    assert "biome.json" not in gate and "source-gate-allowlist" not in gate


def test_the_env_ctl_never_bypasses_hooks_force_pushes_merges_or_arms_auto_merge() -> None:
    code = code_lines("env-ctl.mjs")
    for forbidden in ("--no-verify", "SKIP_PREPUSH_GATES", "--force", '"merge"', "--auto", "pr merge", "git push", '"push"'):
        assert forbidden not in code, forbidden
    # The push is the sessions script's exact-SHA gate, and no environment request starts without it.
    assert '"main-sync-push"' in code
    assert "vibe-environment.yml" in code and "never start" not in code


def test_env_ctl_reuses_the_environment_workers_own_sentences() -> None:
    worker = flat(agent("vibe-environment-worker"))
    code = source("env-ctl.mjs")
    for constant in ("NO_ANALYTICS_KEY", "NOT_CONFIRMED_READY"):
        sentence = re.search(rf'export const {constant} = "([^"]+)";', code)
        assert sentence is not None, constant
        assert sentence.group(1) in worker, constant


def test_setup_ctl_returns_only_sentences_preflight_md_writes_and_runs_only_the_no_person_fixes() -> None:
    preflight = flat((REFERENCES / "preflight.md").read_text())
    code = source("setup-ctl.mjs")
    claude = re.search(r'export const CLAUDE_SIGN_IN_WORDS = "([^"]+)";', code)
    assert claude is not None and claude.group(1) in preflight
    folder = re.search(r"folderAccessWords = \(folder\) => `([^`]+)`", code)
    assert folder is not None
    assert folder.group(1).replace("${folder}", "<folder>") in preflight
    auto = re.search(r"export const AUTO_FIXES = Object.freeze\(\{(.*?)\n\}\);", code, re.DOTALL)
    assert auto is not None
    assert set(re.findall(r'^  "([a-z-]+)":', auto.group(1), re.MULTILINE)) == {"install-pnpm", "brew-install-jq", "brew-install-gh"}
    # Each automatic fix is the exact command preflight.md's table gives.
    assert "`corepack enable && corepack prepare pnpm@latest --activate`" in preflight
    assert "`brew install jq`" in preflight and "`brew install gh`" in preflight
    # Nothing that needs the Mac password, a sign-in or plugin installation is ever run.
    for forbidden in ("sudo", "auth login", "curl", "plugin", "install-homebrew", "install-node"):
        assert forbidden not in auto.group(1), forbidden
    assert 'fix.includes("plugin add")' in code


def test_setup_ctl_discards_only_after_confirmation_and_never_from_the_target() -> None:
    code = code_lines("setup-ctl.mjs")
    assert "confirmed" in code and '"--confirm"' in code
    assert "the retained checkout is the target or inside it" in code
    for forbidden in ("pkill", "killall", "process.kill(-"):
        assert forbidden not in code, forbidden


def test_verify_run_never_reports_a_skip_cache_or_no_op_as_a_pass() -> None:
    text = source("verify-run.mjs")
    for status in ('"passed"', '"failed"', '"blocked"', '"cached"', '"main-preexisting"', '"no-op"', '"skipped"', '"not-run"'):
        assert status in text, status
    assert "evidenceStatus === Status.Passed || check.status === Status.Cached" not in text
    assert "check.status === Status.Passed || check.status === Status.Cached" in text
    assert "A skipped, no-op, cached or not-run entry is never a pass" in flat(text.replace("// ", ""))
    worker = flat(agent("vibe-verify-worker"))
    assert "a skipped, no-op, cached or not-run entry is never reported as a pass" in worker
    assert "`leftToWorker` list (E2E specs, story plays, touch flows, the control sweep) is still yours" in worker
    # The strict five-word vocabulary is not built here (plan item S6) and is not claimed.
    assert "REMOTE_PENDING" not in text and "NOT_APPLICABLE" not in text


def test_verify_run_uses_fixed_limits_and_no_timeout_override() -> None:
    text = source("verify-run.mjs")
    assert "TIME_LIMITS" in text
    assert "--timeout" not in text and "timeout-override" not in text


def test_guardrails_findings_contract_is_exactly_the_shape_ws4_reads() -> None:
    doc = (REFERENCES / "guardrails-findings.md").read_text()
    text = flat(doc)
    assert "This file is the one canonical statement of its shape" in text
    for required in (
        '"schema": "vibe.guardrails-findings/1"',
        '"head": "<sha>"',
        '"base": "<sha>"',
        '"id": "<stable id>"',
        '"check": "<check name>"',
        '"file": "<path>"',
        '"severity": "high|medium|low"',
        '"message": "<text>"',
        '"evidence": "<string>"',
        '"checks_run": ["<name>"]',
        '"checks_skipped": [{ "name": "<name>", "reason": "<text>" }]',
    ):
        assert required in doc, required
    assert "The top level has exactly these six keys; each finding has exactly the seven keys above." in text
    assert "A check that did not run, for any reason, is in `checks_skipped` with its reason and never in `checks_run`." in text
    assert "it never says a skipped or absent check passed" in text
    code = source("guardrails-gate.mjs")
    assert 'export const FINDINGS_SCHEMA = "vibe.guardrails-findings/1";' in code
    assert '"base,checks_run,checks_skipped,findings,head,schema"' in code
    assert '"check,evidence,file,id,line,message,severity"' in code
    for check in re.findall(r"^\| `([a-z-]+)` \|", section(doc, "Checks:") if "Checks:" in doc else doc, re.MULTILINE) or re.findall(r"^\| `([a-z-]+)` \|", doc, re.MULTILINE):
        assert f'"{check}"' in code, check
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    assert "an empty `findings` list proves nothing about a check that did not run" in reviewer


def test_the_gate_lists_the_reviewers_judgment_checks_as_skipped_never_as_run() -> None:
    code = source("guardrails-gate.mjs")
    for name in ("main-sync-regressions", "copy-provenance", "accessibility", "shared-owner"):
        assert f'name: "{name}"' in code, name
    assert "for (const entry of REVIEWER_CHECKS) handle.skip(entry.name, entry.reason);" in code
    assert "report.checks_skipped.some((entry) => !REVIEWER_CHECK_NAMES.has(entry.name)) ? 3 : 0" in code


def test_req_gather_lists_missing_queries_and_cannot_make_them() -> None:
    code = source("req-gather.mjs")
    for query in ("ticket_detail", "get-document-comments", "query_collisions", "code_symbols", "blast_radius_tickets", "search_nodes", "shipped_lineage"):
        assert f'"{query}"' in code, query
    graph = (REFERENCES / "closedloop-graph.md").read_text()
    row = next(line for line in graph.split("\n") if line.startswith("| `vibe-requirements-worker`"))
    for query in ("query_collisions", "code_symbols", "blast_radius_tickets", "search_nodes"):
        assert query in row, query
    assert "return evidence.queries.missing.length === 0 ? 0 : 3;" in code
    worker = flat(agent("vibe-requirements-worker"))
    assert "a brief must not be written as if it had been made" in worker
    assert "fetch(" not in code and "process.env" not in code


def test_handoff_inventory_adds_the_bundle_additively_and_never_fails_on_it() -> None:
    inventory = (HANDOFF_SCRIPTS / "handoff-inventory.mjs").read_text()
    assert '...(values.phase === "build" ? {} : { bundle: buildBundle() }),' in inventory
    bundle = source("inventory-bundle.mjs")
    assert "return { unavailable:" in bundle
    assert "Every field is read from the diff, the session record" in flat(bundle.replace("// ", ""))
    for field in ("backendPaths", "guards", "flagKeys", "storybookLinks", "blastBundle"):
        assert field in bundle, field


def test_storybook_links_follow_the_environment_reference_rule() -> None:
    env = flat((REFERENCES / "environment.md").read_text())
    assert "`<storybook-base>/?path=/story/<story-id>`" in env
    bundle = source("inventory-bundle.mjs")
    assert "/?path=/story/" in bundle and "iframe.html" not in code_lines("inventory-bundle.mjs")


def test_prototype_share_accepts_only_the_deployments_own_url_and_stops_on_failure() -> None:
    code = source("prototype-share.mjs")
    assert "/p/${slug}" in code
    assert "url.search || url.hash" in code
    assert 'STOP_STATES = new Set(["failure", "error", "inactive"])' in code
    for forbidden in ("vercel ", "git commit", "git stash", "--force", "alias"):
        assert forbidden not in code_lines("prototype-share.mjs").replace("an alias", "").replace("a deployment alias", ""), forbidden


def test_ticket_ctl_holds_no_credential_source_and_names_the_blocker() -> None:
    code = code_lines("ticket-ctl.mjs")
    for forbidden in ("process.env", "fetch(", "Authorization", "Bearer", "apiKey", "api_key", "createClient", "https.request", "http.request", "readFileSync(process"):
        assert forbidden not in code, forbidden
    header = flat(source("ticket-ctl.mjs").split("import ")[0].replace("// ", ""))
    assert "blocked on an owner ruling about long-lived static credentials" in header
    assert "there is no default, so no command-line subcommand reads or writes a ticket" in header
    worker = flat(agent("vibe-ticket-worker"))
    assert "it reads and writes no ticket and holds no credential" in worker.lower()
    assert "blocked on the owner's ruling about static credentials" in worker


def test_ticket_ctl_formats_match_the_template_rules() -> None:
    template = flat((REFERENCES / "ticket-template.md").read_text())
    code = source("ticket-ctl.mjs")
    lines = re.findall(r"`(- \[ \] [^`]+)`", template)
    assert lines
    # Every format ticket-ctl renders appears in the template's rules, with its placeholders in place.
    for rendered in (
        "- [ ] Resolve conflict: ${e.what}; decided: ${e.decided}; evidence: ${e.evidence}",
        "- [ ] Engineering needed (forbidden path): ${e.area}; why: ${e.why}",
        "- [ ] Engineering decision: ${e.question}; built: ${e.built}; evidence: ${e.evidence}",
        "- [ ] Check ran out of time on this machine: ${e.check}; also on captured main ${e.mainSha}; limit ${e.minutes} min; run it on a faster machine or CI",
        "- [ ] E2E left for CI: ${e.lane}; covered by ${e.coverage}; confirm it is green on the merge commit",
        "- [ ] Criterion waits on ${e.ticket}: ${e.criterion}; not met until it ships",
        "- [ ] Check compile-only repair to v1.0: ${e.file}; confirm only prop, import or type changes and no visual change",
    ):
        assert rendered in code, rendered
    expected = [
        "- [ ] Resolve conflict: <what disagreed>; decided: <how>; evidence: <doc section or precedent paths>",
        "- [ ] Engineering needed (forbidden path): <path or area>; why: <need>",
        "- [ ] Engineering decision: <question>; built: <what the session built>; evidence: <files, records or finding>",
        "- [ ] Check ran out of time on this machine: <check>; also on captured main <mainSha>; limit <minutes> min; run it on a faster machine or CI",
        "- [ ] E2E left for CI: <lane>; covered by <its coverage>; confirm it is green on the merge commit",
        "- [ ] Criterion waits on <ticket>: <criterion>; not met until it ships",
        "- [ ] Check compile-only repair to v1.0: <file>; confirm only prop, import or type changes and no visual change",
    ]
    for line in expected:
        assert line in template, line


def test_ws3_adds_no_new_hook_registration_and_changes_no_default_path() -> None:
    hooks = (PLUGIN_ROOT / "hooks" / "hooks.json").read_text()
    for name in ALL_SCRIPTS:
        assert name not in hooks, name
    for name in ("vibe-setup-worker", "vibe-environment-worker", "vibe-verify-worker", "vibe-guardrails-reviewer"):
        text = agent(name)
        # The original steps are all still there: the script is an addition before them.
        assert "## Do" in text or "## Create mode" in text or "## Existing checks" in text or "## Check, for added or changed lines only" in text, name
