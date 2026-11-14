#!/usr/bin/env node
// The review of a grouped unit's completed work: every criterion of every
// ticket the unit delivers, plus its PRD's criteria for the pages it touches,
// passes BOTH a code review and a visual QA pass before the unit is ready
// (operator ruling, 2026-11-10: "ensuring all acceptance criteria is met ...
// includes both code and visual-qa"). Production acceptance testing of one
// PRD's list-page work found 33 misses that review let through, nearly all of
// one shape: a capability one list page or one surface had and a sibling page
// or the other surface did not (a column, a bulk action, a group-by option,
// a toast and Undo, a count). The audit took one row of any evidence type
// per criterion, so a source trace stood in for seeing the page, one page
// stood in for its siblings, Web stood in for Desktop, and the PRD's own
// cross-page rules were never read.
//
// Usage: unit-review.mjs --worktree <wt> --ticket <body .md> --review <review.json>
//          [--slug <ticket slug>] [--member <slug>=<body .md> ...] [--prd <slug>=<body .md> ...] [--plan <slug>=<body .md> ...]
//          [--at head] [--json] [--record <orchDir> --unit <name>]
//
// Criteria: the ticket's checklist as <slug>:AC-n (`--slug`, else the
// session's ticket), each member's as <member>:AC-n, and each PRD's as
// <PRD>:<id>: an acceptance checklist item is AC-n, a line that leads with its
// own id (`**BR-8-01.** Group by ...`) keeps that id. A PRD criterion is in
// scope when it names a page the unit touches, names no page at all, or
// applies across pages; one naming only other pages is printed OUT-OF-SCOPE.
// A plan's criteria (`--plan`) are read the same way and scoped like a ticket's.
//
// review.json, written by the reviewer of the completed work:
//   {"pages": [<pages the unit touches>], "otherPages": [<the product's other page names>],
//    "surfaces": [<every surface the unit ships to, e.g. "Web", "Desktop">],
//    "listQueries": [<every grouped, sorted or paginated list query it touches, list-query-performance.mjs>],
//    "rows": [{"criterion", "part": "code", "verdict": "MET", "ref": "<file>:<line>"},
//             {"criterion", "part": "visual", "verdict": "MET", "page", "surface", "capture": "<image>"},
//             {"criterion", "part": "measured", "verdict": "MET", "command", "datasetRows", "timingMs"}]}
// Each criterion needs a MET code row whose file exists (at HEAD with
// `--at head`) and has that line, and a MET visual row for each page and each
// surface it requires: the pages and surfaces it names; every touched page
// (and, for a ticket criterion, every other page) when it says "every list
// page", "each page", "where available" and the like; every touched page when
// it names none; every declared surface when it names none or says "both
// surfaces". One capture is one page on one surface: the same image for two
// cells is refused. A unit with no user interface (a plugin or backend-only
// change) leaves pages and surfaces empty: its criteria need code rows alone,
// and one that still names a page, a surface or every page is a gap. A capture path is absolute or relative to review.json,
// and must be a PNG, JPEG, WebP or GIF. A criterion with no user-visible
// behaviour inside a UI unit ("the API rejects X") may instead have one
// visual row with verdict NOT-VISIBLE and its reason; it is refused for a
// criterion that names a page or surface or uses cross-page or cross-surface
// wording, and every accepted one prints `NOT-VISIBLE <ticket> <criterion>: <reason>`. A criterion that states a load time
// also needs a measured row within it, and every listed list query needs such
// a criterion naming its page and kind.
//
// Prints `GAP <ticket> <criterion>: <missing>` for every criterion without
// passing evidence, by ticket and criterion number, then a summary line (or
// JSON with --json); exits 1 on any gap or problem. With `--record`, writes the
// result to <orchDir>/evidence/unit-review-<unit>.json, which board.mjs unit
// --closed and status-audit.mjs --board read, and refuses a unit ticket on the
// board that has no criteria here.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { criteriaStates, memberCriteria, ticketCriteria } from "./criteria-list.mjs";
import { listQueryGaps, listQueryShapeProblems, measuredMissing } from "./list-query-performance.mjs";
import { readBoard } from "../../fleet-orchestrator/scripts/ticket-units.mjs";
import { trackerKey } from "../../vibe/scripts/tracker-key.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { evidenceFingerprint } = await vibeCore("lib/handoff/scripts/handoff-evidence.mjs");
const { readSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { unitReviewFile } = await vibeCore("lib/handoff/scripts/unit-review-record.mjs");
const { providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const Part = Object.freeze({ Code: "code", Visual: "visual", Measured: "measured" });
export const Origin = Object.freeze({ Ticket: "ticket", Prd: "prd" });

// The bound tracker's ticket key and document slug prefixes (provider data); none match without a tracker.
const slugPattern = () => new RegExp(`^${trackerKey()}$`);
const documentPrefix = () => new RegExp(providerDataOr(sessionBinding(null), "tickets", "documentPrefix", "(?!)"));
const ID_LINE = /^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?)?(?:\*\*)?([A-Z]{1,6}-\d+(?:[-.]\d+)*)\.?(?:\*\*)?[.:]?\s+(\S.*)$/;
const ACROSS_PAGES = /\b(?:every|each|all|across)(?: the| all)?(?: \w+)? pages?\b|\bwhere(?:ver)? (?:it is |they are )?available\b/i;
const ACROSS_SURFACES = /\bboth (?:surfaces|hosts|shells|platforms|apps)\b|\b(?:every|each|all) (?:surfaces?|hosts?|shells?|platforms?)\b/i;
const KNOWN_SURFACES = Object.freeze(["Web", "Desktop"]);
export const NOT_VISIBLE = "NOT-VISIBLE";
const CODE_REF = /^(.+?):(\d+)(?:-(\d+))?$/;
const IMAGE_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]];

