// An operator's recorded ruling for targeted tests (ISS-14077) lets the verifier
// evidence leave named runs not run: graph-selected tests outside the targeted
// inventory, the matching post-merge lanes, and the web and Desktop host lanes.
// The evidence cites the ruling as `targetedTestsRuling: {id, source}`, where
// `source` is "ticket" (the live ticket body passed with --ticket) or "rulings"
// (the program's rulings file passed with --rulings). The id has the form
// R-<WORDS> (R-TARGETED-TESTS). The ruling counts only when that text records
// it once, as a dated heading or list line labeled with the id; it is not an
// orchestrator direction, nothing in its section or the headings enclosing it
// says it is withdrawn or superseded, no other line names it, and its entry,
// apart from the id, is about targeted tests. Under it the targeted inventory
// must hold at least one test. Every item it leaves keeps its own
// `not-run` row with `ruling: <id>` and a reason. The targeted inventory still
// needs its passing run on the published commit, and a diff-rule required test
// or a spec the branch edits is never left this way.

const RULING_ID = /^R-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SOURCES = Object.freeze(["ticket", "rulings"]);
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)[-*]\s+(.*)$/;
const LABEL = /^(?:\*\*)?(?:Ruling\s+)?(R-[A-Z0-9]+(?:-[A-Z0-9]+)*)(?![\w.-])/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const TARGETED = /\btargeted\s+(?:tests?|inventory|runs?|suites?|set|selection)\b/i;
const ORCHESTRATOR = /\(\s*orchestrator\b/i;
const WITHDRAWN = /\b(?:withdrawn|withdrew|superseded|revoked|rescinded|overruled|cancell?ed|no longer (?:in effect|applies|applicable))\b/i;
const WITHDRAWN_HEADING = /\b(?:withdraw\w*|supersed\w*|revok\w*|rescind\w*|overrul\w*|cancell?ed|retired|obsolete|no longer)\b/i;
const RECORD_SHAPE = Object.freeze({
  rulings: "record it once as a dated heading `## R-<WORDS> (<who>, <YYYY-MM-DD>)` with the decision under it",
  ticket: "record it once as a list line `- Ruling R-<WORDS> <YYYY-MM-DD> (<who>): \"<decision>\"; amends: <criteria, or none>`",
});

/** The lanes a recorded targeted-tests ruling may leave not run (pr-facts.mjs requiredLanes). */
export const RULING_HOST_LANES = Object.freeze(["web-host", "desktop-host"]);

/** The verified ruling id, or null, with the problems that keep it from counting. */
export function targetedTestsRuling(evidence, { ticketText, rulingsText } = {}) {
  const cited = evidence?.targetedTestsRuling;
  if (cited === undefined) return { id: null, problems: [] };
  if (!cited || typeof cited !== "object" || !RULING_ID.test(cited.id ?? "") || !SOURCES.includes(cited.source)) {
    return { id: null, problems: [`targetedTestsRuling needs an id and a source (${SOURCES.join(" or ")}); the id has the form R-<WORDS>`] };
  }
  const text = cited.source === "ticket" ? ticketText : rulingsText;
  if (typeof text !== "string") {
    return { id: null, problems: [`targeted-tests ruling ${cited.id}: pass the ${cited.source === "ticket" ? "ticket body with --ticket" : "rulings file with --rulings"}`] };
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const entries = rulingEntries(lines, cited.id);
  const refuse = (reason) => ({ id: null, problems: [`targeted-tests ruling ${cited.id} ${reason}`] });
  if (entries.length === 0) {
    return refuse(`is not recorded with a date in the ${cited.source}: ${RECORD_SHAPE[cited.source]}; an existing ruling with no id needs its R-<WORDS> label added`);
  }
  if (entries.length > 1) return refuse(`is recorded ${entries.length} times in the ${cited.source}`);
  const [{ entry, section, start, end }] = entries;
  if (ORCHESTRATOR.test(entry.split("\n")[0])) return refuse(`in the ${cited.source} is an orchestrator direction, not an operator ruling`);
  if (WITHDRAWN.test(section) || enclosingHeadings(lines, start).some((heading) => WITHDRAWN_HEADING.test(heading))) {
    return refuse(`in the ${cited.source} is withdrawn or superseded`);
  }
  if (namedElsewhere(lines, cited.id, start, end)) {
    return refuse(`is also named outside its own entry in the ${cited.source}; only a ruling named nowhere else can be cited, since a later line naming it may withdraw or supersede it`);
  }
  if (!TARGETED.test(entry.replaceAll(cited.id, ""))) return refuse(`in the ${cited.source} is not about targeted tests`);
  return { id: cited.id, problems: [] };
}

/** A run the verified ruling left not run, with its reason, recorded on `commit` when one is given. */
export function leftByRuling(run, rulingId, commit) {
  return Boolean(rulingId) && run?.status === "not-run" && run.ruling === rulingId
    && typeof run.reason === "string" && run.reason.trim() !== "" && (!commit || run.commit === commit);
}

/**
 * Each dated heading or list item whose label (its first word, after an optional
 * "Ruling") is exactly `id`. Its `entry` is the lines under it up to the next
 * heading, or for a list item the next item at its depth; its `section` (a
 * heading's lines up to the next heading of the same or a higher level) is
 * where a withdrawal of it is looked for.
 */
function rulingEntries(lines, id) {
  const entries = [];
  for (const [index, line] of lines.entries()) {
    const heading = HEADING.exec(line);
    const item = heading ? null : LIST_ITEM.exec(line);
    const label = LABEL.exec((heading?.[2] ?? item?.[2] ?? "").trim());
    if (label?.[1] !== id || !DATE.test(line)) continue;
    let stop = index + 1;
    while (stop < lines.length && !HEADING.test(lines[stop])
      && !(item && LIST_ITEM.exec(lines[stop]) && LIST_ITEM.exec(lines[stop])[1].length <= item[1].length)) stop++;
    let end = stop;
    while (heading && end < lines.length && !(HEADING.exec(lines[end]) && HEADING.exec(lines[end])[1].length <= heading[1].length)) end++;
    entries.push({ entry: lines.slice(index, stop).join("\n"), section: lines.slice(index, end).join("\n"), start: index, end });
  }
  return entries;
}

/** Whether any line outside the ruling's own section names `id`, whatever follows it. */
function namedElsewhere(lines, id, start, end) {
  const named = new RegExp(`(?<![\\w-])${id}(?![A-Za-z0-9-]|\\.\\d)`);
  return lines.some((line, index) => (index < start || index >= end) && named.test(line));
}

/** The headings that enclose line `start`: the nearest heading above it and each higher-level heading above that. */
function enclosingHeadings(lines, start) {
  const found = [];
  let level = (HEADING.exec(lines[start])?.[1].length ?? 7);
  for (let index = start - 1; index >= 0 && level > 1; index--) {
    const heading = HEADING.exec(lines[index]);
    if (heading && heading[1].length < level) {
      found.push(heading[2]);
      level = heading[1].length;
    }
  }
  return found;
}
