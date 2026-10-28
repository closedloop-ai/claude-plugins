// Acceptance criteria as written in a ticket or PRD body: the list items under
// an "Acceptance criteria" heading, up to the next heading. Nothing is inferred
// from other text; a body without that section has no criteria.

const HEADING = /^#{1,6}\s+(.*?)\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const CRITERIA_HEADING = /^acceptance criteria\b/i;

/** The criteria list items of `markdown`, in order; empty when there is no such section. */
export function extractCriteria(markdown) {
  const items = [];
  let inSection = false;
  for (const line of (markdown ?? "").split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      inSection = CRITERIA_HEADING.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const item = ITEM.exec(line);
    if (item) items.push(item[1]);
  }
  return items;
}
