import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TICKET_SECTIONS } from "../../handoff/scripts/live-ticket-check.mjs";
import {
  createTicketCtl, gradingSection, mergeChecklist, OWNERSHIP, protectAngles, recordSectionsFrom, renderChecklist, replaceSections,
} from "./ticket-ctl.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "ticket-ctl.mjs");
const TEMPLATE = readFileSync(path.join(HERE, "..", "references", "ticket-template.md"), "utf8");

const BODY = TICKET_SECTIONS.map((heading) => `## ${heading}\n\nbody of ${heading}\n`).join("\n");

test("every kind renders the exact line the template gives, with the entry's own fields", () => {
  const lines = renderChecklist({
    conflicts: [{ what: "owner", decided: "shared parent", evidence: "guardrails.md" }],
    forbiddenPaths: [{ area: ".github/workflows", why: "needs a job" }],
    decisions: [{ question: "keep the swap?", built: "kept", evidence: "diff" }],
    mainFailures: [{ check: "pnpm typecheck", mainSha: "a".repeat(40), evidence: "TS2304", mainExit: 2, sessionExit: 2 }],
    frozenSame: [{ storyId: "a--b", base: "abc", reason: "throws" }],
    frozenUnstable: [{ storyId: "c--d", base: "abc", diff: "12 px" }],
    machineLimited: [{ check: "vitest", mainSha: "b".repeat(40), minutes: 15 }],
    e2eLeftForCi: [{ lane: "pnpm test:e2e", coverage: "e2e-test.yml:e2e" }],
    criteriaWait: [{ ticket: "ISS-9", criterion: "AC-2" }],
    toolingBlockers: [{ what: "hook refused", evidence: "line 1" }],
    compileOnly: [{ file: "a.stories.tsx" }],
  });
  assert.deepEqual(lines, [
    "- [ ] Resolve conflict: owner; decided: shared parent; evidence: guardrails.md",
    "- [ ] Engineering needed (forbidden path): .github/workflows; why: needs a job",
    "- [ ] Engineering decision: keep the swap?; built: kept; evidence: diff",
    `- [ ] Known main failure: pnpm typecheck; fails on captured main ${"a".repeat(40)}; evidence: TS2304; exit 2 on captured main, 2 on the session commit`,
    "- [ ] Known main failure: frozen story a--b; fails the same way on base abc; evidence: throws",
    "- [ ] Known main failure: frozen story c--d; renders differently on two base renders at abc; diff: 12 px",
    `- [ ] Check ran out of time on this machine: vitest; also on captured main ${"b".repeat(40)}; limit 15 min; run it on a faster machine or CI`,
    "- [ ] E2E left for CI: pnpm test:e2e; covered by e2e-test.yml:e2e; confirm it is green on the merge commit",
    "- [ ] Criterion waits on ISS-9: AC-2; not met until it ships",
    "- [ ] Vibe tooling blocker: hook refused; evidence: line 1",
    "- [ ] Check compile-only repair to v1.0: a.stories.tsx; confirm only prop, import or type changes and no visual change",
  ]);
});

test("the same path or area logged again is the same item; a missing field throws naming it, never a guess", () => {
  assert.equal(renderChecklist({ forbiddenPaths: [{ area: "x", why: "a" }, { area: "x", why: "b" }, { area: "y", why: "c" }] }).length, 2);
  assert.throws(() => renderChecklist({ conflicts: [{ what: "a", decided: "b" }] }), /entries\.conflicts\[0\] has no evidence/);
  assert.throws(() => renderChecklist({ conflicts: "nope" }), /must be a list/);
  assert.deepEqual(renderChecklist({}), []);
});

test("angle-bracketed text goes in a code span, and text already in one is left alone", () => {
  assert.equal(protectAngles("use <TagMenu> here"), "use `<TagMenu>` here");
  assert.equal(protectAngles("already `<TagMenu>` ok"), "already `<TagMenu>` ok");
  const [line] = renderChecklist({ conflicts: [{ what: "<Foo> vs <Bar>", decided: "d", evidence: "e" }] });
  assert.match(line, /`<Foo>` vs `<Bar>`/);
});

test("merging the checklist appends only lines the section lacks, and a second merge changes nothing", () => {
  const lines = renderChecklist({ conflicts: [{ what: "owner", decided: "d", evidence: "e" }] });
  const once = mergeChecklist(BODY, lines);
  assert.ok(once.includes(lines[0]));
  assert.equal(mergeChecklist(once, lines), once);
  assert.ok(once.includes("body of Engineering checklist"));
  assert.throws(() => mergeChecklist("## What this is\nx\n", lines), /no Engineering checklist/);
});

