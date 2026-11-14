// A ticket's acceptance criteria, read from its body: the template's
// `- Acceptance criteria:` checklist, or the checkboxes under an `Acceptance
// criteria` heading. criteria-audit.mjs and unit-review.mjs both read them;
// criteria-audit.mjs re-exports these for its other importers. A checkbox
// outside those sections that still reads as a criterion (its heading or list
// label names criteria, or its text leads with a criterion id) is reported,
// never dropped silently (ISS-14136).

import { readFileSync } from "node:fs";

const CRITERIA_START = /^\s*-\s*Acceptance criteria:\s*$/;
const CRITERIA_HEADING = /^(#{1,6})\s+Acceptance criteria\b/i;
const HEADING = /^(#{1,6})\s/;
const CHECKBOX = /^\s+-\s*\[([ xX])\]\s*(\S.*)$/;
const TOP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(\S.*)$/;
const LIST_LABEL = /^\s*[-*]\s+([^[\s].*?):\s*$/;
const NAMES_CRITERIA = /\bcriteri(?:a|on)\b/i;
const LEADS_WITH_ID = /^AC-\d+\b/;

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
  return checkboxes(ticket).filter((box) => box.read).map((box, index) => ({ id: `AC-${index + 1}`, text: box.text, checked: box.checked }));
}

/**
 * One problem per heading or list label, outside the sections read above, whose checkboxes read as
 * acceptance criteria: the heading or label names criteria, or a checkbox leads with a criterion id.
 */
export function unreadCriteriaProblems(ticket) {
  const under = checkboxes(ticket).filter((box) => !box.read && (NAMES_CRITERIA.test(box.under) || LEADS_WITH_ID.test(box.text))).map((box) => box.under);
  return [...new Set(under)].map((name) => `the ticket has checkboxes under "${name}" that read as acceptance criteria, outside the section this audit reads; move them under the "Acceptance criteria" heading or the "- Acceptance criteria:" list`);
}

/** Every checkbox of the ticket: whether the criteria sections hold it, and the heading or list label it sits under. */
function checkboxes(ticket) {
  const found = [];
  let inList = false;
  let headingLevel = 0;
  let headingName = "the top of the ticket";
  let label = null;
  for (const line of ticket.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      inList = false;
      headingLevel = CRITERIA_HEADING.test(line) ? heading[1].length : headingLevel && heading[1].length > headingLevel ? headingLevel : 0;
      headingName = line.slice(heading[1].length).trim();
      label = null;
      continue;
    }
    if (CRITERIA_START.test(line)) {
      inList = true;
      label = null;
      continue;
    }
    const item = inList ? CHECKBOX.exec(line) : headingLevel ? TOP_CHECKBOX.exec(line) : null;
    if (item) {
      found.push({ read: true, text: item[2], checked: item[1] !== " " });
      continue;
    }
    if (inList && line.trim() !== "" && !/^\s{4,}\S/.test(line)) inList = false;
    const stray = TOP_CHECKBOX.exec(line);
    if (stray) found.push({ read: false, text: stray[2], checked: stray[1] !== " ", under: label ?? headingName });
    else if (LIST_LABEL.test(line)) label = LIST_LABEL.exec(line)[1];
    else if (/^\S/.test(line)) label = null;
  }
  return found;
}

/** Each member ticket's criteria as <slug>:AC-n, and the recorded members that have no body. */
export function memberCriteria(members, recorded = []) {
  const problems = [];
  const criteria = [];
  const given = new Set();
  for (const entry of members) {
    const at = entry.indexOf("=");
    const slug = entry.slice(0, at);
    if (at <= 0 || !/^[A-Z]+-\d+$/.test(slug)) throw new Error(`--member needs <slug>=<ticket body file>, got ${entry}`);
    given.add(slug);
    const body = readFileSync(entry.slice(at + 1), "utf8");
    const own = ticketCriteria(body).map(({ id, text }) => ({ id: `${slug}:${id}`, text }));
    if (own.length === 0) problems.push(`member ${slug} has no acceptance criteria checklist`);
    problems.push(...unreadCriteriaProblems(body).map((problem) => `member ${slug}: ${problem}`));
    criteria.push(...own);
  }
  for (const slug of recorded) if (!given.has(slug)) problems.push(`member ${slug} is recorded on the session but has no --member body; its criteria are not audited`);
  return { criteria, problems };
}
