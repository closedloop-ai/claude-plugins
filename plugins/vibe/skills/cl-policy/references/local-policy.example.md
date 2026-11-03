# Local ClosedLoop Policy Example

Copy this file to either:

- `cl-policy/references/local-policy.md` when the policy should travel with the shared skill pack.
- `$HOME/.closedloop-ai/local-policy.md` when the policy should be machine-local and kept out of shared zips.

Do not use this example as live routing policy until the contact values are confirmed for the environment.

## Contacts

- Product contact: `<product-contact-display-name-or-handle>`.
- Engineering attention contact: the authenticated or invoking user for the current Codex task or ClosedLoop sweep.
- Engineering attention DM identity: the Slack display name, Slack user id, or other direct-message target that resolves to the authenticated or invoking user. Example: `Jane Example`.
- Sweep owner: the authenticated ClosedLoop user whose assigned tickets are being swept.

## ClosedLoop Comments

- Write every generated ClosedLoop comment in first person.
- Product blockers should use a first-person ClosedLoop ticket comment tagging the `Product contact`, with concise evidence and the specific product question.
- Treat ticket comments as company-visible product records, not an automation log.
- Never automatically post engineering blockers, complexity/risk classifications,
  execution overrides, credentials or local environment failures, account IDs,
  worker/session/lease/worktree state, callback/review mechanics, CI ownership,
  internal scheduling, malformed automation, memory failures, or manual-
  intervention details. Keep them private and surface them to the invoking user.
- Require an explicit user request for an engineering or operational comment on
  that exact ticket. A sweep or blocker-routing rule is not authorization.
- Keep Product comments limited to the product decision, user impact, and
  minimum decision evidence; exclude internal automation and access details.
- Never tag the engineering attention contact in ClosedLoop comments.
- Do not post ticket completion messages. Feature status, PR state, validation, merge state, and structured skill results are the completion record.

## Direct Messages

- Do not post Slack channel messages for ticket blockers or ticket completion.
- A first-person direct message is allowed only to the resolved engineering attention contact when their attention is required.
- If the engineering attention contact's DM identity is ambiguous, do not send the message. Record the unsent message and the identity ambiguity in the skill result or workflow repo memory.
