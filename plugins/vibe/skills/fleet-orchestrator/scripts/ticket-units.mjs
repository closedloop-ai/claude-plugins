#!/usr/bin/env node
// Groups related tickets into units: one writer, one branch, one PR per unit
// (operator ruling, 2026-11-09). The orchestrator the operator ran until then found every ticket
// related to the one it was about to start and delivered them together
// ("that is THE reason why fleet-orchestrator was so effective at finishing
// work"). That lived only in chat rulings, so a fresh chat worked one ticket
// per writer and one PR per ticket, even when several changed the same screen.
//
// Usage: ticket-units.mjs group --candidates <candidates.json> [--board <orchDir>]
//        ticket-units.mjs pr-check --board <orchDir> --unit <name> --title <title> --body-file <file>
//
// candidates.json, gathered with cl-find-related-tickets and the bound graph
// tools (the provider's ticket-units reference says which tool fills which field):
//   {"tickets": [{"slug", "repo": "<owner/repo>",
//      "prd": "<the PRD it belongs to, from its artifact links>",
//      "operatorAssigned": <true when the operator is its assignee>,
//      "files": [<repo-relative paths the ticket is expected to change>],
//      "historyFiles": [<paths only past changes touched (the graph's ticket history)>],
//      "surfaces": [<screen map ids>],
//      "blockers": [{"slug", "met": <true once merged or DONE>}]}],
//    "collisions": [{"a", "b", "reason"}],
//    "apart": [{"a", "b", "reason"}]}
// List the ticket you are about to start first: a new unit is named after its
// first listed ticket.
//
// Two tickets in the same repository join on a shared expected file, a shared
// screen map entry or a collision pair. Open tickets under one PRD that are
// assigned to the operator join as `same PRD <slug>` with nothing shared
// (operator ruling, 2026-11-09: "if a PRD is being worked on, all tickets
// assigned to the user under that PRD should be grouped together and worked
// on as one PR"); one in another repository is that repository's own unit for
// the PRD, and the line says so, because a PR cannot span repositories. A pair that shares only history files
// joins too, labelled `(history)`; the orchestrator may keep that pair apart
// with an `apart` entry and its one-line reason. `apart` on any other pair is
// refused. Tickets in different repositories never join. A ticket with an
// unmet blocker outside its unit stays separate and is printed BLOCKED; a
// blocker inside the unit is built in order on the same branch (cl-sweep
// references/feature-units.md, `scheduled_in_unit`).
//
// A ticket with `operatorAssigned: false` never joins a unit for any reason; a
// related one prints RELATED with the unit, for the operator to decide. A
// `prd` needs `operatorAssigned`. An `apart` pair must be related; when it
// still joins through other tickets, the line says so instead of "kept
// apart". Malformed fields exit 2.
//
// With `--board`, the open units on the board (board.mjs unit; a unit closed
// with `--closed` is finished) are in flight: their tickets stay together, and
// a ticket that joins one prints FOLD into that unit and its writer instead of
// a new unit.
//
// Prints one line per unit, which is the operator's line:
//   UNIT <name> <a, b>: <a>~<b> <reason>; ...
//   UNIT <name> <a> alone: <why it is kept apart>
//   UNIT <name> <a, b>: in flight (<writer>)
//   FOLD <ticket> into <unit> (<writer>): <ticket>~<member> <reason>
//   BLOCKED <ticket> by <blocker>: kept separate until it merges
//   RELATED <ticket> to unit <unit>: <ticket>~<member> <reason>; it has another owner ...
//   OVERLAP <unit> <unit>: two in-flight units are related; give one owner or a merge order
// Exits 0. Malformed input exits 2.
//
// `pr-check` exits 1 until the PR title and body name every ticket of the unit.
// board.mjs status prints `unitMemberProblems`: UNIT-MEMBERS-UNRECORDED for a
// local writer whose vibe session has not recorded every other ticket of its
// unit as a member, and UNIT-MEMBERS-UNCHECKED when that cannot be read (a
// remote writer, no writer row or worktree, no or unreadable session record).
// A new unit takes the name of its first ticket; when a closed unit already
// has that name, it gets the next free `<name>#<n>`.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requirementsKey, trackerKey } from "../../vibe/scripts/tracker-key.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { resolveWorkDir } = await vibeCore("lib/codex-fleet-monitor/scripts/work-dir.mjs");
const { missingTicketNames } = await vibeCore("lib/handoff/scripts/ticket-names.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

// The bound tracker's ticket key; ticket units exist only with a tracker bound.
const slugPattern = () => new RegExp(`^${trackerKey()}$`);
const requirementsPattern = () => new RegExp(`^${requirementsKey()}$`);

/** The board's open units (closed ones are finished), its writer rows, and every unit name already used. */
export function readBoard(orchDir) {
  const file = path.join(resolveWorkDir(orchDir).dir, "board.json");
  const board = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { units: openUnits(board.units ?? {}), writers: board.writers ?? {}, names: Object.keys(board.units ?? {}) };
}

/** `base`, or `base#2`, `base#3`, ... when a closed unit already has the name. */
export function freeUnitName(base, taken) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

/** The open units recorded on a program's board, `{}` when it has none. */
export function boardUnits(orchDir) {
  return readBoard(orchDir).units;
}

/** Units not yet closed with `board.mjs unit <name> --closed <PR>`. */
export function openUnits(units) {
  return Object.fromEntries(Object.entries(units).filter(([, unit]) => !unit.closed));
}

/** Why two tickets are related, strongest evidence first, or an empty list. */
export function joinReasons(a, b, collisions = []) {
  const reasons = [];
  if (a.prd && a.prd === b.prd && a.operatorAssigned === true && b.operatorAssigned === true) reasons.push(`same PRD ${a.prd}`);
  const files = new Set(a.files ?? []);
  for (const file of b.files ?? []) if (files.has(file)) reasons.push(`shared file ${file}`);
  const surfaces = new Set(a.surfaces ?? []);
  for (const surface of b.surfaces ?? []) if (surfaces.has(surface)) reasons.push(`shared screen ${surface}`);
  for (const pair of collisions) {
    if ((pair.a === a.slug && pair.b === b.slug) || (pair.a === b.slug && pair.b === a.slug)) {
      reasons.push(`collision${pair.reason ? `: ${pair.reason}` : ""}`);
    }
  }
  if (reasons.length > 0) return reasons;
  const touched = new Set([...(a.files ?? []), ...(a.historyFiles ?? [])]);
  return [...new Set([...(b.files ?? []), ...(b.historyFiles ?? [])])]
    .filter((file) => touched.has(file)).map((file) => `shared file ${file} (history)`);
}

/** Groups the candidates against the in-flight units; pure. */
export function groupTickets(candidates, units = {}, takenNames = Object.keys(units)) {
  const tickets = validTickets(candidates);
  const collisions = candidates.collisions ?? [];
  // A ticket assigned to someone else never joins a unit; it is only reported as related.
  const foreign = tickets.filter((ticket) => ticket.operatorAssigned === false);
  const bySlug = new Map(tickets.filter((ticket) => ticket.operatorAssigned !== false).map((ticket) => [ticket.slug, ticket]));
  const unitOf = new Map();
  for (const [name, unit] of Object.entries(units)) {
    for (const slug of unit.tickets ?? []) {
      unitOf.set(slug, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, repo: unit.repo ?? null, files: [], historyFiles: [], surfaces: [], blockers: [] });
    }
  }
  const all = [...bySlug.values()];
  const apart = apartPairs(candidates, [...all, ...foreign], collisions);
  const related = (a, b) => (a.repo === b.repo ? joinReasons(a, b, collisions) : []);
  const edges = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const [a, b] = [all[i], all[j]];
      if (apart.has(pairKey(a.slug, b.slug))) continue;
      const reasons = related(a, b);
      if (reasons.length > 0) edges.push({ a: a.slug, b: b.slug, reasons });
    }
  }
  const blocked = new Map();
  let components;
  for (;;) {
    components = connect(all.map((ticket) => ticket.slug).filter((slug) => !blocked.has(slug)), edges, units);
    const added = all.filter((ticket) => !blocked.has(ticket.slug) && !unitOf.has(ticket.slug)).flatMap((ticket) => {
      const members = components.find((component) => component.includes(ticket.slug));
      const unmet = (ticket.blockers ?? []).find((blocker) => !blocker.met && !members.includes(blocker.slug));
      return unmet ? [[ticket.slug, unmet.slug]] : [];
    });
    if (added.length === 0) break;
    for (const [slug, blocker] of added) blocked.set(slug, blocker);
  }
  const context = { bySlug, edges, unitOf, units, all, apart, blocked, takenNames };
  const grouped = components.map((members) => describe(members, context));
  const otherOwners = foreign.flatMap((ticket) => grouped.flatMap((unit) => {
    const via = unit.tickets.map((slug) => ({ slug, reasons: related(ticket, bySlug.get(slug)) })).find((entry) => entry.reasons.length > 0);
    return via ? [{ slug: ticket.slug, unit: unit.name, via: via.slug, reasons: via.reasons }] : [];
  }));
  return { units: grouped, blocked: [...blocked].map(([slug, blocker]) => ({ slug, blocker })), otherOwners };
}

