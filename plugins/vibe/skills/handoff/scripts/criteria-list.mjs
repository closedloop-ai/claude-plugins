// A ticket's acceptance criteria, read from its body: the template's
// `- Acceptance criteria:` checklist, or the checkboxes under an `Acceptance
// criteria` heading. criteria-audit.mjs and unit-review.mjs both read them;
// criteria-audit.mjs re-exports these for its other importers.

import { readFileSync } from "node:fs";
import { trackerKey } from "../../vibe/scripts/tracker-key.mjs";

const CRITERIA_START = /^\s*-\s*Acceptance criteria:\s*$/;
const CRITERIA_HEADING = /^(#{1,6})\s+Acceptance criteria\b/i;
const HEADING = /^(#{1,6})\s/;
const CHECKBOX = /^\s+-\s*\[([ xX])\]\s*(\S.*)$/;
const TOP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(\S.*)$/;

/** The ticket's acceptance criteria as AC-n ids with their text. */
export function ticketCriteria(ticket) {
  return criteriaStates(ticket).map(({ id, text }) => ({ id, text }));
}

/**
 * The acceptance criteria with whether each box is checked: the template's
 * `- Acceptance criteria:` list, or the checkboxes under an `Acceptance
 * criteria` heading up to the next heading of the same or a higher level.
 */
export function criteriaStates(ticket) {
  const criteria = [];
  const push = (match) => criteria.push({ id: `AC-${criteria.length + 1}`, text: match[2], checked: match[1] !== " " });
  let inList = false;
  let headingLevel = 0;
  for (const line of ticket.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      inList = false;
      headingLevel = CRITERIA_HEADING.test(line) ? heading[1].length : headingLevel && heading[1].length > headingLevel ? headingLevel : 0;
      continue;
    }
    if (CRITERIA_START.test(line)) {
      inList = true;
      continue;
    }
    const item = inList ? CHECKBOX.exec(line) : headingLevel ? TOP_CHECKBOX.exec(line) : null;
    if (item) {
      push(item);
    } else if (inList && line.trim() !== "" && !/^\s{4,}\S/.test(line)) {
      inList = false;
    }
  }
  return criteria;
}

/** Each member ticket's criteria as <slug>:AC-n, and the recorded members that have no body. */
export function memberCriteria(members, recorded = []) {
  const problems = [];
  const criteria = [];
  const given = new Set();
  for (const entry of members) {
    const at = entry.indexOf("=");
    const slug = entry.slice(0, at);
    if (at <= 0 || !new RegExp(`^${trackerKey()}$`).test(slug)) throw new Error(`--member needs <slug>=<ticket body file>, got ${entry}`);
    given.add(slug);
    const own = ticketCriteria(readFileSync(entry.slice(at + 1), "utf8")).map(({ id, text }) => ({ id: `${slug}:${id}`, text }));
    if (own.length === 0) problems.push(`member ${slug} has no acceptance criteria checklist`);
    criteria.push(...own);
  }
  for (const slug of recorded) if (!given.has(slug)) problems.push(`member ${slug} is recorded on the session but has no --member body; its criteria are not audited`);
  return { criteria, problems };
}