/** The PRD's criteria: checklist items under an acceptance heading, and lines that lead with their own id. */
export function prdCriteria(slug, body) {
  const found = new Map();
  for (const { id, text } of criteriaStates(body)) {
    const own = ID_LINE.exec(`- ${text}`);
    const key = own && !documentPrefix().test(own[1]) ? own[1] : id;
    found.set(key, { id: `${slug}:${key}`, text: own && key === own[1] ? own[2] : text, origin: Origin.Prd });
  }
  for (const line of body.split("\n")) {
    const match = ID_LINE.exec(line);
    if (!match || documentPrefix().test(match[1]) || found.has(match[1])) continue;
    found.set(match[1], { id: `${slug}:${match[1]}`, text: match[2].trim(), origin: Origin.Prd });
  }
  return [...found.values()];
}

/** Names from `names` that `text` mentions as a word, singular or plural. */
export function namesIn(text, names) {
  return names.filter((name) => {
    const variants = [name, name.replace(/e?s$/i, ""), name.replace(/s$/i, "")].filter(Boolean).map(escapeRegex);
    return new RegExp(`(^|[^A-Za-z0-9])(?:${[...new Set(variants)].join("|")})s?(?![A-Za-z0-9])`, "i").test(text);
  });
}

/** The pages and surfaces a criterion needs a capture for, or null when a PRD criterion is out of the unit's scope. */
export function requiredCells(criterion, review) {
  const pages = review.pages;
  const named = namesIn(criterion.text, [...pages, ...review.otherPages]);
  const across = ACROSS_PAGES.test(criterion.text);
  let required;
  if (criterion.origin === Origin.Prd) {
    const touched = named.filter((page) => includesName(pages, page));
    if (named.length > 0 && touched.length === 0 && !across) return null;
    required = across || named.length === 0 ? pages : touched;
  } else if (across) {
    required = [...pages, ...review.otherPages];
  } else {
    required = named.length > 0 ? named : pages;
  }
  const declared = review.surfaces;
  const surfaceNames = [...declared, ...KNOWN_SURFACES.filter((surface) => !includesName(declared, surface))];
  const namedSurfaces = namesIn(criterion.text, surfaceNames);
  const surfaces = ACROSS_SURFACES.test(criterion.text) || namedSurfaces.length === 0
    ? [...new Set([...declared, ...namedSurfaces])]
    : namedSurfaces;
  return { pages: [...new Set(required)], surfaces };
}