/** Tickets of the unit that the PR title or body does not name. */
export function prNameProblems(unit, title, body) {
  return [
    ...missingTicketNames(title, unit?.tickets ?? []).map((slug) => `the PR title does not name ${slug}`),
    ...missingTicketNames(body, unit?.tickets ?? []).map((slug) => `the PR body does not name ${slug}`),
  ];
}

/** The board page's Units section: each unit, its writer, its writer's PR, every ticket in it, and whether it closed. */
export function renderUnits(units, writers) {
  const rows = Object.entries(units).map(([name, unit]) => {
    const row = writers[unit.writer] ?? {};
    return `| ${name} | ${unit.writer ?? ""} | ${row.pr ? `${row.repo ?? unit.repo ?? ""}#${row.pr}` : ""} | ${unit.tickets.join(", ")} | ${unit.closed ? `closed with ${unit.closed.pr}` : "open"} |`;
  });
  return rows.length === 0 ? ["- none"] : ["| Unit | Writer | PR | Tickets | State |", "|---|---|---|---|---|", ...rows];
}

/** Board status lines for open units whose writer has not recorded every other ticket as a session member, or where that cannot be read. */
export function unitMemberProblems(units, writers, readRecord) {
  return Object.entries(openUnits(units)).flatMap(([name, unit]) => {
    const unchecked = (why) => [`UNIT-MEMBERS-UNCHECKED ${name} ${unit.writer ?? "-"}: ${why}; check the writer's vibe-sessions.mjs show --worktree <wt> memberTickets on its machine`];
    const row = unit.writer ? writers[unit.writer] : undefined;
    if (!row) return unchecked(unit.writer ? `no board row for writer ${unit.writer}` : "the unit has no writer");
    if (row.where === "remote") return unchecked("remote writer; its session record is on the owning machine");
    if (!row.worktree) return unchecked("its writer row has no --worktree");
    let record;
    try { record = readRecord(row.worktree); }
    catch (error) { return unchecked(`cannot read its session record (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`); }
    if (!record) return unchecked("no vibe session record in its worktree yet");
    const anchor = record.liveTicket ?? record.ticket;
    const missing = unit.tickets.filter((slug) => slug !== anchor && !(record.memberTickets ?? []).includes(slug));
    return missing.length === 0 ? [] : [`UNIT-MEMBERS-UNRECORDED ${name} ${unit.writer}: ${missing.join(", ")}; the writer runs vibe-sessions.mjs touch --worktree <wt> --member-ticket <slug> for each, so handoff audits their criteria`];
  });
}

