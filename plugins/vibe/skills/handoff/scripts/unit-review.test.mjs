import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gapLines, namesIn, Origin, prdCriteria, requiredCells, reviewGaps, unitCriteria, unitReviewProblem } from "./unit-review.mjs";
import { budgetMs } from "./list-query-performance.mjs";
import { unitStatusProblem } from "../../../hooks/unit-status-guard.mjs";

const SCRIPT = fileURLToPath(new URL("./unit-review.mjs", import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const PRD = `# Grouped sections

## Acceptance criteria

- [ ] Group by Status bands on Sessions, Branches and Documents lists on Web and Desktop.
- [ ] Documents keep their manual order inside a group.

## Business rules

**BR-8-01.** Group by status, owner and priority where available.
- ISS-42 is the decision ticket for pushdown.
`;

const review = (rows, extra = {}) => ({ pages: ["Sessions", "Branches"], otherPages: ["Documents"], surfaces: ["Web", "Desktop"], listQueries: [], rows, ...extra });
const code = (criterion) => ({ criterion, part: "code", verdict: "MET", ref: "src/a.ts:1" });
const visual = (criterion, page, surface, capture = `${page}-${surface}.png`) => ({ criterion, part: "visual", verdict: "MET", page, surface, capture });
const everyCell = (criterion, pages = ["Sessions", "Branches"]) => pages.flatMap((page) => ["Web", "Desktop"].map((surface) => visual(criterion, page, surface)));
const passing = { codeRef: () => null, capture: (file) => ({ problem: null, sha256: file }) };

test("a PRD's criteria are its acceptance checklist and the lines that lead with their own id, never a ticket reference", () => {
  assert.deepEqual(prdCriteria("PRD-7", PRD).map(({ id }) => id), ["PRD-7:AC-1", "PRD-7:AC-2", "PRD-7:BR-8-01"]);
  assert.equal(prdCriteria("PRD-7", PRD)[2].text, "Group by status, owner and priority where available.");
});

test("page names match as words in either number", () => {
  assert.deepEqual(namesIn("each session row and the Branches list", ["Sessions", "Branches", "Documents"]), ["Sessions", "Branches"]);
  assert.deepEqual(namesIn("documentation", ["Documents"]), []);
});

test("a criterion needs every page and surface it names; a PRD criterion only the touched ones", () => {
  const text = "Group by Status bands on Sessions, Branches and Documents lists on Web and Desktop.";
  assert.deepEqual(requiredCells({ text, origin: Origin.Prd }, review([])), { pages: ["Sessions", "Branches"], surfaces: ["Web", "Desktop"] });
  assert.deepEqual(requiredCells({ text, origin: Origin.Ticket }, review([])).pages, ["Sessions", "Branches", "Documents"]);
  assert.deepEqual(requiredCells({ text: "The Branches bar offers Favorite on the web route", origin: Origin.Ticket }, review([])), { pages: ["Branches"], surfaces: ["Web"] });
});

test("an across-pages criterion, or one naming no page, needs every touched page; one naming no surface needs every surface", () => {
  assert.deepEqual(requiredCells({ text: "Group by status, owner and priority where available.", origin: Origin.Prd }, review([])), { pages: ["Sessions", "Branches"], surfaces: ["Web", "Desktop"] });
  assert.deepEqual(requiredCells({ text: "A group count describes the rows it heads", origin: Origin.Ticket }, review([])).pages, ["Sessions", "Branches"]);
  assert.deepEqual(requiredCells({ text: "Every list page shows a Project column", origin: Origin.Ticket }, review([])).pages, ["Sessions", "Branches", "Documents"]);
  assert.deepEqual(requiredCells({ text: "Desktop shows the toast", origin: Origin.Ticket }, review([], { surfaces: ["Web"] })).surfaces, ["Desktop"]);
});

test("a PRD criterion naming only pages the unit does not touch is out of scope and listed", () => {
  const criteria = [{ id: "PRD-7:AC-2", text: "Documents keep their manual order inside a group.", origin: Origin.Prd }];
  const result = reviewGaps(criteria, review([]), passing);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(gapLines(result), ["OUT-OF-SCOPE PRD-7 AC-2: names only pages the unit does not touch"]);
});

test("code review alone, or visual QA alone, does not pass a criterion", () => {
  const criteria = [{ id: "ISS-1:AC-1", text: "A group count describes the rows it heads", origin: Origin.Ticket }];
  assert.deepEqual(reviewGaps(criteria, review([code("ISS-1:AC-1"), ...everyCell("ISS-1:AC-1")]), passing).gaps, []);
  assert.deepEqual(reviewGaps(criteria, review(everyCell("ISS-1:AC-1")), passing).gaps[0].missing, ["no code review row (file:line)"]);
  assert.equal(reviewGaps(criteria, review([code("ISS-1:AC-1")]), passing).gaps[0].missing.length, 4);
});

test("one page or one surface never stands in for the rest", () => {
  const criteria = [{ id: "ISS-1:AC-1", text: "Bulk Remove Tag shows a toast with Undo on Sessions and Branches", origin: Origin.Ticket }];
  const onlySessionsWeb = review([code("ISS-1:AC-1"), visual("ISS-1:AC-1", "Sessions", "Web")]);
  assert.deepEqual(reviewGaps(criteria, onlySessionsWeb, passing).gaps[0].missing, [
    "no visual QA capture for Sessions on Desktop", "no visual QA capture for Branches on Web", "no visual QA capture for Branches on Desktop",
  ]);
});

test("one capture used for two cells is refused, and a failing evidence check is a gap", () => {
  const criteria = [{ id: "ISS-1:AC-1", text: "Sessions shows the count on Web", origin: Origin.Ticket }];
  const reused = review([code("ISS-1:AC-1"), visual("ISS-1:AC-1", "Sessions", "Web", "same.png"), visual("ISS-1:AC-1", "Branches", "Web", "same.png")]);
  assert.deepEqual(reviewGaps(criteria, reused, passing).problems, ["one capture stands in for sessions on web and branches on web; each page on each surface needs its own capture"]);
  const broken = { codeRef: () => "code ref src/a.ts does not exist at HEAD", capture: () => ({ problem: "capture x.png does not exist", sha256: null }) };
  assert.deepEqual(reviewGaps(criteria, review([code("ISS-1:AC-1"), visual("ISS-1:AC-1", "Sessions", "Web")]), broken).gaps[0].missing, [
    "code ref src/a.ts does not exist at HEAD", "Sessions on Web: capture x.png does not exist",
  ]);
});

test("a PARTIAL or MISSED row is a gap, and rows for unknown criteria or malformed reviews are problems", () => {
  const criteria = [{ id: "ISS-1:AC-1", text: "Sessions on Web", origin: Origin.Ticket }];
  const partial = review([code("ISS-1:AC-1"), { ...visual("ISS-1:AC-1", "Sessions", "Web"), verdict: "PARTIAL", note: "no Undo" }]);
  assert.deepEqual(reviewGaps(criteria, partial, passing).gaps[0].missing, ["visual PARTIAL (no Undo)", "no visual QA capture for Sessions on Web"]);
  assert.deepEqual(reviewGaps(criteria, review([code("ISS-9:AC-1"), code("ISS-1:AC-1"), visual("ISS-1:AC-1", "Sessions", "Web")]), passing).problems, ["review row for ISS-9:AC-1, which the unit does not list"]);
  assert.deepEqual(reviewGaps(criteria, { rows: [] }, passing).problems, [
    "review.json needs pages as a list of names (both empty only for a unit with no user interface)", "review.json needs surfaces as a list of names (both empty only for a unit with no user interface)",
    "review.json needs listQueries: every grouped, sorted or paginated list query the unit touches, or an empty list when it touches none",
  ]);
});

test("the gap list is ordered by ticket and criterion number", () => {
  const lines = gapLines({ problems: [], outOfScope: [], gaps: [
    { ticket: "ISS-2", criterion: "AC-10", missing: ["x"] }, { ticket: "ISS-1", criterion: "AC-2", missing: ["y"] }, { ticket: "ISS-2", criterion: "AC-2", missing: ["z"] },
  ] });
  assert.deepEqual(lines, ["GAP ISS-1 AC-2: y", "GAP ISS-2 AC-2: z", "GAP ISS-2 AC-10: x"]);
});

test("the unit's criteria are the ticket's, every member's and every PRD's", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unit-criteria-"));
  try {
    writeFileSync(path.join(dir, "member.md"), "## Acceptance criteria\n\n- [ ] Branches bar offers Favorite\n");
    writeFileSync(path.join(dir, "prd.md"), PRD);
    const { criteria, problems } = unitCriteria({ slug: "ISS-1", ticket: "## Acceptance criteria\n\n- [ ] Sessions bar offers Priority\n", members: [`ISS-2=${path.join(dir, "member.md")}`], prds: [`PRD-7=${path.join(dir, "prd.md")}`], recorded: ["ISS-2", "ISS-3"] });
    assert.deepEqual(criteria.map(({ id }) => id), ["ISS-1:AC-1", "ISS-2:AC-1", "PRD-7:AC-1", "PRD-7:AC-2", "PRD-7:BR-8-01"]);
    assert.deepEqual(problems, ["member ISS-3 is recorded on the session but has no --member body; its criteria are not audited"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI prints the gap list, exits 1 until both parts pass on every page and surface, and records the unit's review", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unit-review-"));
  try {
    const wt = path.join(dir, "wt");
    mkdirSync(path.join(wt, "src"), { recursive: true });
    writeFileSync(path.join(wt, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    execFileSync("git", ["init", "-q", wt]);
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    writeFileSync(path.join(dir, "ticket.md"), "## Acceptance criteria\n\n- [ ] Sessions bar offers Priority on Web and Desktop\n");
    writeFileSync(path.join(dir, "member.md"), "## Acceptance criteria\n\n- [ ] Branches bar offers Favorite on Web and Desktop\n");
    for (const name of ["s-web", "s-desk", "b-web", "b-desk"]) writeFileSync(path.join(dir, `${name}.png`), Buffer.concat([PNG, Buffer.from(name)]));
    writeFileSync(path.join(dir, "text.png"), "not an image");
    const rows = [
      { criterion: "AC-1", part: "code", verdict: "MET", ref: "src/a.ts:2" },
      { criterion: "AC-1", part: "visual", verdict: "MET", page: "Sessions", surface: "Web", capture: "s-web.png" },
      { criterion: "AC-1", part: "visual", verdict: "MET", page: "Sessions", surface: "Desktop", capture: "s-desk.png" },
      { criterion: "ISS-2:AC-1", part: "code", verdict: "MET", ref: "src/a.ts:9" },
      { criterion: "ISS-2:AC-1", part: "visual", verdict: "MET", page: "Branches", surface: "Web", capture: "b-web.png" },
      { criterion: "ISS-2:AC-1", part: "visual", verdict: "MET", page: "Branches", surface: "Desktop", capture: "text.png" },
    ];
    const write = (list) => writeFileSync(path.join(dir, "review.json"), JSON.stringify({ pages: ["Sessions", "Branches"], surfaces: ["Web", "Desktop"], listQueries: [], rows: list }));
    const orch = path.join(dir, "orch");
    mkdirSync(orch);
    writeFileSync(path.join(orch, "board.json"), JSON.stringify({ units: { "ISS-1": { tickets: ["ISS-1", "ISS-2"], writer: "w" } } }));
    const run = () => spawnSync(process.execPath, [SCRIPT, "--worktree", wt, "--slug", "ISS-1", "--ticket", path.join(dir, "ticket.md"), "--member", `ISS-2=${path.join(dir, "member.md")}`, "--review", path.join(dir, "review.json"), "--at", "head", "--record", orch, "--unit", "ISS-1"], { encoding: "utf8" });
    write(rows);
    const failing = run();
    assert.equal(failing.status, 1, failing.stderr);
    assert.match(failing.stdout, /^GAP ISS-2 AC-1: code ref src\/a\.ts:9 is past the end of src\/a\.ts \(3 lines\); Branches on Desktop: capture .*text\.png is not a PNG, JPEG, WebP or GIF image$/m);
    assert.match(unitReviewProblem(orch, "ISS-1", { tickets: ["ISS-1", "ISS-2"] }), /has 1 gaps/);
    write([...rows.slice(0, 3), { ...rows[3], ref: "src/a.ts:1" }, rows[4], { ...rows[5], capture: "b-desk.png" }]);
    const passed = run();
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /^unit review: 2 criteria, 0 with gaps, 0 problems, 0 out of scope$/m);
    const recorded = JSON.parse(readFileSync(path.join(orch, "evidence", "unit-review-ISS-1.json"), "utf8"));
    assert.deepEqual([recorded.ok, recorded.tickets], [true, ["ISS-1", "ISS-2"]]);
    assert.equal(unitReviewProblem(orch, "ISS-1", { tickets: ["ISS-1", "ISS-2"] }), null);
    assert.match(unitReviewProblem(orch, "ISS-1", { tickets: ["ISS-1", "ISS-2", "ISS-4"] }), /does not cover ISS-4, added after it ran/);
    assert.match(unitReviewProblem(orch, "ISS-9", { tickets: ["ISS-9"] }), /has no recorded review/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a unit touching a grouped, sorted or paginated list query with no load-time criterion gets a GAP line", () => {
  const criteria = [{ id: "ISS-1:AC-1", text: "Issues can be grouped by Owner", origin: Origin.Ticket }];
  const rows = [code("ISS-1:AC-1"), ...everyCell("ISS-1:AC-1", ["Issues"])];
  const grouped = review(rows, { pages: ["Issues"], listQueries: [{ page: "Issues", kind: "grouped", ref: "src/a.ts:1" }] });
  const result = reviewGaps(criteria, grouped, { ...passing, anchor: "ISS-1" });
  assert.deepEqual(gapLines(result), ["GAP ISS-1 performance Issues grouped: no criterion names a load time for the grouped Issues list query; add one to the plan or the ticket's criteria"]);
  assert.deepEqual(reviewGaps(criteria, { ...grouped, listQueries: [] }, passing).gaps, [], "a unit that touches no list query owes no performance criterion");
});

test("a load-time criterion needs a measured row with its command, dataset size and a timing within the stated time", () => {
  assert.deepEqual([budgetMs("Grouping Issues by owner loads within 2 s at production scale"), budgetMs("Next page renders in 300 ms"), budgetMs("Issues can be grouped")], [2000, 300, null]);
  const text = "Grouping Issues by owner loads within 2 s at production scale";
  const criteria = [{ id: "PLN-5:AC-1", text, origin: Origin.Ticket }];
  const query = { pages: ["Issues"], listQueries: [{ page: "Issues", kind: "grouped", ref: "src/a.ts:1" }] };
  const base = [code("PLN-5:AC-1"), ...everyCell("PLN-5:AC-1", ["Issues"])];
  const measured = (extra) => ({ criterion: "PLN-5:AC-1", part: "measured", verdict: "MET", command: "pnpm perf group-owner", datasetRows: 48000, timingMs: 1400, ...extra });
  const gaps = (rows) => reviewGaps(criteria, review(rows, query), { ...passing, anchor: "ISS-1" }).gaps.map((gap) => gap.missing).flat();
  assert.deepEqual(gaps(base), ["no measured row (the command run, the dataset's row count and the timing) for its 2000 ms load time"]);
  assert.deepEqual(gaps([...base, measured({ timingMs: 31000 })]), ["measured 31000 ms on 48000 rows, over its 2000 ms load time"]);
  assert.deepEqual(gaps([...base, measured({ datasetRows: 0 })]), ["a measured row needs datasetRows, the dataset's row count"]);
  assert.deepEqual(gaps([...base, measured({ command: "" })]), ["a measured row needs the command it ran"]);
  assert.deepEqual(gaps([...base, measured()]), [], "the criterion names the query's page, kind and a load time, and its measurement is within it");
});

test("a plan's acceptance criteria join the unit's criteria, so the performance criterion can come from the plan", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unit-plan-"));
  try {
    writeFileSync(path.join(dir, "plan.md"), "## Acceptance criteria\n\n- [ ] Grouping Issues by owner loads within 2 s at production scale\n");
    const { criteria } = unitCriteria({ slug: "ISS-1", ticket: "## Acceptance criteria\n\n- [ ] Issues can be grouped by Owner\n", plans: [`PLN-5=${path.join(dir, "plan.md")}`] });
    assert.deepEqual(criteria.map(({ id, origin }) => `${id} ${origin}`), ["ISS-1:AC-1 ticket", "PLN-5:AC-1 ticket"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a unit with no user interface passes on code rows alone, and a criterion there that still names a page or surface is a gap", () => {
  const criteria = [
    { id: "ISS-1:AC-1", text: "The audit refuses a review with no code row", origin: Origin.Ticket },
    { id: "ISS-1:AC-2", text: "The API rejects a malformed batch", origin: Origin.Ticket },
  ];
  const noUi = review([code("ISS-1:AC-1"), code("ISS-1:AC-2")], { pages: [], surfaces: [] });
  assert.deepEqual(reviewGaps(criteria, noUi, passing), { gaps: [], problems: [], outOfScope: [], notVisible: [] });
  assert.deepEqual(reviewGaps(criteria, review([code("ISS-1:AC-1")], { pages: [], surfaces: [] }), passing).gaps, [{ ticket: "ISS-1", criterion: "AC-2", missing: ["no code review row (file:line)"] }]);
  const visible = [{ id: "ISS-1:AC-3", text: "Documents shows the Project column on Desktop", origin: Origin.Ticket }];
  assert.deepEqual(reviewGaps(visible, review([code("ISS-1:AC-3")], { pages: [], surfaces: [] }), passing).gaps[0].missing,
    ["names Documents, Desktop, so it is user-visible and needs visual QA, but the review declares no pages or surfaces", "no visual QA capture for Documents on Desktop"]);
  assert.deepEqual(reviewGaps(criteria, review([], { pages: ["Sessions"], surfaces: [] }), passing).problems,
    ["review.json declares pages without surfaces, or surfaces without pages; a unit with a user interface names both, one with none leaves both empty"]);
});

test("a unit with no user interface records a passing review from code rows, so its tickets may move", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unit-review-no-ui-"));
  try {
    const wt = path.join(dir, "wt");
    mkdirSync(wt);
    writeFileSync(path.join(wt, "a.mjs"), "export const a = 1;\n");
    execFileSync("git", ["init", "-q", wt]);
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    writeFileSync(path.join(dir, "ticket.md"), "## Acceptance criteria\n\n- [ ] The audit refuses a review with no code row\n");
    writeFileSync(path.join(dir, "member.md"), "## Acceptance criteria\n\n- [ ] The guard refuses an unreviewed move\n");
    writeFileSync(path.join(dir, "review.json"), JSON.stringify({ pages: [], surfaces: [], listQueries: [], rows: [
      { criterion: "AC-1", part: "code", verdict: "MET", ref: "a.mjs:1" }, { criterion: "ISS-2:AC-1", part: "code", verdict: "MET", ref: "a.mjs:1" },
    ] }));
    const orch = path.join(dir, "orch");
    mkdirSync(orch);
    writeFileSync(path.join(orch, "board.json"), JSON.stringify({ units: { "ISS-1": { tickets: ["ISS-1", "ISS-2"], writer: "w" } } }));
    const result = spawnSync(process.execPath, [SCRIPT, "--worktree", wt, "--slug", "ISS-1", "--ticket", path.join(dir, "ticket.md"), "--member", `ISS-2=${path.join(dir, "member.md")}`,
      "--review", path.join(dir, "review.json"), "--at", "head", "--record", orch, "--unit", "ISS-1"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(unitReviewProblem(orch, "ISS-1", { tickets: ["ISS-1", "ISS-2"] }), null);
    assert.equal(unitStatusProblem({ slug: "ISS-2", status: "DONE", cwd: dir, home: orch }), null, "the status guard lets a reviewed non-UI unit's tickets move");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a NOT-VISIBLE row stands in for visual QA only on a criterion naming no page or surface, needs its reason, and is printed for the operator", () => {
  const notVisible = (criterion, reason = "the API refuses it before any page renders") => ({ criterion, part: "visual", verdict: "NOT-VISIBLE", reason });
  const apiOnly = [{ id: "ISS-1:AC-1", text: "The API rejects a malformed batch", origin: Origin.Ticket }];
  const accepted = reviewGaps(apiOnly, review([code("ISS-1:AC-1"), notVisible("ISS-1:AC-1")]), passing);
  assert.deepEqual([accepted.gaps, accepted.problems], [[], []]);
  assert.deepEqual(gapLines(accepted), ["NOT-VISIBLE ISS-1 AC-1: the API refuses it before any page renders"]);
  const refused = (text, row = notVisible("ISS-1:AC-1")) => reviewGaps([{ id: "ISS-1:AC-1", text, origin: Origin.Ticket }], review([code("ISS-1:AC-1"), row]), passing);
  assert.deepEqual(refused("The Sessions API rejects a malformed batch").gaps[0].missing, [
    "NOT-VISIBLE is refused: it names Sessions, so it needs visual QA", "no visual QA capture for Sessions on Web", "no visual QA capture for Sessions on Desktop",
  ]);
  assert.match(refused("Documents rejects a malformed batch").gaps[0].missing[0], /^NOT-VISIBLE is refused: it names Documents/, "a page from otherPages counts too");
  assert.match(refused("The API rejects a malformed batch on Desktop").gaps[0].missing[0], /^NOT-VISIBLE is refused: it names Desktop/);
  assert.match(refused("The API rejects a malformed batch on every list page").gaps[0].missing[0], /^NOT-VISIBLE is refused: it names every page/);
  assert.match(refused("The API rejects a malformed batch on both surfaces").gaps[0].missing[0], /^NOT-VISIBLE is refused: it names every surface/);
  const blank = refused("The API rejects a malformed batch", notVisible("ISS-1:AC-1", "  "));
  assert.equal(blank.gaps[0].missing[0], "a NOT-VISIBLE row needs its reason");
  assert.deepEqual(gapLines(blank).filter((line) => line.startsWith("NOT-VISIBLE")), [], "a refused exemption is never printed as one");
});