/** Every criterion's gaps against the review rows; `capture` and `codeRef` check one row's evidence. */
export function reviewGaps(criteria, review, { codeRef = () => null, capture = () => ({ problem: null, sha256: null }), anchor = "unit" } = {}) {
  const gaps = [];
  const problems = shapeProblems(review);
  if (problems.length > 0) return { gaps, problems, outOfScope: [] };
  const known = new Set(criteria.map(({ id }) => id));
  const rows = review.rows;
  for (const row of rows) {
    if (!known.has(row?.criterion)) problems.push(`review row for ${row?.criterion ?? "(no criterion)"}, which the unit does not list`);
  }
  problems.push(...captureReuse(rows, capture));
  const outOfScope = [];
  const notVisible = [];
  for (const criterion of criteria) {
    const cells = requiredCells(criterion, review);
    if (cells === null) {
      outOfScope.push(criterion);
      continue;
    }
    const own = rows.filter((row) => row?.criterion === criterion.id);
    const missing = [];
    const visible = review.pages.length === 0 ? userVisibleNames(criterion.text, review) : [];
    if (visible.length > 0) missing.push(`names ${visible.join(", ")}, so it is user-visible and needs visual QA, but the review declares no pages or surfaces`);
    const exempt = notVisibleRow(criterion, own, review, missing);
    if (exempt) notVisible.push({ ...splitId(criterion.id), reason: exempt.reason.trim() });
    for (const row of own.filter((entry) => entry.verdict !== "MET" && entry.verdict !== NOT_VISIBLE)) missing.push(`${row.part} ${row.verdict ?? "with no verdict"}${row.note ? ` (${row.note})` : ""}`);
    const code = own.filter((row) => row.part === Part.Code && row.verdict === "MET");
    const codeProblems = code.map((row) => codeRef(row.ref)).filter(Boolean);
    if (code.length === 0) missing.push("no code review row (file:line)");
    else if (codeProblems.length === code.length) missing.push(...codeProblems);
    for (const page of exempt ? [] : cells.pages) {
      for (const surface of cells.surfaces) {
        const visual = own.filter((row) => row.part === Part.Visual && row.verdict === "MET" && sameName(row.page, page) && sameName(row.surface, surface));
        const checked = visual.map((row) => capture(row.capture).problem);
        if (visual.length === 0) missing.push(`no visual QA capture for ${page} on ${surface}`);
        else if (checked.every(Boolean)) missing.push(`${page} on ${surface}: ${checked[0]}`);
      }
    }
    missing.push(...measuredMissing(criterion, own));
    if (missing.length > 0) gaps.push({ ...splitId(criterion.id), missing });
  }
  const inScope = criteria.filter((criterion) => !outOfScope.includes(criterion));
  const namesPage = (text, page) => namesIn(text, [page]).length > 0 || ACROSS_PAGES.test(text);
  gaps.push(...listQueryGaps(review.listQueries, inScope, { anchor, namesPage, codeRef }));
  return { gaps, problems, outOfScope, notVisible };
}

