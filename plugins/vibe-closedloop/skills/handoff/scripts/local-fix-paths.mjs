// The session record's `localFixes` as handoff reads them: local workarounds that stay out of the
// session's changed files and every diff rule. Each exact path maps to its fix's ticket (null when it names none);
// the first fix naming a path wins. A record without `localFixes`, or entries of the wrong shape, add nothing.

/** Every local-fix path in `record`, each with its ticket or null. */
export function localFixPaths(record) {
  const tickets = new Map();
  const fixes = Array.isArray(record?.localFixes) ? record.localFixes : [];
  for (const fix of fixes) {
    for (const filePath of Array.isArray(fix?.paths) ? fix.paths : []) {
      if (typeof filePath === "string" && !tickets.has(filePath)) {
        tickets.set(filePath, typeof fix.ticket === "string" ? fix.ticket : null);
      }
    }
  }
  return tickets;
}
