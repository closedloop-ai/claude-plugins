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
// candidates.json, gathered with cl-find-related-tickets and the closedloop-graph
// tools (references/ticket-units.md says which tool fills which field):
//   {"tickets": [{"slug", "repo": "<owner/repo>",
//      "files": [<repo-relative paths the ticket is expected to change>],
//      "historyFiles": [<paths only past changes touched (blast_radius_tickets)>],
//      "surfaces": [<screen map ids>],
//      "blockers": [{"slug", "met": <true once merged or DONE>}]}],
//    "collisions": [{"a", "b", "reason"}],
//    "apart": [{"a", "b", "reason"}]}
// List the ticket you are about to start first: a new unit is named after its
// first listed ticket.
//
// Two tickets in the same repository join on a shared expected file, a shared
// screen map entry or a collision pair. A pair that shares only history files
// joins too, labelled `(history)`; the orchestrator may keep that pair apart
// with an `apart` entry and its one-line reason. `apart` on any other pair is
// refused. Tickets in different repositories never join. A ticket with an
// unmet blocker outside its unit stays separate and is printed BLOCKED; a
// blocker inside the unit is built in order on the same branch (cl-sweep
// references/feature-units.md, `scheduled_in_unit`).
//
// With `--board`, the units already on the board (board.mjs unit) are in
// flight: their tickets stay together, and a ticket that joins one prints
// FOLD into that unit and its writer instead of a new unit.
//
// Prints one line per unit, which is the operator's line:
//   UNIT <name> <a, b>: <a>~<b> <reason>; ...
//   UNIT <name> <a> alone: <why it is kept apart>
//   UNIT <name> <a, b>: in flight (<writer>)
//   FOLD <ticket> into <unit> (<writer>): <ticket>~<member> <reason>
//   BLOCKED <ticket> by <blocker>: kept separate until it merges
//   OVERLAP <unit> <unit>: two in-flight units are related; give one owner or a merge order
// Exits 0. Malformed input exits 2.
//
// `pr-check` exits 1 until the PR title and body name every ticket of the unit.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";

const SLUG = /^[A-Z]+-\d+$/;

/** The units recorded on a program's board, `{}` when it has none. */
export function boardUnits(orchDir) {
  const file = path.join(resolveWorkDir(orchDir).dir, "board.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")).units ?? {};
}

/** Why two tickets are related, strongest evidence first, or an empty list. */
export function joinReasons(a, b, collisions = []) {
  const reasons = [];
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
export function groupTickets(candidates, units = {}) {
  const tickets = validTickets(candidates);
  const bySlug = new Map(tickets.map((ticket) => [ticket.slug, ticket]));
  const unitOf = new Map();
  for (const [name, unit] of Object.entries(units)) {
    for (const slug of unit.tickets ?? []) {
      unitOf.set(slug, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, repo: unit.repo ?? null, files: [], historyFiles: [], surfaces: [], blockers: [] });
    }
  }
  const all = [...bySlug.values()];
  const apart = apartPairs(candidates, all, candidates.collisions ?? []);
  const edges = [];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const [a, b] = [all[i], all[j]];
      if (a.repo !== b.repo || apart.has(pairKey(a.slug, b.slug))) continue;
      const reasons = joinReasons(a, b, candidates.collisions ?? []);
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
  return { units: components.map((members) => describe(members, { bySlug, edges, unitOf, units, all, apart, candidates })), blocked: [...blocked].map(([slug, blocker]) => ({ slug, blocker })) };
}

/** Tickets of the unit that the PR title or body does not name. */
export function prNameProblems(unit, title, body) {
  const names = (text, slug) => new RegExp(`(^|[^A-Za-z0-9-])${slug}(?![0-9])`).test(text);
  return (unit?.tickets ?? []).flatMap((slug) => [
    ...(names(title, slug) ? [] : [`the PR title does not name ${slug}`]),
    ...(names(body, slug) ? [] : [`the PR body does not name ${slug}`]),
  ]);
}

/** The board page's Units section: each unit, its writer, its writer's PR and every ticket in it. */
export function renderUnits(units, writers) {
  const rows = Object.entries(units).map(([name, unit]) => {
    const row = writers[unit.writer] ?? {};
    return `| ${name} | ${unit.writer ?? ""} | ${row.pr ? `${row.repo ?? unit.repo ?? ""}#${row.pr}` : ""} | ${unit.tickets.join(", ")} |`;
  });
  return rows.length === 0 ? ["- none"] : ["| Unit | Writer | PR | Tickets |", "|---|---|---|---|", ...rows];
}