/** One line per gap, by ticket then criterion number, for the operator. */
export function gapLines({ gaps, problems, outOfScope, notVisible = [] }) {
  const order = (id) => id.split(/[^0-9]+/).filter(Boolean).map(Number);
  const sorted = [...gaps].sort((a, b) => a.ticket.localeCompare(b.ticket) || compareNumbers(order(a.criterion), order(b.criterion)) || a.criterion.localeCompare(b.criterion));
  return [
    ...problems.map((problem) => `PROBLEM ${problem}`),
    ...sorted.map((gap) => `GAP ${gap.ticket} ${gap.criterion}: ${gap.missing.join("; ")}`),
    ...notVisible.map((entry) => `NOT-VISIBLE ${entry.ticket} ${entry.criterion}: ${entry.reason}`),
    ...outOfScope.map((criterion) => `OUT-OF-SCOPE ${criterion.id.replace(":", " ")}: names only pages the unit does not touch`),
  ];
}

/** The criteria the unit is reviewed against: the ticket's, every member's and every PRD's. */
export function unitCriteria({ slug, ticket, members = [], prds = [], plans = [], recorded = [] }) {
  const own = ticketCriteria(ticket).map(({ id, text }) => ({ id: `${slug}:${id}`, text, origin: Origin.Ticket }));
  const memberSet = memberCriteria(members, recorded);
  const problems = [...(own.length === 0 ? ["the ticket has no acceptance criteria checklist"] : []), ...memberSet.problems];
  const documentCriteria = (entries, flag, kind, origin) => entries.flatMap((entry) => {
    const at = entry.indexOf("=");
    const document = entry.slice(0, at);
    if (at <= 0 || !slugPattern().test(document)) throw new Error(`${flag} needs <slug>=<${kind} body file>, got ${entry}`);
    const criteria = prdCriteria(document, readFileSync(entry.slice(at + 1), "utf8")).map((criterion) => ({ ...criterion, origin }));
    if (criteria.length === 0) problems.push(`${kind} ${document} has no criteria this review can read (an acceptance checklist or lines that lead with an id)`);
    return criteria;
  });
  const fromPrds = documentCriteria(prds, "--prd", "PRD", Origin.Prd);
  const fromPlans = documentCriteria(plans, "--plan", "plan", Origin.Ticket);
  return { criteria: [...own, ...memberSet.criteria.map((criterion) => ({ ...criterion, origin: Origin.Ticket })), ...fromPlans, ...fromPrds], problems };
}

function shapeProblems(review) {
  const problems = [];
  for (const key of ["pages", "surfaces"]) {
    if (!Array.isArray(review?.[key]) || review[key].some((entry) => typeof entry !== "string" || !entry.trim())) {
      problems.push(`review.json needs ${key} as a list of names (both empty only for a unit with no user interface)`);
    }
  }
  if (Array.isArray(review?.pages) && Array.isArray(review?.surfaces) && (review.pages.length === 0) !== (review.surfaces.length === 0)) {
    problems.push("review.json declares pages without surfaces, or surfaces without pages; a unit with a user interface names both, one with none leaves both empty");
  }
  if (review?.otherPages !== undefined && (!Array.isArray(review.otherPages) || review.otherPages.some((entry) => typeof entry !== "string"))) problems.push("review.json otherPages must be a list of page names");
  problems.push(...listQueryShapeProblems(review?.listQueries));
  if (!Array.isArray(review?.rows)) problems.push("review.json needs rows");
  else {
    review.rows.forEach((row, index) => {
      if (!Object.values(Part).includes(row?.part)) problems.push(`review row ${index + 1} needs part "code", "visual" or "measured"`);
      else if (row.part === Part.Code && typeof row.ref !== "string") problems.push(`review row ${index + 1} (code) needs ref <file>:<line>`);
      else if (row.part === Part.Visual && row.verdict !== NOT_VISIBLE && ["page", "surface", "capture"].some((key) => typeof row[key] !== "string" || !row[key].trim())) problems.push(`review row ${index + 1} (visual) needs page, surface and capture`);
    });
  }
  review.otherPages ??= [];
  return problems;
}

