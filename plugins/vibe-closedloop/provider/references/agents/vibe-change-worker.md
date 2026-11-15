# Provider text for agents/vibe-change-worker.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: prepush-evidence -->
HEAD-only output from `pnpm prepush --all` is not dirty-source evidence; use the
owned E2E lock's HEAD plus diff/tree receipt. No commit is needed for that local
harness. The external remote wrapper is the verifier's documented clean-commit
exception and accepts only `--head`, owner and command.
<!-- end: prepush-evidence -->

<!-- block: read-list -->
Read `../skills/vibe/references/quality-loop.md`, `closedloop-graph.md`,
`design-pass.md`, `guardrails.md`, `annotations.md` when relevant, and
`ticket-template.md`, resolved from this agent's owning plugin as briefed.
<!-- end: read-list -->

<!-- block: prep-step -->
Run the prep step in `design-pass.md`: FEATURE_MAP for each screen/host,
required graph `code_symbols`, `code_callers`, `code_importers` and
`blast_radius_tickets`, the component catalog and owning package rules, and
one workflow-memory query when available. Apply its owner rules: behavior
<!-- end: prep-step -->

<!-- block: flag-retire -->
comments on every ticket linked to it (the live ticket, its PRD, and the
tickets `fts_search` finds for the key) with the ClosedLoop MCP
`get-document-comments`. A recorded hold, rollout pause or parity list with
no later human answer allowing the retirement means the flag stays:
<!-- end: flag-retire -->

<!-- block: local-plan -->
write the exact-template local plan under `.closedloop-ai/vibe-plans/`.
Never commit it, deploy it or paste it into the ticket: the ticket worker
publishes it as the session's PLN (`quality-loop.md`, "Local plan"), so write
it for an engineer who never saw the session, with repo-relative paths and no
local absolute paths, usernames, personal emails, secrets, credentials or
private session inputs. A plan problem the ticket worker returns is yours to
fix in the local plan. A `self-bookkeeping` repair to vibe's private plan or
records has no scope, code, test or HEAD change: make it without permission,
never return `NEEDS_PERSON`, and report the completed repair in one line. Name scope,
<!-- end: local-plan -->

<!-- block: precedent -->
Research any product uncertainty through graph and live prior decisions first.
Apply a settled ruling, never ask it again; settled means traced to a human
statement (`quality-loop.md`, "Communication and product questions"). Only an
absolutely necessary unresolved product question returns `NEEDS_PERSON`, with
sources checked and full context; before asking, the orchestrator checks how
Asana or another established app handles it (`quality-loop.md`, "Precedent
before asking"). A precedent answer it returns is the default you build to:
record it in the session decision table as the decision for the affected
rows with its source (`Asana, observed <date>`, `<app>, observed <date>` or
the help-center URL), never as a human ruling, and never take its words as
copy. Resolve technical ownership/backend/adapter
questions yourself from source and read-only advice, never by shrinking
requested scope.
<!-- end: precedent -->

<!-- block: taxonomy -->
Read the repo's `apps/storybook/TAXONOMY.md` and follow it:
<!-- end: taxonomy -->

<!-- block: version-history -->
- A session adds exactly one Version History entry, at the next version after
  `apps/storybook/package.json` on the main it last synced, and moves it after
  each main sync; never an entry for another version, a reworded main entry
  or a validator, test or key special-cased so two entries coexist
  (`guardrails-ui.md`, "Storybook taxonomy").
<!-- end: version-history -->

<!-- block: copy-docs -->
invent product text, and never edit `apps/web/content/docs/` nor the internal `docs/` folder:
nothing agent-written goes into public docs (`guardrails.md`, "Copy" and
"Feature docs at handoff"). Read-only
<!-- end: copy-docs -->

<!-- block: lane-discovery -->
- Use existing structured lane-owner discovery, not blind
  `test:lanes --exec`.
<!-- end: lane-discovery -->

<!-- block: desktop-lane -->
  not safe preview publication with its explicit preparation evidence. The
  Desktop Electron lane never runs on a vibe machine: the executor returns it
  under `e2eLeftForCi`, covered by the post-merge `desktop-e2e/validated`
  run, and it does not hold `requiredE2eComplete`.
<!-- end: desktop-lane -->

<!-- block: criteria -->
before ready": the criteria from the ticket, its PRD and the person's own
words, each checked with an existing test run alone, a throwaway script, one
bounded control read or an end-to-end source trace, and each result recorded.
Fix a criterion that is not met; one you cannot finish now is reported
`not met yet` with the reason, never claimed. At handoff, start the
<!-- end: criteria -->

<!-- block: criteria-2 -->
yet` until the deployed external dependency evidence exists. A planned ticket,
missing task or source-only assertion is not that evidence, and the related
PLN task cannot be marked complete.
<!-- end: criteria-2 -->

<!-- block: test-lane -->
  package's test config, the e2e or Desktop lane the repo's `AGENTS.md` files
  name for it, confirmed with `pnpm test:lanes`. A test that no lane CI runs
  for its path does not count.
<!-- end: test-lane -->

<!-- block: feature-docs -->
The same handoff continuation records, never edits, the existing product docs
pages under `apps/web/content/docs/` that describe a changed feature, per
`guardrails.md`, "Feature docs at handoff": each page and the passage that no
longer matches what was built, or that none covers the changed features, in
the change log for the ticket's Feature docs line. Nothing agent-written goes
into public docs or the internal engineering `docs/` folder; an edit found
there is removed and recorded instead. Once the table is
<!-- end: feature-docs -->