/** The operator lines for a grouping. */
export function groupLines({ units, blocked, otherOwners = [] }) {
  const lines = [];
  for (const unit of units) {
    if (unit.overlap.length > 1) lines.push(`OVERLAP ${unit.overlap.join(" ")}: two in-flight units are related; give one owner or a merge order`);
    for (const fold of unit.folds) lines.push(`FOLD ${fold.slug} into ${fold.unit} (${fold.writer ?? "no writer yet"}): ${fold.slug}~${fold.via} ${fold.reasons.join(", ")}`);
    if (unit.inFlight) {
      lines.push(`UNIT ${unit.name} ${unit.tickets.join(", ")}: in flight (${unit.writer ?? "no writer yet"})`);
      continue;
    }
    const notes = [...unit.keptApart.map((entry) => `kept apart: ${entry}`), ...unit.joinedThrough, ...unit.blockedNeighbours, ...unit.prdSplits]
      .map((entry) => `; ${entry}`).join("");
    lines.push(unit.tickets.length === 1
      ? `UNIT ${unit.name} ${unit.tickets[0]} alone: ${unit.apartReason}${notes}`
      : `UNIT ${unit.name} ${unit.tickets.join(", ")}: ${unit.joins.map((join) => `${join.a}~${join.b} ${join.reasons.join(", ")}`).join("; ")}${notes}`);
  }
  for (const entry of blocked) lines.push(`BLOCKED ${entry.slug} by ${entry.blocker}: kept separate until ${entry.blocker} merges`);
  for (const entry of otherOwners) {
    lines.push(`RELATED ${entry.slug} to unit ${entry.unit}: ${entry.slug}~${entry.via} ${entry.reasons.join(", ")}; it has another owner, so it stays out of the unit unless the operator decides otherwise`);
  }
  return lines;
}

