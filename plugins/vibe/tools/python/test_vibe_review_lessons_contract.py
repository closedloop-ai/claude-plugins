"""Contract checks for the 2026-10-16 operator ruling on the reviews of the first
two vibe feature pull requests in symphony-alpha (#8885 grouped list sections,
#8886 bulk add tag).

Each lesson lands in the agent or reference section that owns the behavior.
Where a rule already existed and was not followed, the owner now carries a
concrete check with evidence. The docs-draft exception of 2026-10-13 is
retired: nothing agent-written goes into public docs.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REFERENCES = PLUGIN_ROOT / "skills" / "vibe" / "references"
GUARDRAILS = REFERENCES / "guardrails.md"
DESIGN_PASS = REFERENCES / "design-pass.md"
QUALITY = REFERENCES / "quality-loop.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
DIFF_RULES = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "diff-rules.mjs"
CL_EXECUTE_PR = PLUGIN_ROOT / "skills" / "cl-execute" / "references" / "implementation-review-pr.md"
RULING = "operator ruling, 2026-10-16"


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def reviewer_check(number: int) -> str:
    """One numbered check of the guardrails reviewer, flattened."""
    text = section(agent("vibe-guardrails-reviewer"), "## Check, for added or changed lines only")
    start = text.index(f" {number}. ")
    following = text.find(f" {number + 1}. ", start)
    return text[start:] if following == -1 else text[start:following]


def test_main_sync_capability_removal_is_a_reviewer_check_on_every_merge() -> None:
    check = reviewer_check(13)
    assert_all(check, (
        RULING,
        "check every main-sync merge in the session, not only the latest",
        "--merges",
        "diff the merge result against main's side",
        "is read-only, disabled, hidden or gone after the merge is blocking capability removal",
        "so is a test the merge or a later session commit changed to pin the reduced behavior",
        "Quote both sides.",
    ))
    writer = flat(agent("vibe-change-worker"))
    assert "A conflict is never resolved by taking away what main ships" in writer
    assert "no test is changed to pin a reduced behavior" in writer
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "Every main sync is checked for capability removal, this one included" in handoff
    assert "dispatch `vibe-guardrails-reviewer` for its check 13 on that merge" in handoff


def test_version_history_is_one_entry_at_the_next_version_and_checked() -> None:
    rule = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    assert_all(rule, (
        "A session is one release: exactly one new Version History entry, at the next version",
        "special-case a validator, test or key (a duplicate-key exception) so two entries can coexist",
        "After a main sync, the session's entry moves to the next version after main's.",
    ))
    check = reviewer_check(10)
    assert_all(check, (
        "`apps/storybook/stories/start-here-version-history.stories.tsx`",
        "More than one new entry, an entry whose version is not the next after the base's `version`",
        "special-cased so two entries can coexist (a duplicate-key exception) is blocking",
    ))
    assert "Version History: the session's new entries" in flat(agent("vibe-storybook-decomposer"))


def test_a_compile_only_repair_rewords_no_prose_and_is_read_word_by_word() -> None:
    rule = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    assert "A compile-only repair rewords no comment, description, docs parameter or story text either" in rule
    check = reviewer_check(10)
    assert "`git -C <wt> diff --word-diff <base> <file>`" in check
    assert "a reworded comment, description, docs parameter or story text is blocking" in check
    assert "A compile-only repair rewords no comment, description, docs parameter or story text" in flat(agent("vibe-change-worker"))


def test_lost_and_stale_story_ids_are_searched_and_block() -> None:
    rule = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    assert "the inventory's `lost-story-id` findings name every reference left" in rule
    assert "`lost-story-id` findings block" in reviewer_check(10)
    assert "`lost-story-id` finding, a lost story ID or a reference still naming one, blocks too" in flat(HANDOFF_SKILL.read_text())
    rules = DIFF_RULES.read_text()
    assert '"lost-story-id"' in rules
    for spec in ('"e2e/"', '"docs/"', '"apps/web/content/docs/"', '".claude/"', '"*.test.*"', '"*.stories.*"'):
        assert spec in rules, spec


def test_a_slot_alone_is_not_a_shared_owner() -> None:
    rules = section(DESIGN_PASS.read_text(), "## Owner rules")
    assert_all(rules, (
        "A slot alone is not an owner",
        "(selection, grouping, collapse, paging) live in the parent or in one shared hook",
        "Two children that each keep their own copy of that state behind the parent's slot",
    ))
    check = reviewer_check(8)
    assert_all(check, (
        "Slot without an owner",
        "Two children that each hold their own copy behind the parent's slot is blocking, the ISS-12137 red flag",
        "Private copies",
        "a duplicated band or status icon map",
    ))


def test_each_acceptance_criterion_maps_to_every_surface_it_names() -> None:
    rule = section(QUALITY.read_text(), "## Acceptance criteria before ready")
    assert_all(rule, (
        "Each criterion also carries a `Surfaces:` line",
        "a list and a board are two",
        "A criterion is met only when every surface on that line has its own `met` check",
    ))
    adversary = flat(agent("vibe-adversarial-reviewer"))
    assert_all(adversary, (
        "Acceptance criteria per surface",
        "A surface with no such code, or whose only `### Checks` line traces a different surface, is a finding",
    ))


def test_nothing_agent_written_goes_into_public_docs() -> None:
    docs = section(GUARDRAILS.read_text(), "## Feature docs at handoff")
    assert_all(docs, (
        f"Nothing agent-written goes into public docs ({RULING}).",
        "No worker edits, creates or drafts anything under `apps/web/content/docs/`",
        "it never carries drafted words",
        "reports any change under either folder as outside the allowed paths in every phase",
    ))
    copy = section(GUARDRAILS.read_text(), "## Copy")
    assert "There is no exception" in copy
    assert "scoped exception" not in copy
    table = next(line for line in GUARDRAILS.read_text().splitlines() if line.startswith("| `packages/app/**`"))
    assert "`apps/web/content/docs/**`" in table.split("|")[2]
    assert "`outsideAllowed` already blocks every docs path" in reviewer_check(4)
    inventory = INVENTORY.read_text()
    assert "isExistingDocsEdit" not in inventory
    assert "PRODUCT_DOCS_PREFIX" not in inventory
    for path in (GUARDRAILS, HANDOFF_SKILL, TICKET_TEMPLATE, PLUGIN_ROOT / "README.md"):
        assert "Agent draft (<live ticket slug>)" not in path.read_text(), path.name
    for name in ("vibe-change-worker", "vibe-guardrails-reviewer", "vibe-ticket-worker"):
        text = flat(agent(name))
        assert "marked agent draft" not in text, name
        assert "feature docs drafts are the one scoped exception" not in text, name


def test_flag_retirement_reads_linked_ticket_comments_and_a_hold_needs_a_human() -> None:
    check = reviewer_check(14)
    assert_all(check, (
        "read the comments on every ticket linked to the flag",
        "`get-document-comments`",
        "A recorded hold, rollout pause or parity list on the flag with no later human answer",
        "is a blocking `engineering decision` finding",
        "even when an acceptance criterion asks for the old path to go",
    ))
    writer = flat(agent("vibe-change-worker"))
    assert "Before you delete a feature flag's read, key constant or gate, read the comments on every ticket linked to it" in writer
    assert "means the flag stays" in writer


def test_leftovers_after_an_extraction_are_a_red_flag_with_a_concrete_check() -> None:
    flags = section(DESIGN_PASS.read_text(), "### Red flags")
    assert_all(flags, (
        "Leftovers: what an extraction, move or deletion leaves behind",
        "a re-export alias",
        "a loop or `each` table over the one arm left after a matrix arm was deleted",
        "a test still named or placed after a module that was deleted or moved",
        "Hard-coded host keys",
    ))
    check = reviewer_check(8)
    assert "`git -C <wt> diff --name-status -M <base>`" in check
    assert "a re-export alias, an export with no remaining importer, a prop no caller passes" in check
    assert "An extraction, move or deletion is finished only when nothing it orphaned is left" in flat(agent("vibe-change-worker"))


def test_reviewer_flags_checks_nobody_asked_for_and_test_oracles_from_production_code() -> None:
    assert "Never add a check nobody asked for" in section(GUARDRAILS.read_text(), "## Checks")
    check = reviewer_check(9)
    assert_all(check, (
        "So is a new check nobody asked for",
        "a shared test helper widened to support one",
        "one computed by calling production code",
    ))


def test_pull_request_tests_follow_the_review_rules() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert_all(writer, (
        "Every entry on the missing tests list is written in this turn.",
        "Each test goes in the suite and lane that owns its subject",
        "Expected values are literals or the spec's words, never computed by calling production code",
        "a windowed or paged fixture is built with the repo's real paging helper",
        "every acceptance criterion has at least one test whose name or `describe` title carries its ID",
        "tested through the real web and Desktop host adapters",
        "a same-route link that changes only the query and the Back button",
    ))
    verify = flat(agent("vibe-verify-worker"))
    assert_all(verify, (
        "names the acceptance criterion IDs it covers",
        "the same-route link and Back cases",
        "an entry still listed as missing there is a finding",
    ))


def test_verify_runs_sort_order_tests_containerized_e2e_and_reads_ci_tiers() -> None:
    verify = flat(agent("vibe-verify-worker"))
    assert "apps/storybook/__tests__/preview-story-sort-order.test.ts" in DIFF_RULES.read_text()
    assert_all(verify, (
        "`diffRules.requiredTests`",
        "runs at handoff through the repo's containerized path (the `local-ci` skill, `dagger call e-2-e`)",
        "read `.github/pr-test-event-tiers.md` and cite the tier",
    ))
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "`dagger call e-2-e`" in handoff
    assert "`.github/pr-test-event-tiers.md`" in handoff


def test_storybook_owner_checks_states_names_fixtures_and_surfaces() -> None:
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert_all(decomposer, (
        "A whole-page flow (the page a route renders, or several sections composed into one flow) is never a Composite entry",
        "gets a story on the component consumers render",
        "built by calling the repo's real paging helper",
        "A story's name says only what its args and play function show and assert",
        "never cast",
    ))


def test_adversary_checks_selections_gates_and_per_row_enums() -> None:
    adversary = flat(agent("vibe-adversarial-reviewer"))
    assert_all(adversary, (
        "must account for every selected row, including the ones it cannot act on",
        "a product question the writer settles through `quality-loop.md`, \"Precedent before asking\"",
        "gated on the host's capability",
        "a gate one host has and the other lacks is a finding",
        "Parse it per row with a safe fallback for an unknown value",
    ))
    writer = flat(agent("vibe-change-worker"))
    assert "An action over selected rows accounts for every selected row" in writer
    assert "settle it through `quality-loop.md`, \"Precedent before asking\", before building; ask the person only when that fails" in writer
    assert "### Precedent before asking" in QUALITY.read_text()


def test_an_outdated_plugin_question_comes_before_the_endings_line() -> None:
    version = section(VIBE_SKILL.read_text(), "### Plugin version")
    assert "That question is the whole first reply: the endings line of a new session" in version
    assert "The next reply is then the new session's first reply, endings line included" in version
    starting = section(VIBE_SKILL.read_text(), "### Starting new")
    assert_all(starting, (
        "after the plugin version check (section 1, \"Plugin version\")",
        "when the version is current or unknown it goes in the very first reply",
        "the version question comes first on its own and the endings line goes in the first reply after the person answers it",
    ))
    endings = flat(VIBE_SKILL.read_text())
    assert "The one thing that comes before it is an outdated plugin's version question" in endings
    order = [
        endings.index("Every `$vibe` start, new or resume, first checks whether this plugin is the latest release"),
        endings.index("1. Your first reply to the new session carries the endings line"),
    ]
    assert order == sorted(order)


def test_reuse_and_wording_checks_grep_shared_owners_first() -> None:
    assert "`shared/auth` included) and the existing `use-*` hooks (such as `use-tags`)" in reviewer_check(1)
    assert "a second spelling of wording a shared helper or label map already renders is blocking" in reviewer_check(4)
    check = reviewer_check(7)
    assert "any `as` cast, stories included" in check
    assert "`rg` that literal across `apps/app`, `apps/desktop/src/renderer` and `packages/app`" in check
    writer = flat(agent("vibe-change-worker"))
    assert "`rg` `packages/app/shared` (`shared/auth` included) and the existing `use-*` hooks (such as `use-tags`)" in writer


def test_pr_body_files_are_named_per_ticket_and_read_back_before_gh() -> None:
    environment = section(agent("vibe-environment-worker"), "## Pull-request mode")
    assert_all(environment, (
        "named for the live ticket (`pr-body-<live ticket slug>.md`), never a shared name such as `pr-body.md`",
        "Read the file back right before the `gh` command",
        "the file named and re-read as step 4 says",
    ))
    cl_execute = flat(CL_EXECUTE_PR.read_text())
    assert "(`pr-body-<ticket slug>.md`, never a shared name such as `pr-body.md`)" in cl_execute
    assert "read it back right before `gh pr create` or `gh pr edit --body-file`" in cl_execute
    assert "read back right before the command" in flat(agent("vibe-seed-pr-worker"))


def test_new_text_uses_no_emdashes_or_double_hyphen_dashes() -> None:
    for name in ("vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-change-worker",
                 "vibe-verify-worker", "vibe-storybook-decomposer", "vibe-environment-worker",
                 "vibe-ticket-worker"):
        text = agent(name)
        assert "—" not in text, name
        assert " -- " not in text, name
    for path in (GUARDRAILS, DESIGN_PASS, QUALITY, HANDOFF_SKILL, TICKET_TEMPLATE):
        assert "—" not in path.read_text(), path.name
        assert " -- " not in path.read_text(), path.name


def test_diff_rules_run_inside_the_inventory_and_block() -> None:
    inventory = INVENTORY.read_text()
    rules = DIFF_RULES.read_text()
    assert 'import { runDiffRules } from "./diff-rules.mjs";' in inventory
    assert "diffRulesClear: diffRules.blocking.length === 0" in inventory
    for rule in ("migration-precedent", "migration-backfill", "activity-capture", "tx-result-after-write",
                 "desktop-sync-lane", "artifact-link-delete", "ticketed-comment", "shared-path",
                 "story-outcome", "story-entry", "frozen-render"):
        assert f'"{rule}"' in rules, rule
    assert "`forbiddenPaths` and `diffRulesClear` gates to be true" in flat(agent("vibe-change-worker"))
    assert "`blocking.diffRulesClear` is false" in section(HANDOFF_SKILL.read_text(), "## 1. Internal checklist")
    assert "diff-rules.mjs" not in HANDOFF_SKILL.read_text()
    reviewer = section(agent("vibe-guardrails-reviewer"), "## Check, for added or changed lines only")
    assert "Open what each change log line that cleared an inventory `diffRules` finding cites" in reviewer
    assert "`diffRules.requiredTests` and `requiredChecks`" in flat(agent("vibe-verify-worker"))


def test_review_lessons_have_one_line_owners() -> None:
    adversary = section(agent("vibe-adversarial-reviewer"), "## Attack surface")
    for phrase in ("unnormalized id case", "a precondition fetched inside the `mutationFn`",
                   "the route's `requiredScopes`", "12. Write paths", "a disclosure or expand control that also selects its row",
                   "under 24px (2.5.8)"):
        assert phrase in adversary, phrase
    verify = flat(agent("vibe-verify-worker"))
    assert "never a commit that is not an ancestor" in verify
    assert "every surface it reaches with the flag off at 390, 412, 1024 and 1280 px wide" in verify
    assert "axe `color-contrast` on every new or changed story state; a failing node blocks" in verify
    assert "an in-row message a fixed-height row clips" in adversary
    assert "rerun the inventory's `requiredChecks` on the merged tree" in flat(HANDOFF_SKILL.read_text())
    assert "renaming its folder, SQL unchanged" in DIFF_RULES.read_text()
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert "never place an entry on a fallback a sibling retires" in decomposer
    assert "its flag-on state on that surface's existing story entry" in decomposer
