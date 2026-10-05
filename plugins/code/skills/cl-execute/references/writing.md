# Writing

Adapted from pstack's technical-writing and unslop skills (MIT, copyright 2026
Lauren Tan).

Use this when drafting a PR body, plan prose, the feature manual-QA comment, a
Product-decision comment, a PR thread reply, a pause or resume note, or the
free-text fields of a result. Readers read it cold, and most of it is
company-visible.

## Shape

- A PR body is a briefing a reviewer reads in under a minute. Open with what
  changed for the user or caller and why, then how it was proven. Link
  evidence (artifact paths, run URLs, the plan); do not paste logs, SHA lists,
  review recitals, or metric tables.
- A plan is forward-looking: requirements, approach, risks, and validation. It
  never narrates earlier drafts or reviews.
- Every count and claim is true at the head it describes.
- Free-text result fields also follow the evidence rule at the top of
  [result-formats.md](result-formats.md): evidence in the same sentence, and
  unobserved claims labeled `inferred` or `unverified`.

## Names

- Name the real symbol, file, flag, command, route, or FEATURE_MAP id, not a
  description of it. Call each thing by one name everywhere.

## Sentences

- Name the actor ("the resolver rejects the token"), put the condition before
  the instruction, and write whole sentences with their articles and verbs.
  No arrows, symbol-speak, or dropped words.
- Say what it does, not how it feels: "a renamed column fails the build", not
  "safer schema handling". Replace an adverb with the number.
- One idea per sentence. Split a sentence the reader has to parse twice.
- Prefer the plain word: use, help, many, if. Avoid AI vocabulary and metaphor
  nouns such as additionally, crucial, delve, enhance, leverage, pivotal,
  robust, seamless, underscore, landscape, ratchet, north star, and
  "serves as" for "is".
- Cut filler ("in order to", "it is important to note"), stacked hedges,
  "not just X but Y", forced groups of three, and chatbot phrases.

## Punctuation and format

- Never write em dashes or en dashes, and never use two hyphens as a dash.
  Use a period, a comma, a semicolon, or parentheses. (`--flag` inside a
  command is fine.)
- Colons introduce a list or an example, not a mid-sentence turn.
- No bold-label lists that restate the line, no decorative bold or emoji, and
  sentence-case headings. Straight quotes only.
- When the repository or `$workflow-code-review` provides a SOUL.md voice card,
  apply it to first-person text.

Reread the text once against this list before posting or returning it.
