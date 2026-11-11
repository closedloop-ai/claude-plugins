// Whether a PR title or body names a ticket: the slug as a whole word, so
// `ABC-12` is not named by `ABC-123`. Shared by handoff-gate.mjs (a session's
// member tickets) and fleet-orchestrator's ticket-units.mjs pr-check.

/** The slugs `text` does not name. */
export function missingTicketNames(text, slugs) {
  return slugs.filter((slug) => !new RegExp(`(^|[^A-Za-z0-9-])${slug}(?![0-9])`).test(text ?? ""));
}
