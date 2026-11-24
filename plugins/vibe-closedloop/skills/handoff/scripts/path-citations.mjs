import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { currentTrackerBody } from "./ruling-evidence.mjs";
import { ticketCriteria, unreadCriteriaProblems, visibleMarkdownLines } from "./criteria-list.mjs";
import { sessionPlanEvidencePaths } from "../../vibe/scripts/session-plan.mjs";
import { CARD_FILE, cardProblems } from "../../vibe/scripts/spec-card.mjs";
import { evidenceFingerprint } from "../../../lib/handoff/scripts/handoff-evidence.mjs";
import { absoluteGitDir, sessionLiveTicket } from "../../../lib/vibe/scripts/session-record.mjs";

/** A disclosure is possible only for a literal repository-relative file named as a complete token. */
function namesFile(text, file) {
  if (typeof file !== "string" || !file || file.trim() !== file || path.posix.isAbsolute(file)
      || /[\\`*?{}<>\x00-\x1f]/u.test(file) || file.split("/").some(part => !part || part === "." || part === "..")) return false;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?:^|[\\s(`'\"“])" + escaped + "(?=$|[\\s)`'\"”,;:]|[.!](?=\\s|$))", "u").test(text);
}

/** Accept numbered ticket criteria as well as the normal tracker checklist, without inferring files from commands. */
function citedCriteria(body) {
  // Join literal prose continuations only while still inside the same list item.
  const lines = [];
  let itemIndent = -1;
  for (const line of visibleMarkdownLines(body)) {
    const item = /^(\s*)(?:[-*] \[[ xX]\]|(?:AC[- ]?)?\d+[.):])\s+/u.exec(line);
    const continuation = itemIndent >= 0 && line.trim() && line.search(/\S/u) > itemIndent && !/^\s*(?:[-*+#>]|\d+[.)])\s/u.test(line);
    if (!item && continuation) lines[lines.length - 1] += " " + line.trim();
    else {
      lines.push(line);
      itemIndent = item ? item[1].length : -1;
    }
  }
  const text = lines.join("\n");
  const rows = ticketCriteria(text);
  if (unreadCriteriaProblems(text).length) return [];
  let inCriteria = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) inCriteria = /^#{1,6}\s+(?:Scope and )?Acceptance criteria\s*:?\s*$/i.test(line);
    if (inCriteria) {
      const numbered = /^ {0,3}(?:AC[- ]?)?(\d+)[.):]\s+(.+)$/.exec(line);
      if (numbered) rows.push({ id: "AC-" + numbered[1], text: numbered[2] });
    }
  }
  return rows;
}

/** Resolve the writer's path citations against the ticket worker's latest complete read of the bound ticket. */
export function pathCitationAuthority(worktree, record, { requested, primaryBody } = {}) {
  const empty = { citations: [], evidence: [] };
  const ticket = sessionLiveTicket(record ?? {});
  if (!ticket || record.status !== "active") return empty;
  try {
    const cardPath = path.join(absoluteGitDir(worktree), CARD_FILE);
    const paths = sessionPlanEvidencePaths(worktree);
    const evidence = [];
    const read = file => {
      const fingerprint = evidenceFingerprint(file);
      const bytes = readFileSync(file);
      if (createHash("sha256").update(bytes).digest("hex") !== fingerprint.sha256) throw new Error("Citation evidence changed");
      evidence.push(fingerprint);
      return bytes.toString("utf8");
    };
    const card = existsSync(cardPath) ? JSON.parse(read(cardPath)) : null;
    const claims = [];
    if (card?.stage === "locked" && card.plan?.justifications?.length && !cardProblems(card, "locked").problems.length) {
      for (const row of card.plan.justifications) {
        const item = card.criteria.find(entry => entry.id === row.cites);
        if (item && item.source.split(" ")[0] === ticket) claims.push({ ...row, text: item.text, source: item.source });
      }
    }
    for (const row of record.pathCitations ?? []) {
      if (row.ticket === ticket) claims.push({ ...row, source: "session" });
    }
    if (requested) claims.push({ ...requested, source: "request" });
    if (!claims.length) return empty;
    const doc = JSON.parse(read(paths.liveTicketDocument));
    const body = read(paths.liveTicket);
    if (currentTrackerBody(doc, ticket) !== body
        || (primaryBody !== undefined && primaryBody !== body)) return empty;
    const criteria = citedCriteria(body);
    const citations = [];
    for (const { path: file, cites, text, source } of claims) {
      const matching = criteria.filter(row => row.id === cites);
      if (matching.length !== 1 || (source !== "request" && matching[0].text !== text) || !namesFile(matching[0].text, file)) continue;
      if (!["session", "request", ticket].includes(source)) {
        const origin = /^(\S+) v([1-9]\d*)$/.exec(source);
        if (origin?.[1] !== ticket || Number(origin[2]) > doc.latestVersion) continue;
      }
      citations.push({ path: file, criterion: cites, ticket, version: doc.latestVersion, text: matching[0].text, source,
        disclosure: "Path authorization: `" + file + "` (" + ticket + " " + cites + ")." });
    }
    return citations.length ? { citations, evidence } : empty;
  } catch {
    // Missing, unreadable or partial private evidence grants no paths.
    return empty;
  }
}