/** Validates the candidate shapes; malformed input is refused, never guessed at. */
function validTickets(candidates) {
  if (!Array.isArray(candidates?.tickets)) throw new Error("candidates need a tickets array");
  for (const key of ["collisions", "apart"]) {
    const list = candidates[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((pair) => !slugPattern().test(pair?.a ?? "") || !slugPattern().test(pair?.b ?? "")))) {
      throw new Error(`${key} must be an array of {"a", "b"} ticket pairs`);
    }
  }
  const seen = new Set();
  return candidates.tickets.map((ticket) => {
    if (!slugPattern().test(ticket?.slug ?? "")) throw new Error(`candidate ${JSON.stringify(ticket?.slug)} is not a ticket slug`);
    const slug = ticket.slug;
    if (typeof ticket.repo !== "string" || !ticket.repo.includes("/")) throw new Error(`${slug} needs its repo as <owner>/<repo>`);
    if (seen.has(slug)) throw new Error(`${slug} is listed twice`);
    for (const key of ["files", "historyFiles", "surfaces"]) {
      if (ticket[key] !== undefined && (!Array.isArray(ticket[key]) || ticket[key].some((entry) => typeof entry !== "string" || !entry))) {
        throw new Error(`${slug} needs ${key} as an array of strings`);
      }
    }
    if (ticket.blockers !== undefined && (!Array.isArray(ticket.blockers) || ticket.blockers.some((blocker) => !slugPattern().test(blocker?.slug ?? "") || typeof blocker.met !== "boolean"))) {
      throw new Error(`${slug} needs blockers as an array of {"slug", "met": true|false}`);
    }
    if (ticket.prd !== undefined && !requirementsPattern().test(ticket.prd ?? "")) throw new Error(`${slug} names prd ${JSON.stringify(ticket.prd)}, not a requirements document key`);
    if (ticket.operatorAssigned !== undefined && typeof ticket.operatorAssigned !== "boolean") throw new Error(`${slug} needs operatorAssigned as true or false`);
    if (ticket.prd !== undefined && ticket.operatorAssigned === undefined) throw new Error(`${slug} names a prd, so it needs operatorAssigned: the PRD join counts only the operator's tickets`);
    seen.add(slug);
    return { files: [], historyFiles: [], surfaces: [], blockers: [], ...ticket };
  });
}

