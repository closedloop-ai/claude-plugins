# Shared ClosedLoop Policy

## Contacts

- Product contact: unresolved by default. Resolve from the ticket, project,
  current user instructions, or `$HOME/.closedloop-ai/local-policy.md` before
  recommending or posting a Product-blocker comment.
- Engineering attention contact: the authenticated or invoking user for the current Codex task or ClosedLoop sweep. Do not hardcode a personal name in the skills. Resolve the identity from the active Codex user context, ClosedLoop authenticated user, Slack identity, or an explicit user-provided override when a direct message is required.
- Sweep owner: the authenticated ClosedLoop user whose assigned tickets are being swept.

## ClosedLoop Comments

- Write every generated ClosedLoop comment in first person.
- Product blockers should use a first-person ClosedLoop ticket comment tagging the `Product contact`, with concise evidence and the specific product question.
- Treat ticket comments as company-visible product records, not an automation log.
- Never automatically post engineering blockers, complexity/risk classifications,
  execution-override requests, local credential or environment failures, account
  identifiers, worker/session/generation/lease/worktree state, callback/review
  mechanics, CI ownership diagnosis, internal scheduling, malformed automation
  results, repo-memory failures, or manual-intervention details. Keep those in
  private sweep artifacts/workflow memory and surface them to the invoking user
  in the Codex thread.
- An engineering or operational ticket comment requires an explicit user request
  for that exact comment and ticket. Assignment, sweep invocation, blocker
  routing, or a worker recommendation is not authorization.
- Product-blocker comments must contain only the product behavior/decision,
  user impact, and minimum evidence needed to answer it. Exclude internal
  automation, access, credential, environment, and orchestration details.
- Never tag the engineering attention contact in ClosedLoop comments.
- Do not post ticket completion messages. Feature status, PR state, validation, merge state, and structured skill results are the completion record.

## Direct Messages

- Do not post Slack channel messages for ticket blockers or ticket completion.
- Do not send a Slack message, direct message, draft, channel post, or thread
  reply unless the user explicitly authorizes that specific Slack
  communication. A sweep invocation, blocker-routing rule, engineering-
  attention recommendation, or earlier general authorization is not sufficient.
- When a workflow would otherwise recommend a first-person engineering-
  attention DM, keep the recommendation in the ClosedLoop/workflow record with
  `engineering_attention_dm: not_sent_by_user_policy`; do not attempt Slack and
  do not classify this intentional suppression as a communication failure.
- If the engineering attention contact's DM identity is ambiguous, do not send the message. Record the unsent message and the identity ambiguity in the skill result or workflow repo memory.

## Optional User-Local Override

If `$HOME/.closedloop-ai/local-policy.md` exists, read it after this bundled policy. It may define deployment-local identity details such as the Product contact, engineering attention contact display name, or direct-message identity. It should not be required for the shared skill pack to function, and it should not silently replace core routing rules unless the user explicitly asks for that change.

## Legacy Memory Aliases

When reading older workflow repo-memory records, treat `daniel_dm`, `daniel_dm_key`, `daniel_dm_permalink_or_timestamp`, and `Daniel-attention` labels as legacy schema aliases for the engineering attention contact fields. Do not use legacy values to resolve the current DM recipient or to decide a DM has already been handled for the current engineering attention contact. Always resolve the current DM identity from this policy and any optional user-local override before sending or suppressing a direct message. When writing new records, use `engineering_attention_dm`, `engineering_attention_dm_key`, `engineering_attention_dm_permalink_or_timestamp`, and `engineering-attention` labels.
