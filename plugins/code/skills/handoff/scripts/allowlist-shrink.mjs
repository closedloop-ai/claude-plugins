// Decides whether an edit to a source-gate allowlist only removes entries or
// lowers their counts. The repo's allowlists are shrink-only: a vibe session
// whose change removes the last allowlisted occurrence of a rule must delete
// that entry for `pnpm check:source-gates` to pass, so a draft session may make
// exactly that edit and no other edit under `scripts/` (ISS-12135).

import { isDeepStrictEqual } from "node:util";

/** Allowlist files a draft session may shrink, relative to the repo root. */
export const SHRINK_ONLY_ALLOWLISTS = new Set(["scripts/lint/source-gate-allowlist.json"]);

const ENTRY_KEY_FIELDS = ["rule", "file", "fingerprint"];

/**
 * True when `currentText` keeps every top-level field of `baseText` except
 * `entries`, and every current entry is a base entry with the same fields and
 * a count no higher than before. Anything unparseable or added is false.
 */
export function isShrinkOnlyAllowlistEdit(baseText, currentText) {
  const base = parseAllowlist(baseText);
  const current = parseAllowlist(currentText);
  if (!base || !current) {
    return false;
  }
  const { entries: baseEntries, ...baseRest } = base;
  const { entries: currentEntries, ...currentRest } = current;
  if (!isDeepStrictEqual(baseRest, currentRest)) {
    return false;
  }
  const remaining = new Map();
  for (const entry of baseEntries) {
    const key = entryKey(entry);
    if (key === null || remaining.has(key)) {
      return false;
    }
    remaining.set(key, entry);
  }
  for (const entry of currentEntries) {
    const key = entryKey(entry);
    const before = key === null ? undefined : remaining.get(key);
    if (!before || !isShrunkEntry(before, entry)) {
      return false;
    }
    remaining.delete(key);
  }
  return true;
}

function parseAllowlist(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.entries)) {
    return null;
  }
  return parsed;
}

function entryKey(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return JSON.stringify(ENTRY_KEY_FIELDS.map((field) => entry[field] ?? null));
}

function isShrunkEntry(before, after) {
  const { count: beforeCount, ...beforeRest } = before;
  const { count: afterCount, ...afterRest } = after;
  if (!isDeepStrictEqual(beforeRest, afterRest)) {
    return false;
  }
  if (beforeCount === undefined && afterCount === undefined) {
    return true;
  }
  return (
    Number.isInteger(beforeCount) &&
    Number.isInteger(afterCount) &&
    afterCount >= 1 &&
    afterCount <= beforeCount
  );
}