function pairKey(a, b) {
  return [a, b].sort().join(">");
}

/** Pairs the orchestrator kept apart; only a related pair, and only one related by history alone, may be. */
function apartPairs(candidates, all, collisions) {
  const bySlug = new Map(all.map((ticket) => [ticket.slug, ticket]));
  const pairs = new Map();
  for (const entry of candidates.apart ?? []) {
    const [a, b] = [bySlug.get(entry?.a), bySlug.get(entry?.b)];
    if (!a || !b || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error("an apart entry names two candidates and its reason");
    const reasons = a.repo === b.repo ? joinReasons(a, b, collisions) : [];
    if (reasons.length === 0) throw new Error(`${a.slug} and ${b.slug} are not related; there is nothing to keep apart`);
    if (!reasons.every((reason) => reason.endsWith("(history)"))) {
      throw new Error(`${a.slug} and ${b.slug} share ${reasons[0]}; only a pair related by history alone may be kept apart`);
    }
    pairs.set(pairKey(a.slug, b.slug), { a: a.slug, b: b.slug, reasons, reason: entry.reason.trim() });
  }
  return pairs;
}

/** Connected tickets; each in-flight unit's tickets are one component already. */
function connect(slugs, edges, units) {
  const parent = new Map(slugs.map((slug) => [slug, slug]));
  const find = (slug) => (parent.get(slug) === slug ? slug : find(parent.get(slug)));
  const join = (a, b) => { if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b)); };
  for (const edge of edges) join(edge.a, edge.b);
  for (const unit of Object.values(units)) for (const slug of unit.tickets ?? []) join(unit.tickets[0], slug);
  const groups = new Map();
  for (const slug of slugs) groups.set(find(slug), [...(groups.get(find(slug)) ?? []), slug]);
  return [...groups.values()];
}

/** The chain of joined tickets from one member to another, as `a~b~c`. */
function joinPath(from, to, joins) {
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const slug = queue.shift();
    if (slug === to) break;
    for (const edge of joins) {
      const next = edge.a === slug ? edge.b : edge.b === slug ? edge.a : null;
      if (next && !previous.has(next)) {
        previous.set(next, slug);
        queue.push(next);
      }
    }
  }
  const chain = [];
  for (let slug = to; slug; slug = previous.get(slug)) chain.unshift(slug);
  return chain.join("~");
}

