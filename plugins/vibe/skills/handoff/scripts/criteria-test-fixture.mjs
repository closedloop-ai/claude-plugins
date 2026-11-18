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

/** A pytest module with one collected test and one helper, and two files that hold test-like code but are not test files. */
export const PYTHON_TEST = "checks/test_contract.py";
export const NOT_TEST_FILES = { python: "checks/runner.py", node: "checks/contract.mjs" };

/** A folder holding the test files the marks name, and files that look like tests but are not test files. */
export function proofFolder(t) {
  const { root: dir, cleanup } = makeHome("criteria-no-surface-");
  t.after(cleanup);
  mkdirSync(path.join(dir, "checks"));
  writeFileSync(path.join(dir, PROOF_TEST), PROOF_SOURCE);
  writeFileSync(path.join(dir, PYTHON_TEST), "def helper_contract():\n    return 1\n\n\ndef test_contract_holds():\n    assert helper_contract() == 1\n");
  writeFileSync(path.join(dir, NOT_TEST_FILES.python), "def test_contract_holds():\n    return 1\n");
  writeFileSync(path.join(dir, NOT_TEST_FILES.node), 'test("an older build ignores the new fields", () => {});\n');
  return dir;
}

export const UNREAD = (name) => `the ticket has checkboxes under "${name}" that read as acceptance criteria in a form or place this audit does not read; write each as a "- [ ]" box directly in the "Acceptance criteria" section or the "- Acceptance criteria:" list`;