function captureReuse(rows, capture) {
  const cells = new Map();
  for (const row of rows.filter((entry) => entry?.part === Part.Visual && entry.verdict === "MET")) {
    const { sha256 } = capture(row.capture);
    if (!sha256) continue;
    const cell = `${row.page.toLowerCase()} on ${row.surface.toLowerCase()}`;
    cells.set(sha256, new Set([...(cells.get(sha256) ?? []), cell]));
  }
  return [...cells.values()].filter((set) => set.size > 1).map((set) => `one capture stands in for ${[...set].join(" and ")}; each page on each surface needs its own capture`);
}

/**
 * An accepted NOT-VISIBLE visual row for a criterion, or null. Refusals go to `missing`: a row needs its
 * reason, and only a criterion naming no page or surface, with no cross-page or cross-surface wording, may have one.
 */
function notVisibleRow(criterion, own, review, missing) {
  const row = own.find((entry) => entry.part === Part.Visual && entry.verdict === NOT_VISIBLE);
  if (!row) return null;
  if (typeof row.reason !== "string" || !row.reason.trim()) {
    missing.push("a NOT-VISIBLE row needs its reason");
    return null;
  }
  const named = [...namesIn(criterion.text, [...review.pages, ...review.otherPages, ...review.surfaces, ...KNOWN_SURFACES])];
  if (ACROSS_PAGES.test(criterion.text)) named.push("every page");
  if (ACROSS_SURFACES.test(criterion.text)) named.push("every surface");
  if (named.length > 0) {
    missing.push(`NOT-VISIBLE is refused: it names ${[...new Set(named)].join(", ")}, so it needs visual QA`);
    return null;
  }
  return row;
}

function splitId(id) {
  return { ticket: id.slice(0, id.indexOf(":")), criterion: id.slice(id.indexOf(":") + 1) };
}

/** In a review that declares no user interface: the pages, surfaces or cross-page wording a criterion still names. */
function userVisibleNames(text, review) {
  const named = [...namesIn(text, [...review.otherPages, ...KNOWN_SURFACES])];
  if (ACROSS_PAGES.test(text)) named.push("every page");
  if (ACROSS_SURFACES.test(text)) named.push("every surface");
  return named;
}

