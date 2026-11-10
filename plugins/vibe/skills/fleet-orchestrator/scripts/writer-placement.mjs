// Where each ticket's writer runs, cloud or local, recorded on the fleet board
// from the one placement check (decideCloudPlacement, vibe-core's
// lib/fleet-orchestrator/scripts/cloud-placement.mjs) and required before a
// board writer takes the ticket. An orchestrator once started four local
// writers with no placement computed, one of them for a code-only ticket that
// met every cloud condition, while local test suites overloaded both laptops.
//
// `placement <ticket> --evidence <file>` records the check's decision from the
// file ({codeOnly, needsRunningApp, localEvidence[]}, or a cloud-worker request
// carrying it as `placement`); recording it again replaces it and drops an
// earlier keep-local reason. `placement <ticket> --keep-local <reason>` records
// the operator's reason to keep a cloud-placed ticket local.

import { readFileSync } from "node:fs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { decideCloudPlacement } = await vibeCore("lib/fleet-orchestrator/scripts/cloud-placement.mjs");

const TICKET = /^[A-Z]+-\d+$/;
const Placement = Object.freeze({ Cloud: "cloud", Local: "local" });

/** The placement evidence a file holds: the object itself, or a cloud-worker request's `placement`. */
export function readPlacementEvidence(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`placement evidence ${file} is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parsed?.placement && typeof parsed.placement === "object" ? parsed.placement : parsed;
}

/** Records the check's decision for `ticket` from `evidence`, or the operator's `keepLocal` reason against a cloud decision. */
export function recordPlacement(placements, ticket, { evidence, keepLocal }, at) {
  if (!TICKET.test(ticket ?? "")) throw new Error("placement needs a ticket slug such as ISS-123.");
  if (evidence === undefined && keepLocal === undefined) {
    throw new Error("placement needs --evidence <file> (the check runs on it) or --keep-local <the operator's reason>.");
  }
  const reason = keepLocal?.trim();
  if (keepLocal !== undefined && !reason) throw new Error("--keep-local needs the operator's reason to keep the ticket local.");
  const decision = evidence === undefined ? placements[ticket] : { ...decideCloudPlacement(evidence), evidence, at };
  if (!decision) throw new Error(`no placement decision for ${ticket} yet; record it with --evidence <file> first.`);
  if (reason && decision.placement !== Placement.Cloud) {
    throw new Error(`${ticket} is placed local (${decision.reason}); a keep-local reason is only for a cloud decision.`);
  }
  const { keepLocal: _earlier, ...fresh } = decision;
  placements[ticket] = reason ? { ...fresh, keepLocal: { reason, at } } : fresh;
  return placements[ticket];
}

/** The tickets a writer delivers: those on its row and those of every open unit it writes. */
export function writerTickets(board, name, row = board.writers[name] ?? {}) {
  const fromUnits = Object.values(board.units ?? {}).filter((unit) => !unit.closed && unit.writer === name).flatMap((unit) => unit.tickets);
  return [...new Set([...(row.tickets ?? []), ...fromUnits])];
}

/** Why a board writer cannot take `tickets`, or null: each needs a recorded decision, and a cloud one the operator's keep-local reason. */
export function writerPlacementProblem(placements, writer, tickets) {
  if (tickets.length === 0) {
    return `writer ${writer} names no ticket: pass --tickets <slug,slug> (or record its unit with --writer ${writer}) so its placement is checked.`;
  }
  const bad = tickets.filter((ticket) => !TICKET.test(ticket));
  if (bad.length > 0) return `--tickets takes ticket slugs such as ISS-123, got ${bad.join(", ")}.`;
  const problems = tickets.flatMap((ticket) => {
    const decision = placements[ticket];
    if (!decision) {
      return [`no placement decision for ${ticket}: run board.mjs <orchDir> placement ${ticket} --evidence <file> before starting writer ${writer}`];
    }
    if (decision.placement === Placement.Cloud && !decision.keepLocal) {
      return [`${ticket} is placed cloud (${decision.reason}): dispatch it with ../vibe/scripts/cloud-worker.mjs, or record the operator's reason with board.mjs <orchDir> placement ${ticket} --keep-local <reason>`];
    }
    return [];
  });
  return problems.length > 0 ? `${problems.join("; ")}.` : null;
}

/** `PLACEMENT <writer> <ticket> <decision>: <reason>` for each ticket of each board writer. */
export function placementLines(board) {
  return Object.entries(board.writers).flatMap(([name, row]) => {
    const tickets = writerTickets(board, name, row);
    if (tickets.length === 0) return [`PLACEMENT ${name} - none: no ticket recorded for this writer`];
    return tickets.map((ticket) => `PLACEMENT ${name} ${ticket} ${describe(board.placements?.[ticket])}`);
  });
}

/** The board page's placement section: every recorded decision with its reason. */
export function renderPlacements(placements) {
  const rows = Object.entries(placements ?? {}).map(([ticket, decision]) => `- ${ticket} ${describe(decision)}`);
  return rows.length > 0 ? rows : ["- none"];
}

function describe(decision) {
  if (!decision) return "none: no placement decision recorded";
  if (decision.keepLocal) return `cloud, kept local: ${decision.keepLocal.reason} (check: ${decision.reason})`;
  return `${decision.placement}: ${decision.reason}`;
}
