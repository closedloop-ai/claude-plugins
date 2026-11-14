// Fixtures shared by the criteria audit, the criteria reader and the surface decision tests (ISS-14136).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";

export const TICKET = `## Scope and acceptance criteria

- Scope: drag rows between groups
- Acceptance criteria:
  - [ ] A row can be dragged with the pointer
  - [x] A row too deep to move is refused silently

## Environment
- [ ] not a criterion
`;

// The six real criteria two pull requests were refused for (ISS-14136): each names Desktop and has no screen.
export const NO_SURFACE_FIXTURES = [
  { source: "ISS-14107 AC-3", text: "AC-3: The publish response carries the delivery count and a per-recipient outcome; an older Desktop build that ignores the new fields still works." },
  { source: "ISS-14107 AC-15", text: "AC-15: A new Desktop reading an older API reports the outcome as unknown, neither delivered nor failed. (review)" },
  { source: "ISS-14107 AC-16", text: "AC-16: A publish command with a misspelled recipient field is an error on Desktop; nothing is published. (review)" },
  { source: "ISS-14107 AC-38", text: "AC-38: Waking is on by default. It is turned off and on only by an agent, through a Mesh command operation, for every session of that user on that machine; the setting is stored locally. This ticket adds nothing to the Desktop UI. (rulings 5 and 6)" },
  { source: "ISS-14107 AC-39", text: "AC-39: A sender is told, for each named recipient, whether it will be woken if idle or will see the message at its next turn. A Codex session, a session on a Desktop older than this change, a session whose watcher is not running, and a session on a machine where waking is off are all reported as next turn. (ruling 6)" },
  { source: "ISS-14063 criterion 1", text: "When two `pnpm vibe desktop-up` runs signal the same `vibe up` at once, each reads only the acknowledgement for its own request." },
];
export const NEEDS_APP_RUN = "it needs the product running on a surface, so typecheck, unit-test or source evidence alone does not meet it; add a screenshot, e2e or control row";
export const NAMES_DESKTOP = "names Desktop, so it is user-visible and needs visual QA, but the review declares no pages or surfaces";
export const PROOF_TEST = "checks/contract.test.mjs";
const PROOF_SOURCE = [
  'import test from "node:test";',
  'test("an older build ignores the new fields", () => {});',
  '// test("named only in a comment", () => {});',
  'test.skip("a skipped one", () => {});',
  'it.todo("a todo one");',
  'xit("an x one", () => {});',
  'run(); // test("named after code in a comment", () => {});',
  "",
].join("\n");
export const markLine = (id, reason = "Desktop here is the client process, not a screen") => `No surface: ${id}: ${reason}\n`;
export const testRow = (id, name = "an older build ignores the new fields", file = PROOF_TEST) => `| ${id} | MET | test | ${file}::${name} |\n`;

/** A folder holding the one test file the marks name. */
export function proofFolder(t) {
  const { root: dir, cleanup } = makeHome("criteria-no-surface-");
  t.after(cleanup);
  mkdirSync(path.join(dir, "checks"));
  writeFileSync(path.join(dir, PROOF_TEST), PROOF_SOURCE);
  return dir;
}

export const UNREAD = (name) => `the ticket has checkboxes under "${name}" that read as acceptance criteria, outside the section this audit reads; move them under the "Acceptance criteria" heading or the "- Acceptance criteria:" list`;
