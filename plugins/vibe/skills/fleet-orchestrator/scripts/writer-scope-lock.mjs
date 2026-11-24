import { exactOperatorRuling } from "../../handoff/scripts/rulings-check.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { findOpenLessonsPrs } from "./lessons-pr.mjs";

/** Bind the exact operator words to one of the writer's tickets and its current PR identity. */
export function writerScopeLock({ row, tickets, quote, source, rulings, at }) {
  const ticket = tickets.find((item) => exactOperatorRuling(rulings, { ticket: item, quote, source }));
  if (!ticket) throw new Error("--scope-locked requires exact quoted operator words and --ruling-source matching the writer's work in rulings.md.");
  if (row.scopeLock) {
    const locked = row.scopeLock;
    if (locked.quote === quote && locked.source === source && tickets.includes(locked.ticket)) return locked;
    throw new Error("writer already has a different scope lock");
  }
  return { quote, source, ticket, ...(row.repo && { repo: row.repo }), ...(row.pr && { pr: row.pr }), at };
}

/** Resolve the prevention ticket already named by the program handover, without a second pointer. */
function handoverPreventionTicket(orchDir) {
  try {
    const handover = readFileSync(path.join(orchDir, "handover.md"), "utf8");
    const tickets = new Set();
    for (const pattern of [
      /\bremaining items move to\s+([A-Z][A-Z0-9]*-\d+)\b/gi,
      /\bnext(?:\s+[\w-]+){0,3}\s+PR:\s*([A-Z][A-Z0-9]*-\d+)\b/gi,
      /\b(?:lessons|prevention) ticket:\s*([A-Z][A-Z0-9]*-\d+)\b/gi,
    ]) {
      for (const match of handover.matchAll(pattern)) tickets.add(match[1].toUpperCase());
    }
    return tickets.size === 1 ? [...tickets][0] : null;
  } catch {
    return null;
  }
}

/** Name only a unique result from the existing lessons lookup for the recorded repository. */
function lessonsDestination(orchDir, repo) {
  const fallback = (reason) => {
    const ticket = handoverPreventionTicket(orchDir);
    return ticket
      ? `${reason}; route follow-up scope to prevention ticket ${ticket} named by handover.md`
      : `${reason}. The canonical lessons ticket fallback is not configured.`;
  };
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) return fallback("lessons PR lookup unavailable without a recorded repository");
    const open = findOpenLessonsPrs(repo);
    if (open.length === 0) return fallback("no open lessons PR");
    if (open.length > 1) return fallback("multiple open lessons PRs");
    const { number, url } = open[0];
    const target = new URL(url);
    if (!Number.isSafeInteger(number) || number <= 0 || target.protocol !== "https:"
      || target.pathname.toLowerCase() !== `/${repo.toLowerCase()}/pull/${number}`) {
      return fallback("lessons PR lookup returned an invalid destination");
    }
    return `route follow-up scope to the open lessons PR ${url}`;
  } catch {
    return fallback("lessons PR lookup unavailable");
  }
}

/** Refuse the entire delivery before any reference or worktree inspection if a recipient is locked. */
export function assertScopeDeliveryAllowed(orchDir, writers, recipients) {
  const locked = recipients.filter((name) => writers[name]?.scopeLock);
  if (locked.length === 0) return;
  const repositories = new Set(locked.map((name) => writers[name].scopeLock.repo ?? writers[name].repo));
  const destinations = [...repositories].map((repo) => lessonsDestination(orchDir, repo));
  throw new Error(`scope delivery refused for ${locked.join(", ")}: ${destinations.join(" | ")}`);
}
