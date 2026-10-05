# Communication Policy

Use this reference whenever `$cl-sweep`, `$cl-analyze`, or `$cl-execute` would
route a blocker, write a ClosedLoop comment, recommend or send a Slack/DM, or
record communication state.

## Standing Permission

The `$cl-sweep <project>` invocation grants standing approval only for a concise
Product-decision comment when `$cl-analyze` proves a genuine unresolved Product
question after Product Answer Discovery and the parent validates that the
Product contact is available under current user/session context. It grants no
permission for engineering, operational, split, access, automation,
recordkeeping, status, or completion comments and no permission for Slack/DM
communication.

Allowed automatic communications are limited to:

- Product blockers: add a first-person ClosedLoop comment tagging the Product
  contact only when Product Answer Discovery searched linked PRDs, plans, comments, sibling tickets, semantic facts, prior blockers, related product/design artifacts, and workflow repo memory, found no existing
  authoritative answer, the Product contact is available, and a specific product
  behavior/decision is independently actionable. Include user impact and minimum
  decision evidence; exclude internal access, environment, worker, complexity,
  review, CI, and orchestration facts.
- Engineering blockers, legacy split evidence, duplicates/already-done tickets,
  high complexity, extreme risk, mixed blockers, malformed results, repo-memory
  failures, credentials/access, and manual intervention: keep all details in
  private workflow memory/artifacts and surface them to the user in this thread.
  Comment/DM only after an explicit user request for that exact communication.
- If the Product contact is unavailable or out-of-office according to current
  user/session context, first search for existing authoritative answers. If no
  answer exists, set ClosedLoop comment target to `none` by default and surface
  exact missing decisions privately to Daniel/current user or the engineering
  attention route unless the user explicitly authorizes that exact Product
  comment.
- Completion updates: do not post ticket completion messages in Slack or
  ClosedLoop. Feature status, PR state, validation, and merge state are the
  completion record.

Do not create an unsent-comment obligation for a forbidden engineering comment.
Use `COMMUNICATION_FAILED_MANUAL_FOLLOWUP` only when an authorized Product
comment or explicitly user-requested communication cannot be completed. Never
recreate a user-deleted comment.

## Blocker Routing

Use the communication target from each `$cl-analyze` or `$cl-execute` report:

- `PRODUCT_BLOCKED`: Add a first-person ClosedLoop comment on the ticket tagging
  the policy Product contact only after Product Answer Discovery proves no
  existing authoritative answer and the Product contact is available. Explain
  the issue with evidence and the specific product question. Do not use Slack.
- Legacy `PRODUCT_DECISION_REQUIRED`, `SPLIT_CREATED`,
  `DIRECT_EXECUTION_RECOMMENDED`, `CHILD_EXECUTION_ONLY`,
  `SPLIT_REPAIR_REQUIRED`, and `SPLIT_PROPOSED` records from older split flows:
  treat them as historical evidence only. Do not add a blocker comment or DM,
  do not call `$cl-split`, do not create or repair child tickets, and re-analyze
  any current assigned issue only as the single ticket it now is.
- `WAITING_UI_PLAN_APPROVAL`: Do not treat this as a blocker. Keep the child
  monitored and the plan linked in private workflow memory; surface the approval
  request in this thread without a ticket comment or DM. Continue only after
  explicit human approval for the same uploaded plan is present through the
  current thread or human plan-approval metadata. Do not treat status alone,
  self/bot approval, a deleted comment, or generic ticket approval as sufficient.
- `ENGINEERING_BLOCKED`, `ALREADY_DONE_OR_DUPLICATE`,
  `HUMAN_REVIEW_REQUIRED`, `SPLIT_BLOCKED`, top-level `HIGH` complexity without
  an accepted unsplit atomic-shape override, or `EXTREME` risk: keep the
  decision/evidence private, record the durable state, and surface it to the
  user. ClosedLoop comment target and engineering-attention DM are `none` unless
  explicitly user-authorized.
- Mixed or ambiguous blockers: keep engineering evidence private. Tag the
  Product contact only when an independently clear, actionable Product question
  remains after Product Answer Discovery and the Product contact is available;
  the Product comment must exclude all internal operational details.
- `GO`: Do not add a blocker comment or DM.

Authorized Product-decision comments are parent-owned during `$cl-sweep`.
Engineering/operational comments, recordkeeping comments, DMs, and completion
messages are disabled unless explicitly requested and must not be retried or
recreated.

## Product Comment Mechanics

Keep authorized Product comments concise, factual, first-person, and limited to
the Product decision/user impact. Before posting, verify the Product contact and
ticket, compute an idempotency key, and check recent comments so it is posted
once. Record `COMMUNICATION_PENDING`, then the posted result. If that Product
comment or an explicitly user-requested communication fails, record
`COMMUNICATION_FAILED_MANUAL_FOLLOWUP`.
