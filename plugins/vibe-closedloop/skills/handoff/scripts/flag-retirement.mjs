import { isE2ePath, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { createImportClosure, escapeRegExp, SOURCE_FILE } from "./source-imports.mjs";

const REGISTRY = /(?:^|\/)retired-feature-flags\.[cm]?[jt]s$/;
const REGISTRY_ENTRY = /^\s*(?:[\w$]+:\s*)?(["'])([\w.-]+)\1\s*,?\s*(?:\/\/[^\n]*)?$/gm;
const STORY = /\.stories\.[cm]?[jt]sx?$/;
const COVERAGE = /^\s*(?:[-*]\s+)?Flag retirement:\s*([\w.-]+):\s*(updated|removed|retained|pinned|unrelated)\s+([^:\n]+):\s*(\S.*)$/;

function registryKeys(text) {
  return new Set([...(text ?? "").matchAll(REGISTRY_ENTRY)].map((match) => match[2]));
}

function isSpecOrStory(file) {
  return STORY.test(file) || (isE2ePath(file) && TEST_SPEC_PATTERN.test(file));
}

/**
 * Require a census of base specs and stories only when the diff adds retired keys.
 * Test navigation can reach a route without importing it or mentioning its flag.
 * Every base candidate gets a disposition so such dynamic paths cannot vanish
 * from the inventory. Source-proven importers cannot be marked unrelated.
 */
export function checkFlagRetirement(files, repo, changeLog, add) {
  const configured = repo.rules?.flagRetirementRegistry;
  const retirements = files.filter(({ path, status }) => status !== "D" && (configured ? path === configured : REGISTRY.test(path)))
    .flatMap((file) => {
      const prior = registryKeys(repo.base(file.oldPath ?? file.path));
      return [...registryKeys(repo.head(file.path))].filter((key) => !prior.has(key)).map((key) => ({ key, file }));
    });
  if (!retirements.length) return [];

  const candidates = [...repo.baseFiles].filter(isSpecOrStory).sort();
  const known = new Set(candidates);
  const changed = new Map(files.map((file) => [file.oldPath ?? file.path, file.status]));
  const baseSources = files.filter(({ path }) => SOURCE_FILE.test(path) && !isSpecOrStory(path))
    .map((file) => file.oldPath ?? file.path).filter((file) => repo.baseFiles.has(file));
  const contents = repo.baseBlobs(baseSources);
  const closure = createImportClosure(repo.baseFiles, repo.baseBlobs);
  const logLines = changeLog.split(/\r?\n/);
  const lines = logLines.map((line) => COVERAGE.exec(line)).filter(Boolean);

  return retirements.map(({ key, file }) => {
    const entries = new Map();
    const fix = candidates.length ? `review each base spec/story for ${key}; record \`Flag retirement: ${key}: <updated|removed|retained|pinned|unrelated> <path>: <evidence>\` and update or remove cases that used the retired arm`
      : `record \`Flag retirement: ${key}: none: <evidence>\` for the empty base inventory`;
    const problem = (reason) => add("flag-retirement-inventory", file.path, file.added[0]?.line ?? 1, reason, fix);
    for (const [, , disposition, rawPath] of lines.filter((entry) => entry[1] === key)) {
      const candidate = rawPath.trim();
      if (!known.has(candidate) || entries.has(candidate)) {
        problem(`${key} has an unknown or duplicate base spec/story ${candidate}`);
      } else {
        entries.set(candidate, disposition);
      }
    }
    const missing = candidates.filter((file) => !entries.has(file));
    if (missing.length) problem(`${key} is missing ${missing.length} base spec/story dispositions: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? ", …" : ""}`);
    if (!candidates.length) {
      const emptyRecord = new RegExp(`^\\s*(?:[-*]\\s+)?Flag retirement: ${escapeRegExp(key)}: none:\\s*\\S`);
      if (!logLines.some((line) => emptyRecord.test(line))) problem(`${key} has no acknowledgement of the empty base spec/story inventory`);
    }

    const keyAlias = key.replace(/[^\w]/g, "_").toUpperCase();
    const references = new RegExp(`(?:["']${escapeRegExp(key)}["']|\\b${escapeRegExp(keyAlias)}_(?:FEATURE_)?FLAG(?:_KEY)?\\b)`);
    const owners = new Set([...contents].filter(([owner, text]) => owner !== file.path && references.test(text ?? "")).map(([owner]) => owner));
    const pinsOn = new RegExp(`(["'])${escapeRegExp(key)}\\1\\s*:\\s*true\\b`);
    const claimedPins = [...entries].filter(([, disposition]) => disposition === "pinned").map(([candidate]) => candidate);
    const pinnedSources = repo.baseBlobs(claimedPins);
    for (const [candidate, disposition] of entries) {
      if (disposition === "updated" && !/^[MRC]/.test(changed.get(candidate) ?? "")) problem(`${candidate} is listed as updated for ${key} but the diff has no update`);
      if (disposition === "removed" && changed.get(candidate) !== "D") problem(`${candidate} is listed as removed for ${key} but the diff has no deletion`);
      if (disposition === "pinned" && !pinsOn.test(pinnedSources.get(candidate) ?? "")) problem(`${candidate} is listed as pinned for ${key} without a literal true pin in the base fixture`);
      if (disposition === "unrelated" && owners.size && [...closure([candidate])].some((dependency) => owners.has(dependency))) {
        problem(`${candidate} imports a former flag owner for ${key} and cannot be listed as unrelated`);
      }
    }
    return { key, candidates, unpinned: candidates.filter((candidate) => /^(?:updated|removed|retained)$/.test(entries.get(candidate) ?? "")) };
  });
}