function compareNumbers(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

function includesName(list, name) {
  return list.some((entry) => sameName(entry, name));
}

function sameName(a, b) {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Checks a `file:line` ref against the worktree or HEAD. */
function codeRefChecker(worktree, at) {
  return (ref) => {
    const match = CODE_REF.exec(String(ref ?? "").trim());
    if (!match) return `code ref ${JSON.stringify(ref)} is not <file>:<line>`;
    const [, file, start, end] = match;
    let text;
    try {
      text = at === "head"
        ? execFileSync("git", ["-C", worktree, "show", `HEAD:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 })
        : readFileSync(path.join(worktree, file), "utf8");
    } catch {
      return `code ref ${file} does not exist ${at === "head" ? "at HEAD" : "in the worktree"}`;
    }
    const lines = text.split("\n").length;
    return Number(end ?? start) > lines || Number(start) < 1 ? `code ref ${ref} is past the end of ${file} (${lines} lines)` : null;
  };
}

/** Checks a capture is a real image file; memoized by path. */
function captureChecker(base) {
  const seen = new Map();
  return (file) => {
    const resolved = path.resolve(base, String(file ?? ""));
    if (!seen.has(resolved)) seen.set(resolved, checkCapture(resolved));
    return seen.get(resolved);
  };
}

function checkCapture(file) {
  if (!existsSync(file)) return { problem: `capture ${file} does not exist`, sha256: null };
  let print;
  try { print = evidenceFingerprint(file); }
  catch (error) { return { problem: `capture ${file}: ${error instanceof Error ? error.message : String(error)}`, sha256: null }; }
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  const image = IMAGE_MAGIC.some((magic) => magic.every((byte, index) => head[index] === byte))
    && (head[0] !== 0x52 || head.subarray(8, 12).toString("latin1") === "WEBP");
  return image ? { problem: null, sha256: print.sha256 } : { problem: `capture ${file} is not a PNG, JPEG, WebP or GIF image`, sha256: null };
}

function anchorSlug(worktree) {
  try {
    const record = readSessionRecord(worktree);
    return { slug: record?.liveTicket ?? record?.ticket ?? null, members: record?.memberTickets ?? [] };
  } catch {
    return { slug: null, members: [] };
  }
}

/** Reviews a unit's completed work from files: the criteria, the gaps and the operator's lines. */
export function reviewUnit({ worktree, ticket, review, slug, members = [], prds = [], plans = [], at, unitTickets }) {
  const session = anchorSlug(worktree);
  const anchor = slug ?? session.slug;
  if (!anchor || !slugPattern().test(anchor)) throw new Error("name the ticket with --slug <slug>; the worktree has no session ticket");
  const { criteria, problems: criteriaProblems } = unitCriteria({ slug: anchor, ticket: readFileSync(ticket, "utf8"), members, prds, plans, recorded: session.members });
  const parsed = JSON.parse(readFileSync(review, "utf8"));
  if (Array.isArray(parsed?.rows)) parsed.rows = parsed.rows.map((row) => (/^AC-\d+$/.test(row?.criterion ?? "") ? { ...row, criterion: `${anchor}:${row.criterion}` } : row));
  const result = reviewGaps(criteria, parsed, { codeRef: codeRefChecker(worktree, at), capture: captureChecker(path.dirname(path.resolve(review))), anchor });
  result.problems.unshift(...criteriaProblems);
  const tickets = [anchor, ...members.map((entry) => entry.slice(0, entry.indexOf("=")))];
  for (const missing of (unitTickets ?? []).filter((entry) => !tickets.includes(entry))) result.problems.push(`unit ticket ${missing} has no criteria in this review; pass --member ${missing}=<its body>`);
  const ok = result.gaps.length === 0 && result.problems.length === 0;
  const headRead = spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const head = headRead.status === 0 ? headRead.stdout.trim() : null;
  const lines = [...gapLines(result), `unit review: ${criteria.length - result.outOfScope.length} criteria, ${result.gaps.length} with gaps, ${result.problems.length} problems, ${result.outOfScope.length} out of scope`];
  return { ok, head, tickets, criteria: criteria.map(({ id }) => id), outOfScope: result.outOfScope.map(({ id }) => id), notVisible: result.notVisible, gaps: result.gaps, problems: result.problems, lines };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, ticket: { type: "string" }, review: { type: "string" }, slug: { type: "string" },
    member: { type: "string", multiple: true }, prd: { type: "string", multiple: true }, plan: { type: "string", multiple: true }, at: { type: "string" },
    json: { type: "boolean" }, record: { type: "string" }, unit: { type: "string" },
  } });
  if (!values.worktree || !values.ticket || !values.review || Boolean(values.record) !== Boolean(values.unit)) {
    throw new Error("Usage: unit-review.mjs --worktree <wt> --ticket <body> --review <review.json> [--slug <ticket>] [--member <slug>=<body> ...] [--prd <slug>=<body> ...] [--plan <slug>=<body> ...] [--at head] [--json] [--record <orchDir> --unit <name>]");
  }
  let unitTickets;
  if (values.record) {
    unitTickets = readBoard(values.record).units[values.unit]?.tickets;
    if (!unitTickets) throw new Error(`no open unit ${values.unit} on the board`);
  }
  const { lines, ...summary } = reviewUnit({ ...values, members: values.member ?? [], prds: values.prd ?? [], plans: values.plan ?? [], unitTickets });
  if (values.record) {
    const file = unitReviewFile(values.record, values.unit);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ unit: values.unit, at: new Date().toISOString(), ...summary }, null, 2)}\n`);
  }
  process.stdout.write(values.json ? `${JSON.stringify(summary, null, 2)}\n` : `${lines.join("\n")}\n`);
  return summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
