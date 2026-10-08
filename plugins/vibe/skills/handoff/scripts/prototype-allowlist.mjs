/** The canonical sandbox checker, with one exact-module extension point. */
export const PORTABLE_SURFACE_CHECKER = "apps/prototypes/scripts/check-catalog-imports.mjs";
const DECLARATION = "const portableSurfaceAllowlist = new Set([";
const END = "\n]);";
const STRING_LINE = /^\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/;
const EXACT_MODULE = /^@repo\/app\/[a-z0-9]+(?:[a-z0-9/-]*[a-z0-9])?$/;

/** Admits additive exact module entries while preserving all checker code. */
export function isPortableSurfaceAllowlistEdit(baseText, currentText, moduleExists) {
  const base = parseInitializer(baseText);
  const current = parseInitializer(currentText);
  if (!base || !current || base.before !== current.before || base.after !== current.after) {
    return false;
  }
  const oldEntries = entryCounts(base.entries);
  const newEntries = entryCounts(current.entries);
  if ([...oldEntries].some(([entry, count]) => newEntries.get(entry) !== count)) {
    return false;
  }
  return current.entries.every((entry) => oldEntries.has(entry) ||
    (newEntries.get(entry) === 1 && EXACT_MODULE.test(entry) &&
      !entry.split("/").some((part) => part === "hooks" || part === "queries") && moduleExists(entry)));
}

/** The checked-in initializer uses one JSON string or line comment per line. */
function parseInitializer(text) {
  text = text.trimEnd();
  const start = text.indexOf(DECLARATION);
  if (start === -1 || text.indexOf(DECLARATION, start + DECLARATION.length) !== -1) {
    return null;
  }
  const bodyStart = start + DECLARATION.length;
  const end = text.indexOf(END, bodyStart);
  if (end === -1) {
    return null;
  }
  const entries = [];
  for (const line of text.slice(bodyStart, end).split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("//")) {
      continue;
    }
    const match = STRING_LINE.exec(line);
    if (!match) {
      return null;
    }
    try { entries.push(JSON.parse(match[1])); } catch { return null; }
  }
  return { before: text.slice(0, bodyStart), after: text.slice(end), entries };
}

function entryCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return counts;
}