// The reader rows: every reviewer trigger from rounds 3 to 6 and every ticket in criteria-list.test.mjs. `read` is the
// list main 0057c43a's reader gives (literal, taken from main), `outside` the unread boxes outside every criteria
// section (not reported, by design), and `overReport` the boxes reported under a sibling section indented deeper
// than the template list line: an accepted over-report (orchestrator decision, 2026-11-18: ISS-14136 AC-4 outranks
// the ADV-R5-2 half of orchestrator answer Q-R5).
export const READER_ROWS = [
  {
    "name": "F1 list-level box",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n- [ ] two unindented\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "F1 ordered outside",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n\n## Other\n\n1. [ ] numbered criteria\n* [ ] AC-2 stray\n\n## Criteria met\n\n1. [x] ordered\n",
    "read": [
      "one"
    ],
    "outside": [
      "numbered criteria"
    ],
    "overReport": []
  },
  {
    "name": "A1 mixed four",
    "ticket": "## Acceptance criteria\n\n- [ ] first\n1. [ ] numbered\n+ [ ] plus\n- [ ] last\n",
    "read": [
      "first",
      "last"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "R3-1 sub-heading",
    "ticket": "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n+ [ ] plus\n1. [ ] num\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "R3-1 heading label",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n- Notes:\n  + [ ] plus\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R4-1 nested heading",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n+ [ ] p1\n\n### Desktop\n\n- [ ] c\n+ [ ] p2\n1) [ ] n\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR4-1 A label at 4",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      + [ ] plus\n  - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR4-1 B label at 2",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n  - Notes:\n    + [ ] plus\n  - [ ] b\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R5-1 indented list",
    "ticket": "  - Acceptance criteria:\n  - [ ] a\n    - Notes:\n      + [ ] plus\n  - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R5-2 sibling at 1",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n - Environment:\n   - [ ] run the app\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": [
      "run the app"
    ]
  },
  {
    "name": "ADV-R6-1 deep first, label 3",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - [ ] b\n   - Notes:\n     + [ ] plus\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R6-1 shallow first, label 3",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n    - [ ] b\n   - Notes:\n     + [ ] plus\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R6-1 deep first, label 2",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - [ ] b\n  - Notes:\n  - [ ] x\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R6-1 shallow first, label 2",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n    - [ ] b\n  - Notes:\n  - [ ] x\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR6-1 label 2, box 4",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - Notes:\n    - [ ] x\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR6-1 label 2, + box",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - Notes:\n    + [ ] x\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR6-1 boxes at 3",
    "ticket": "- Acceptance criteria:\n   - [ ] a\n  - Notes:\n   - [ ] x\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "GR6-2 shallower label at 4",
    "ticket": "      - Acceptance criteria:\n        - [ ] a\n    - Environment:\n      + [ ] check the logs\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": [
      "check the logs"
    ]
  },
  {
    "name": "GR6-3 sibling at start indent",
    "ticket": "  - Acceptance criteria:\n  - [ ] a\n  - Environment:\n    + [ ] run the app\n",
    "read": [
      "a"
    ],
    "outside": [
      "run the app"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 1",
    "ticket": "## Scope and acceptance criteria\n\n- Scope: drag rows between groups\n- Acceptance criteria:\n  - [ ] A row can be dragged with the pointer\n  - [x] A row too deep to move is refused silently\n\n## Environment\n- [ ] not a criterion\n\n## Engineering checklist\n\n- [ ] Write the tests listed under Missing tests\n- [ ] Criterion waits on ISS-9: the count; not met until it ships\n",
    "read": [
      "A row can be dragged with the pointer",
      "A row too deep to move is refused silently"
    ],
    "outside": [
      "not a criterion",
      "Write the tests listed under Missing tests",
      "Criterion waits on ISS-9: the count; not met until it ships"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 2",
    "ticket": "## Scope and acceptance criteria\n\n- Scope: drag rows between groups\n- Acceptance criteria:\n  - [ ] A row can be dragged with the pointer\n  - [x] A row too deep to move is refused silently\n\n## Environment\n- [ ] not a criterion\n\n## Added criteria\n\n- [ ] A third thing happens\n- [ ] And a fourth\n",
    "read": [
      "A row can be dragged with the pointer",
      "A row too deep to move is refused silently"
    ],
    "outside": [
      "not a criterion"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 3",
    "ticket": "## Scope and acceptance criteria\n\n- Scope: drag rows between groups\n- Acceptance criteria:\n  - [ ] A row can be dragged with the pointer\n  - [x] A row too deep to move is refused silently\n\n## Environment\n- [ ] not a criterion\n\n## Notes from the review\n\n- [ ] AC-12: a late criterion\n",
    "read": [
      "A row can be dragged with the pointer",
      "A row too deep to move is refused silently"
    ],
    "outside": [
      "not a criterion"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 4",
    "ticket": "## Scope and acceptance criteria\n\n- Scope: drag rows between groups\n- Acceptance criteria:\n  - [ ] A row can be dragged with the pointer\n  - [x] A row too deep to move is refused silently\n\n## Environment\n- [ ] not a criterion\n\n## Follow-up\n\n- More criteria:\n  - [ ] A fifth thing happens\n",
    "read": [
      "A row can be dragged with the pointer",
      "A row too deep to move is refused silently"
    ],
    "outside": [
      "not a criterion"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 5",
    "ticket": "## Scope and acceptance criteria\n\n- Scope: drag rows between groups\n- Acceptance criteria:\n  - [ ] A row can be dragged with the pointer\n  - [x] A row too deep to move is refused silently\n\n## Environment\n- [ ] not a criterion\n\n## Added criteria\n\n- [ ] A third thing happens\n",
    "read": [
      "A row can be dragged with the pointer",
      "A row too deep to move is refused silently"
    ],
    "outside": [
      "not a criterion"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 6",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 7",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n- [ ] two at list level\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 8",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n  1. [ ] two numbered\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 9",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n\n## Other\n\n1. [ ] AC-2: numbered\n+ [ ] AC-3: plus\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 10",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n\n## Criteria met\n\n1. [x] ordered\n",
    "read": [
      "one"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 11",
    "ticket": "- Acceptance criteria:\n  - [ ] one\n\nPlain text after the list.\n- [ ] an unrelated todo\n",
    "read": [
      "one"
    ],
    "outside": [
      "an unrelated todo"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 12",
    "ticket": "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n+ [ ] plus\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 13",
    "ticket": "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n1. [ ] num\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 14",
    "ticket": "### Acceptance criteria\n\n- [ ] a\n\n#### Web\n\n1) [ ] num\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 15",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n- Notes:\n  1. [ ] num\n- [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 16",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n- [ ] c\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 17",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n+ [ ] p2\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 18",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n\n### Acceptance criteria for web\n\n- [ ] b\n\n### Desktop\n\n1) [ ] n\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 19",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1. [ ] num\n  - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 20",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1) [ ] num\n  - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 21",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n  - Notes:\n  - [ ] b\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 22",
    "ticket": "- Acceptance criteria:\n      - [ ] a\n    - Notes:\n      + [ ] plus\n      - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 23",
    "ticket": "  - Acceptance criteria:\n  - [ ] a\n    - Notes:\n      1. [ ] num\n  - [ ] b\n",
    "read": [
      "a",
      "b"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "test-file case 24",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n- Environment:\n  - [ ] run the app\n  1. [ ] check the logs\n",
    "read": [
      "a"
    ],
    "outside": [
      "run the app",
      "check the logs"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 25",
    "ticket": "## Acceptance criteria\n\n- [ ] a\n\n## Environment\n\n+ [ ] run the app\n1. [ ] check the logs\n",
    "read": [
      "a"
    ],
    "outside": [
      "run the app",
      "check the logs"
    ],
    "overReport": []
  },
  {
    "name": "test-file case 26",
    "ticket": "- Acceptance criteria:\n  - [ ] a\n - Environment:\n   - [ ] run the app\n   + [ ] check the logs\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": [
      "run the app",
      "check the logs"
    ]
  },
  {
    "name": "ADV-R7-1 deeper heading after the template list",
    "ticket": "## Scope and acceptance criteria\n\n- Acceptance criteria:\n  - [ ] a\n\n### Web\n\n- [ ] b\n+ [ ] c\n",
    "read": [
      "a"
    ],
    "outside": [],
    "overReport": []
  },
  {
    "name": "ADV-R7-2 checkbox left of an indented list line",
    "ticket": "  - Acceptance criteria:\n    - [ ] a\n   note\n- [ ] b\n",
    "read": [
      "a"
    ],
    "outside": [
      "b"
    ],
    "overReport": []
  }
];

// What c3a48f20 did with these tickets (literal, taken from that commit): boxes it neither read nor reported.
export const C3A48F20_DROPS = [
  {
    "name": "ADV-R6-1 deep first, label 3",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - [ ] b\n   - Notes:\n     + [ ] plus\n",
    "states": [
      {
        "text": "a",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "b",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "plus",
        "read": false,
        "reportedUnder": null
      }
    ],
    "dropped": [
      "plus"
    ]
  },
  {
    "name": "ADV-R6-1 deep first, label 2",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - [ ] b\n  - Notes:\n  - [ ] x\n",
    "states": [
      {
        "text": "a",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "b",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "x",
        "read": false,
        "reportedUnder": null
      }
    ],
    "dropped": [
      "x"
    ]
  },
  {
    "name": "GR6-1 label 2, box 4",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - Notes:\n    - [ ] x\n",
    "states": [
      {
        "text": "a",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "x",
        "read": false,
        "reportedUnder": null
      }
    ],
    "dropped": [
      "x"
    ]
  },
  {
    "name": "GR6-1 label 2, + box",
    "ticket": "- Acceptance criteria:\n    - [ ] a\n  - Notes:\n    + [ ] x\n",
    "states": [
      {
        "text": "a",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "x",
        "read": false,
        "reportedUnder": null
      }
    ],
    "dropped": [
      "x"
    ]
  },
  {
    "name": "GR6-1 boxes at 3",
    "ticket": "- Acceptance criteria:\n   - [ ] a\n  - Notes:\n   - [ ] x\n",
    "states": [
      {
        "text": "a",
        "read": true,
        "reportedUnder": null
      },
      {
        "text": "x",
        "read": false,
        "reportedUnder": null
      }
    ],
    "dropped": [
      "x"
    ]
  }
];
const ANY = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(\S.*)$/;
const START = /^\s*-\s*Acceptance criteria:\s*$|^#{1,6}\s+Acceptance criteria\b/i;
const HEADING = /^#{1,6}\s/;
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The boxes a reader neither read nor reported that it should have. A box is inside a criteria section when the
 * reader would read it with its marker swapped to "- " (it is within the read span), or, when it is not left of the
 * template list's start line, when the reader would read it after the label and text lines between the nearest
 * criteria start and the box that sit deeper than that start are removed too (a line at or left of the start, or a
 * heading, is a real boundary and stays; so is a checkbox left of the start). `states` is one entry per checkbox-shaped line ({ text, read, reportedUnder });
 * `read` is the reader (criteriaStates).
 */
export function oracleMisses(ticket, states, read) {
  const lines = ticket.split("\n");
  const boxLines = lines.flatMap((line, index) => (ANY.test(line) ? [index] : []));
  const misses = [];
  states.forEach((box, k) => {
    if (box.read || box.reportedUnder !== null) return;
    const at = boxLines[k];
    let start = -1;
    for (let i = at; i >= 0; i -= 1) if (START.test(lines[i])) { start = i; break; }
    if (start < 0) return;
    const depth = HEADING.test(lines[start]) ? -1 : indentOf(lines[start]);
    // The probed box gets "- " as its marker and a text no other box has, so the check names exactly this box.
    const swapped = lines.map((line, i) => (i === at ? line.replace(/^(\s*)(?:[-*+]|\d+[.)])\s*\[([ xX])\].*$/, "$1- [$2] oracle-probe-box") : line));
    const readsProbe = (candidate) => read(candidate.join("\n")).some((c) => c.text === "oracle-probe-box");
    if (readsProbe(swapped)) { misses.push(box.text); return; }
    // Otherwise a box left of the template list's start line is outside the list (orchestrator decision, 2026-11-18).
    if (depth >= 0 && indentOf(lines[at]) < depth) return;
    // A checkbox left of the start line between them is a boundary too, so the probe turns it into plain text there.
    const probe = swapped
      .map((line, i) => (i > start && i < at && depth >= 0 && ANY.test(line) && indentOf(line) < depth ? `${" ".repeat(indentOf(line))}boundary` : line))
      .filter((line, i) => !(i > start && i < at && line.trim() !== "" && !ANY.test(line) && !HEADING.test(line) && indentOf(line) > depth));
    if (readsProbe(probe)) misses.push(box.text);
  });
  return misses;
}

/** A seeded corpus of small tickets mixing every form the reader tells apart, at random indents. */
export function fuzzTickets(seed, count) {
  let state = seed >>> 0;
  const rand = (n) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 16) % n; };
  const pick = (list) => list[rand(list.length)];
  const markers = ["-", "*", "+", "1.", "1)"];
  const kinds = [
    () => `${"#".repeat(1 + rand(4))} Acceptance criteria${pick(["", " for web"])}`,
    () => `${"#".repeat(1 + rand(4))} ${pick(["Web", "Desktop", "Environment", "Notes"])}`,
    () => `${" ".repeat(rand(7))}- Acceptance criteria:`,
    () => `${" ".repeat(rand(9))}- ${pick(["Notes", "Environment", "More criteria"])}:`,
    () => `${" ".repeat(rand(9))}${pick(markers)} [${pick([" ", "x"])}] ${pick(["a", "b", "c", "AC-3: d"])}`,
    () => `${" ".repeat(rand(7))}${pick(["Plain text.", "a note", "1. a step"])}`,
    () => "",
  ];
  return Array.from({ length: count }, () => {
    const lines = [];
    for (let n = 2 + rand(10); n > 0; n -= 1) lines.push(pick(kinds)());
    return `${lines.join("\n")}\n`;
  });
}