function describe(members, { bySlug, edges, unitOf, units, all, apart, blocked, takenNames }) {
  const inside = new Set(members);
  const joins = edges.filter((edge) => inside.has(edge.a) && inside.has(edge.b));
  const overlap = [...new Set(members.map((slug) => unitOf.get(slug)).filter(Boolean))];
  const name = overlap[0] ?? freeUnitName(members[0], takenNames);
  const folds = overlap.length === 0 ? [] : members.filter((slug) => !unitOf.has(slug)).map((slug) => {
    const join = joins.find((edge) => (edge.a === slug && inside.has(edge.b)) || (edge.b === slug && inside.has(edge.a)));
    return { slug, unit: name, writer: units[name]?.writer, via: join.a === slug ? join.b : join.a, reasons: join.reasons };
  });
  const touching = [...apart.values()].filter((entry) => inside.has(entry.a) || inside.has(entry.b));
  const describeApart = (entry) => `${entry.a}~${entry.b} ${entry.reasons.join(", ")}: ${entry.reason}`;
  const keptApart = touching.filter((entry) => !(inside.has(entry.a) && inside.has(entry.b))).map(describeApart);
  const joinedThrough = touching.filter((entry) => inside.has(entry.a) && inside.has(entry.b))
    .map((entry) => `asked to keep ${entry.a} and ${entry.b} apart (${entry.reason}), but they are joined through ${joinPath(entry.a, entry.b, joins)}`);
  const ticket = bySlug.get(members[0]);
  const others = all.filter((other) => !inside.has(other.slug));
  const relatedBlocked = edges.filter((edge) => (inside.has(edge.a) && blocked.has(edge.b)) || (inside.has(edge.b) && blocked.has(edge.a)))
    .map((edge) => (inside.has(edge.a) ? edge.b : edge.a));
  const blockedNeighbours = [...new Set(relatedBlocked)].map((slug) => `related to ${slug}, which is BLOCKED by ${blocked.get(slug)}`);
  const prds = new Set(members.map((slug) => bySlug.get(slug)).filter((member) => member.prd && member.operatorAssigned === true).map((member) => member.prd));
  const prdSplits = [...prds].flatMap((prd) => {
    const byRepo = new Map();
    for (const other of others.filter((entry) => entry.prd === prd && entry.operatorAssigned === true && entry.repo !== ticket.repo)) {
      byRepo.set(other.repo, [...(byRepo.get(other.repo) ?? []), other.slug]);
    }
    return [...byRepo].map(([repo, tickets]) => `${prd} also has ${tickets.join(", ")} in ${repo}, a unit of its own: a PR cannot span repositories`);
  });
  const elsewhere = others.filter((other) => other.repo !== ticket.repo).map((other) => other.slug);
  const apartPartners = touching.flatMap((entry) => [entry.a, entry.b]);
  const unrelated = others.filter((other) => other.repo === ticket.repo && !relatedBlocked.includes(other.slug) && !apartPartners.includes(other.slug)).map((other) => other.slug);
  const apartReason = [
    ...(elsewhere.length ? [`different repository from ${elsewhere.join(", ")}`] : []),
    ...(unrelated.length ? [`no shared file, screen entry, collision or PRD with ${unrelated.join(", ")}`] : []),
  ].join("; ") || (blockedNeighbours.length || keptApart.length ? "its only related tickets are kept separate" : "no other candidates");
  return { name, writer: units[name]?.writer, tickets: members, joins, folds, overlap, inFlight: overlap.length > 0, keptApart, joinedThrough, blockedNeighbours, apartReason, prdSplits };
}

function main(argv) {
  const [action, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    candidates: { type: "string" }, board: { type: "string" }, unit: { type: "string" }, title: { type: "string" }, "body-file": { type: "string" },
  } });
  if (action === "group" && values.candidates) {
    const board = values.board ? readBoard(values.board) : { units: {}, names: [] };
    const grouping = groupTickets(JSON.parse(readFileSync(values.candidates, "utf8")), board.units, board.names);
    for (const line of groupLines(grouping)) process.stdout.write(`${line}\n`);
    return 0;
  }
  if (action === "pr-check" && values.board && values.unit && values.title !== undefined && values["body-file"]) {
    const unit = boardUnits(values.board)[values.unit];
    if (!unit) throw new Error(`no unit ${values.unit} on the board; record it with board.mjs <orchDir> unit ${values.unit} --tickets <a,b>`);
    const problems = prNameProblems(unit, values.title, readFileSync(values["body-file"], "utf8"));
    for (const problem of problems) process.stdout.write(`${problem}\n`);
    process.stdout.write(problems.length === 0 ? `pr-check: ${values.unit} names ${unit.tickets.join(", ")}\n` : `pr-check: ${problems.length} missing\n`);
    return problems.length === 0 ? 0 : 1;
  }
  throw new Error("Usage: ticket-units.mjs group --candidates <file> [--board <orchDir>] | pr-check --board <orchDir> --unit <name> --title <title> --body-file <file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