/** The operator lines for a grouping. */
export function groupLines({ units, blocked }) {
  const lines = [];
  for (const unit of units) {
    if (unit.overlap.length > 1) lines.push(`OVERLAP ${unit.overlap.join(" ")}: two in-flight units are related; give one owner or a merge order`);
    for (const fold of unit.folds) lines.push(`FOLD ${fold.slug} into ${fold.unit} (${fold.writer ?? "no writer yet"}): ${fold.slug}~${fold.via} ${fold.reasons.join(", ")}`);
    if (unit.inFlight) {
      lines.push(`UNIT ${unit.name} ${unit.tickets.join(", ")}: in flight (${unit.writer ?? "no writer yet"})`);
      continue;
    }
    lines.push(unit.tickets.length === 1
      ? `UNIT ${unit.name} ${unit.tickets[0]} alone: ${unit.apartReason}`
      : `UNIT ${unit.name} ${unit.tickets.join(", ")}: ${unit.joins.map((join) => `${join.a}~${join.b} ${join.reasons.join(", ")}`).join("; ")}${unit.keptApart.length ? `; kept apart: ${unit.keptApart.join("; ")}` : ""}`);
  }
  for (const entry of blocked) lines.push(`BLOCKED ${entry.slug} by ${entry.blocker}: kept separate until ${entry.blocker} merges`);
  return lines;
}

function validTickets(candidates) {
  if (!Array.isArray(candidates?.tickets)) throw new Error("candidates need a tickets array");
  const seen = new Set();
  return candidates.tickets.map((ticket) => {
    if (!SLUG.test(ticket?.slug ?? "")) throw new Error(`candidate ${JSON.stringify(ticket?.slug)} is not a ticket slug`);
    if (typeof ticket.repo !== "string" || !ticket.repo.includes("/")) throw new Error(`${ticket.slug} needs its repo as <owner>/<repo>`);
    if (seen.has(ticket.slug)) throw new Error(`${ticket.slug} is listed twice`);
    seen.add(ticket.slug);
    return { files: [], historyFiles: [], surfaces: [], blockers: [], ...ticket };
  });
}

function pairKey(a, b) {
  return [a, b].sort().join(">");
}

/** Pairs the orchestrator kept apart; only a history-only pair may be. */
function apartPairs(candidates, all, collisions) {
  const bySlug = new Map(all.map((ticket) => [ticket.slug, ticket]));
  const pairs = new Map();
  for (const entry of candidates.apart ?? []) {
    const [a, b] = [bySlug.get(entry?.a), bySlug.get(entry?.b)];
    if (!a || !b || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error("an apart entry names two candidates and its reason");
    const reasons = joinReasons(a, b, collisions);
    if (!reasons.every((reason) => reason.endsWith("(history)"))) {
      throw new Error(`${a.slug} and ${b.slug} share ${reasons[0]}; only a pair related by history alone may be kept apart`);
    }
    pairs.set(pairKey(a.slug, b.slug), { reasons, reason: entry.reason.trim() });
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

function describe(members, { bySlug, edges, unitOf, units, all, apart }) {
  const inside = new Set(members);
  const joins = edges.filter((edge) => inside.has(edge.a) && inside.has(edge.b));
  const overlap = [...new Set(members.map((slug) => unitOf.get(slug)).filter(Boolean))];
  const name = overlap[0] ?? members[0];
  const folds = overlap.length === 0 ? [] : members.filter((slug) => !unitOf.has(slug)).map((slug) => {
    const join = joins.find((edge) => (edge.a === slug && inside.has(edge.b)) || (edge.b === slug && inside.has(edge.a)));
    return { slug, unit: name, writer: units[name]?.writer, via: join.a === slug ? join.b : join.a, reasons: join.reasons };
  });
  const keptApart = [...apart].filter(([key]) => key.split(">").some((slug) => inside.has(slug)))
    .map(([key, entry]) => `${key.replace(">", "~")} ${entry.reasons.join(", ")}: ${entry.reason}`);
  const ticket = bySlug.get(members[0]);
  const others = all.filter((other) => !inside.has(other.slug));
  const elsewhere = others.filter((other) => other.repo !== ticket.repo).map((other) => other.slug);
  const unrelated = others.filter((other) => other.repo === ticket.repo).map((other) => other.slug);
  const apartReason = [
    ...(elsewhere.length ? [`different repository from ${elsewhere.join(", ")}`] : []),
    ...(unrelated.length ? [`no shared file, screen entry or collision with ${unrelated.join(", ")}`] : []),
    ...keptApart.map((entry) => `kept apart: ${entry}`),
  ].join("; ") || "no other candidates";
  return { name, writer: units[name]?.writer, tickets: members, joins, folds, overlap, inFlight: overlap.length > 0, keptApart, apartReason };
}

function main(argv) {
  const [action, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    candidates: { type: "string" }, board: { type: "string" }, unit: { type: "string" }, title: { type: "string" }, "body-file": { type: "string" },
  } });
  if (action === "group" && values.candidates) {
    const grouping = groupTickets(JSON.parse(readFileSync(values.candidates, "utf8")), values.board ? boardUnits(values.board) : {});
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