test("the Grading section is the template's, unchanged", () => {
  const grading = gradingSection(TEMPLATE);
  assert.match(grading, /^## Grading\n/);
  assert.match(grading, /High = took it as is or with small tweaks\./);
  assert.match(grading, /7\. What we had to fix before merge\./);
  assert.ok(!grading.includes("## Engineering checklist"));
  assert.throws(() => gradingSection("no block"), /no body block/);
});

test("replacing sections changes only the named ones and keeps every other byte, including a fenced heading", () => {
  const body = `Intro line\n\n## What this is\n\nold\n\n## Environment\n\nenv\n\n\`\`\`\n## Environment\n\`\`\`\n\n## Progress\n\n- one\n`;
  const next = replaceSections(body, { "What this is": "new text" }, "create");
  assert.equal(next, body.replace("old", "new text").replace("\n\nnew text\n\n## Environment", "\n\nnew text\n\n## Environment"));
  assert.ok(next.startsWith("Intro line\n\n## What this is"));
  assert.ok(next.includes("```\n## Environment\n```"));
  assert.ok(next.endsWith("- one\n"));
});

test("a section the owner does not own, one not in the template, or one the body lacks throws and nothing is appended", () => {
  assert.throws(() => replaceSections(BODY, { Handoff: "x" }, "record"), /not written by record/);
  assert.throws(() => replaceSections(BODY, { Invented: "x" }, "handoff"), /not a section of the live ticket/);
  assert.throws(() => replaceSections("## What this is\nx\n", { Environment: "x" }, "record"), /no Environment section/);
  assert.throws(() => replaceSections(BODY, { Environment: "x" }, "nobody"), /Unknown owner/);
});

test("the ownership table matches the template's Written by table for the record and handoff steps", () => {
  assert.deepEqual(OWNERSHIP.record, ["Environment", "Production flag snapshot", "Sessions"]);
  for (const heading of Object.values(OWNERSHIP).flat()) assert.ok(TICKET_SECTIONS.includes(heading), heading);
  for (const heading of OWNERSHIP.record) assert.match(TEMPLATE, new RegExp(`\\| ${heading} \\| \`ticket-sections\``));
  for (const heading of ["Handoff", "Design Review", "Grading"]) assert.match(TEMPLATE, new RegExp(`\\| ${heading} \\| \`vibe-ticket-worker\``));
});

test("apply-record pastes the three ticket-sections over their headings and touches nothing else", () => {
  const markdown = "## Environment\n\nenv now\n\n## Production flag snapshot\n\nflags now\n\n## Sessions\n\nsessions now\n";
  assert.deepEqual(Object.keys(recordSectionsFrom(markdown)), ["Environment", "Production flag snapshot", "Sessions"]);
  assert.throws(() => recordSectionsFrom("## Environment\nx\n"), /printed no Production flag snapshot/);
  const ctl = createTicketCtl({ run: () => ({ status: 0, stdout: JSON.stringify({ ok: true, markdown }), stderr: "" }) });
  const next = ctl.applyRecord({ worktree: "/wt", body: BODY });
  assert.ok(next.includes("env now") && next.includes("flags now") && next.includes("sessions now"));
  assert.ok(!next.includes("body of Environment"));
  assert.ok(next.includes("body of Handoff") && next.includes("body of Progress"));
  const refused = createTicketCtl({ run: () => ({ status: 1, stdout: JSON.stringify({ ok: false, error: "no record" }), stderr: "" }) });
  assert.throws(() => refused.applyRecord({ worktree: "/wt", body: BODY }), /no record/);
});

test("with no transport an update refuses, and with an injected one it reads the latest body and writes the whole body back once", async () => {
  await assert.rejects(createTicketCtl().update({ slug: "ISS-1", change: (body) => body }), /No transport is configured/);
  const written = [];
  const transport = { getDocument: async () => ({ body: BODY }), writeVersion: async (slug, body) => { written.push([slug, body]); } };
  const ctl = createTicketCtl({ transport });
  assert.deepEqual(await ctl.update({ slug: "ISS-1", change: (body) => body }), { slug: "ISS-1", written: false });
  assert.deepEqual(await ctl.update({ slug: "ISS-1", change: (body) => replaceSections(body, { Progress: "- today" }, "writer") }), { slug: "ISS-1", written: true });
  assert.equal(written.length, 1);
  assert.ok(written[0][1].includes("- today"));
});

test("the script holds no credential source: no environment read, no network call, no auth header", () => {
  const code = readFileSync(SCRIPT, "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const forbidden of ["process.env", "fetch(", "Authorization", "Bearer", "apiKey", "api_key", "createClient", "https.request", "http.request"]) {
    assert.ok(!code.includes(forbidden), `${forbidden} appears in ticket-ctl.mjs`);
  }
});

test("the command line renders the checklist and the grading section, and has no subcommand that reads or writes a ticket", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ticket-ctl-"));
  try {
    const entries = path.join(dir, "entries.json");
    writeFileSync(entries, JSON.stringify({ compileOnly: [{ file: "a.stories.tsx" }] }));
    const checklist = spawnSync(process.execPath, [SCRIPT, "checklist", "--entries-file", entries], { encoding: "utf8" });
    assert.equal(checklist.status, 0, checklist.stderr);
    assert.match(checklist.stdout, /Check compile-only repair to v1.0: a\.stories\.tsx/);
    const grading = spawnSync(process.execPath, [SCRIPT, "grading"], { encoding: "utf8" });
    assert.match(grading.stdout, /^## Grading/);
    const create = spawnSync(process.execPath, [SCRIPT, "create"], { encoding: "utf8" });
    assert.equal(create.status, 2);
    assert.match(create.stderr, /no subcommand reads or writes a ticket/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
