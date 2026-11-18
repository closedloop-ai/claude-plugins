// A ticket's acceptance criteria, read from its body: the template's
// `- Acceptance criteria:` checklist, or the checkboxes under an `Acceptance
// criteria` heading. criteria-audit.mjs and unit-review.mjs both read them;
// criteria-audit.mjs re-exports these for its other importers. A checkbox that
// reads as a criterion but that the reader does not read is reported, never
// dropped silently: one in another list form (`+`, `1.`, `1)`) or another
// position (under a sub-heading, a nested criteria heading or a list label)
// inside a criteria section of either form, one at list level right after the
// template list, and one elsewhere whose heading or list label names criteria
// or whose text leads with a criterion id. What is read, and so every id, is
// unchanged.

import { readFileSync } from "node:fs";
import { trackerKey } from "../../vibe/scripts/tracker-key.mjs";

const CRITERIA_START = /^\s*-\s*Acceptance criteria:\s*$/;
const CRITERIA_HEADING = /^(#{1,6})\s+Acceptance criteria\b/i;
const HEADING = /^(#{1,6})\s/;
const CHECKBOX = /^\s+-\s*\[([ xX])\]\s*(\S.*)$/;
// The boxes read under an Acceptance criteria heading: - and * only, so the criterion ids do not move.
const TOP_CHECKBOX = /^\s*[-*]\s*\[([ xX])\]\s*(\S.*)$/;
// Any list marker: -, *, + or an ordered 1. or 1). A box in a form the sections do not read is reported, never dropped.
const ANY_CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(\S.*)$/;
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
 * One problem per section, heading or list label holding checkboxes that read as acceptance criteria but that the
 * reader does not read: a box inside a criteria section in a form or position it does not read (filed under that
 * section), or a box elsewhere whose heading or label names criteria or whose text leads with a criterion id.
 */
export function unreadCriteriaProblems(ticket) {
  const under = checkboxStates(ticket).filter((box) => box.reportedUnder !== null).map((box) => box.reportedUnder);
  return [...new Set(under)].map((name) => `the ticket has checkboxes under "${name}" that read as acceptance criteria in a form or place this audit does not read; write each as a "- [ ]" box directly in the "Acceptance criteria" section or the "- Acceptance criteria:" list`);
}

/**
 * Every checkbox-shaped line of the ticket, in order: its text, whether it is checked, whether the reader reads it,
 * and the name it is reported under when it is not read but reads as a criterion (null otherwise). Every line inside
 * a criteria section is either read or reported.
 */
export function checkboxStates(ticket) {
  return checkboxes(ticket).map(({ text, checked, read, under }) => ({
    text, checked, read, reportedUnder: !read && (NAMES_CRITERIA.test(under) || LEADS_WITH_ID.test(text)) ? under : null,
  }));
}

/**
 * Every checkbox of the ticket: whether the criteria sections hold it, and the name it is filed under. Reading
 * (`inList`, `headingLevel`) is unchanged from before the report rule, so ids do not move. Reporting uses one
 * criteria section rule for both forms, closing only where that is unambiguous: a criteria heading's section stays
 * open, at its outermost level, through deeper headings (a nested criteria heading included) and closes at a
 * same-or-shallower heading; the template list's section stays open while the list still reads, through every
 * line indented deeper than its `- Acceptance criteria:` line and through headings deeper than the one the list sits
 * under, and closes at a same-or-shallower heading, at another line at or left of that line, or at a checkbox left
 * of it (a checkbox at its column stays in, since list items may sit there). So a box under any label nested in the list is reported, never dropped; a sibling section indented
 * deeper than the list line is reported too (an accepted over-report: orchestrator decision, 2026-11-18). An unread
 * box inside either section is filed under it.
 */
function checkboxes(ticket) {
  const found = [];
  let inList = false;
  let headingLevel = 0;
  let headingName = "the top of the ticket";
  let label = null;
  // The open criteria section reports are filed under: a heading's outermost level and name, or the template list's indent.
  let sectionLevel = 0;
  let sectionName = null;
  let listIndent = null;
  // The level of the heading the template list sits under (0 for none): a deeper heading keeps the list's section open.
  let lastHeadingLevel = 0;
  let listHeadingLevel = 0;
  const indentOf = (text) => text.length - text.trimStart().length;
  for (const line of ticket.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const name = line.slice(level).trim();
      inList = false;
      if (!(listIndent !== null && listHeadingLevel && level > listHeadingLevel)) listIndent = null;
      lastHeadingLevel = level;
      headingLevel = CRITERIA_HEADING.test(line) ? level : headingLevel && level > headingLevel ? headingLevel : 0;
      if (!(sectionLevel && level > sectionLevel)) [sectionLevel, sectionName] = CRITERIA_HEADING.test(line) ? [level, name] : [0, null];
      headingName = name;
      label = null;
      continue;
    }
    if (CRITERIA_START.test(line)) {
      inList = true;
      listIndent = indentOf(line);
      listHeadingLevel = lastHeadingLevel;
      continue;
    }
    const item = inList ? CHECKBOX.exec(line) : headingLevel ? TOP_CHECKBOX.exec(line) : null;
    if (item) {
      found.push({ read: true, text: item[2], checked: item[1] !== " " });
      continue;
    }
    // Whether the list was still being read when this line began: a box on the line that ends the reading is in it.
    const reading = inList;
    // A line at or left of the `- Acceptance criteria:` line closes the list; a checkbox only when it is left of it,
    // since list items may sit at that line's column.
    if (listIndent !== null && line.trim() !== "" && indentOf(line) < listIndent + (ANY_CHECKBOX.test(line) ? 0 : 1)) listIndent = null;
    if (inList && line.trim() !== "" && !/^\s{4,}\S/.test(line)) inList = false;
    const stray = ANY_CHECKBOX.exec(line);
    const section = sectionLevel ? sectionName : listIndent !== null || reading ? "Acceptance criteria" : null;
    if (stray) found.push({ read: false, text: stray[2], checked: stray[1] !== " ", under: section ?? label ?? headingName });
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
    if (at <= 0 || !new RegExp(`^${trackerKey()}$`).test(slug)) throw new Error(`--member needs <slug>=<ticket body file>, got ${entry}`);
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
