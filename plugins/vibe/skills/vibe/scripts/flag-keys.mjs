// The keys a person must turn on to see a vibe session's work, per surface,
// with the justification behind every key or read the session added
// (`../references/guardrails.md`, "Feature flags"; operator ruling,
// 2026-10-20, after one symphony-alpha session gated a single Branches list
// behind three keys). `vibe-sessions.mjs flag-keys` saves the validated set
// on the session record, `list` shows it across sessions, and the live
// ticket's Production flag snapshot section renders it.

import { readFileSync } from "node:fs";
import { isOwnedPrototypeSession } from "./prototype-session.mjs";
import { readSessionRecord, writeSessionRecord } from "./session-record.mjs";

const MAX_SURFACES = 50;
const MAX_KEYS_PER_SURFACE = 20;
const MAX_READS_PER_KEY = 20;
const MAX_LABEL_LENGTH = 200;
const MAX_QUOTE_LENGTH = 1000;
// PostHog feature flag keys are letters, digits, hyphens and underscores.
const FLAG_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TICKET_SLUG = /\b[A-Z]+-\d+\b/;
const FILE_FIELDS = new Set(["surfaces"]);
const SURFACE_FIELDS = new Set(["surface", "hosts", "keys"]);
const KEY_FIELDS = new Set(["key", "origin", "readAt", "reason", "repoRule", "source"]);

export const FlagHost = {
  Web: "web",
  Desktop: "desktop",
};
const HOST_LABEL = { [FlagHost.Web]: "web", [FlagHost.Desktop]: "Desktop" };

// `new` is a key this session created; `new-read` an existing key this
// session reads in a new place; `existing` a read already on main that gates
// the changed code. The first two need a justification; all three must be on
// to see the work.
export const FlagOrigin = {
  New: "new",
  NewRead: "new-read",
  Existing: "existing",
};
const ORIGIN_LABEL = {
  [FlagOrigin.New]: "new key",
  [FlagOrigin.NewRead]: "existing key, new read",
  [FlagOrigin.Existing]: "existing key",
};
const JUSTIFIED_ORIGINS = new Set([FlagOrigin.New, FlagOrigin.NewRead]);

// The only reasons a key or read may be added: a net-new surface, screen or
// navigation item, or a rollout a spec asks for. Anything else ships ungated.
export const FlagReason = {
  NetNewSurface: "net-new-surface",
  NetNewScreen: "net-new-screen",
  NetNewNavigationItem: "net-new-navigation-item",
  SpecRequestedRollout: "spec-requested-rollout",
};
const REASONS = new Set(Object.values(FlagReason));

/**
 * Validates a flag keys file and returns it normalized (trimmed strings,
 * sorted hosts and reads). Throws with every problem found.
 */
export function validateFlagKeys(input) {
  if (!isObject(input)) {
    throw new Error("Flag keys must be a JSON object with a surfaces array.");
  }
  const problems = unknownFields(input, FILE_FIELDS, "the file");
  const surfaces = input.surfaces;
  if (!Array.isArray(surfaces)) {
    problems.push("surfaces must be an array (empty when the work has no visible surface)");
  } else if (surfaces.length > MAX_SURFACES) {
    problems.push(`surfaces has ${surfaces.length} entries; at most ${MAX_SURFACES}`);
  }
  const normalized = Array.isArray(surfaces)
    ? surfaces.map((surface, index) => validateSurface(surface, `surfaces[${index}]`, problems))
    : [];
  checkSurfaceNames(normalized, problems);
  checkOriginsAgree(normalized, problems);
  if (problems.length > 0) {
    throw new Error(`Flag keys do not match the contract: ${problems.join("; ")}.`);
  }
  return { surfaces: normalized };
}

/** Validates the flag keys file and saves it on the record, replacing any earlier set. */
export function saveFlagKeys(worktree, file) {
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  if (isOwnedPrototypeSession(record)) {
    throw new Error("A prototype session reads no feature flags; it has no keys to record.");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON flag keys file from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const now = new Date().toISOString();
  const updated = { ...record, flagKeys: { ...validateFlagKeys(parsed), recordedAt: now }, lastActiveAt: now };
  writeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}

export const FLAG_KEYS_HEADING = "### Keys to see this work";

/**
 * The body of the live ticket's keys block for a recorded set: one row per
 * surface and key, with the key's value in the person's snapshot.
 */
export function renderFlagKeys(flagKeys, snapshot) {
  const heading = [FLAG_KEYS_HEADING, ""];
  if (flagKeys.surfaces.length === 0) {
    return [...heading, "No visible surface changed; no key is needed."].join("\n");
  }
  const rows = flagKeys.surfaces.flatMap((surface) => {
    const hosts = surface.hosts.map((host) => HOST_LABEL[host]).join(", ");
    if (surface.keys.length === 0) {
      return [`| ${surface.surface} | ${hosts} | none | - | - |`];
    }
    return surface.keys.map((entry) =>
      `| ${surface.surface} | ${hosts} | \`${entry.key}\` | ${ORIGIN_LABEL[entry.origin]} | ${snapshotValue(snapshot, entry.key)} |`
    );
  });
  return [
    ...heading,
    "Every key listed for a surface must be on to see the work there.",
    "",
    "| Surface | Hosts | Key | Origin | In this snapshot |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** The compact per-session view `vibe-sessions.mjs list` shows across sessions. */
export function listedFlagKeys(flagKeys) {
  if (!flagKeys) {
    return null;
  }
  return flagKeys.surfaces.map((surface) => ({
    surface: surface.surface,
    hosts: surface.hosts,
    keys: surface.keys.map((entry) => ({ key: entry.key, origin: entry.origin })),
  }));
}

function validateSurface(surface, where, problems) {
  if (!isObject(surface)) {
    problems.push(`${where} must be an object`);
    return { surface: "", hosts: [], keys: [] };
  }
  problems.push(...unknownFields(surface, SURFACE_FIELDS, where));
  const name = boundedText(surface.surface, MAX_LABEL_LENGTH, `${where}.surface`, problems);
  const hosts = validateHosts(surface.hosts, `${where}.hosts`, problems);
  const keys = Array.isArray(surface.keys) ? surface.keys : [];
  if (!Array.isArray(surface.keys)) {
    problems.push(`${where}.keys must be an array (empty when no key gates the surface)`);
  } else if (keys.length > MAX_KEYS_PER_SURFACE) {
    problems.push(`${where}.keys has ${keys.length} entries; at most ${MAX_KEYS_PER_SURFACE}`);
  }
  const normalizedKeys = keys.map((entry, index) => validateKey(entry, `${where}.keys[${index}]`, problems));
  const seen = new Set();
  for (const entry of normalizedKeys) {
    if (seen.has(entry.key)) {
      problems.push(`${where} lists \`${entry.key}\` more than once`);
    }
    seen.add(entry.key);
  }
  const added = normalizedKeys.filter((entry) => entry.origin === FlagOrigin.New);
  if (added.length > 1) {
    problems.push(
      `${where} (${name}) adds ${added.length} new keys (${added.map((entry) => entry.key).join(", ")}); one behavior gets one key, and staged rollout states are values or a rollout of that key, never more keys`
    );
  }
  return { surface: name, hosts, keys: normalizedKeys };
}

function validateHosts(hosts, where, problems) {
  const allowed = new Set(Object.values(FlagHost));
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((host) => !allowed.has(host))) {
    problems.push(`${where} must list at least one of ${[...allowed].join(", ")}`);
    return [];
  }
  if (new Set(hosts).size !== hosts.length) {
    problems.push(`${where} lists a host more than once`);
  }
  return [...new Set(hosts)].sort();
}

function validateKey(entry, where, problems) {
  if (!isObject(entry)) {
    problems.push(`${where} must be an object`);
    return { key: "", origin: FlagOrigin.Existing, readAt: [] };
  }
  problems.push(...unknownFields(entry, KEY_FIELDS, where));
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  if (!FLAG_KEY.test(key)) {
    problems.push(`${where}.key must be a PostHog flag key (letters, digits, hyphens and underscores, at most 200)`);
  }
  if (!Object.values(FlagOrigin).includes(entry.origin)) {
    problems.push(`${where}.origin must be one of ${Object.values(FlagOrigin).join(", ")}`);
  }
  const readAt = validateReads(entry.readAt, `${where}.readAt`, problems);
  const normalized = { key, origin: entry.origin, readAt };
  if (!JUSTIFIED_ORIGINS.has(entry.origin)) {
    return normalized;
  }
  if (!REASONS.has(entry.reason)) {
    problems.push(`${where} (\`${key}\`) has no justification: reason must be one of ${[...REASONS].join(", ")}; with none of them, build the change ungated`);
  }
  const repoRule = boundedText(entry.repoRule, MAX_QUOTE_LENGTH, `${where}.repoRule (the target repo's flag rule sentence, quoted)`, problems);
  const source = boundedText(entry.source, MAX_QUOTE_LENGTH, `${where}.source (the ticket or spec sentence, or the person's words)`, problems);
  if (entry.reason === FlagReason.SpecRequestedRollout && source && !TICKET_SLUG.test(source)) {
    problems.push(`${where} (\`${key}\`) claims a spec-requested rollout, but its source names no ticket or spec slug`);
  }
  return { ...normalized, reason: entry.reason, repoRule, source };
}

function validateReads(reads, where, problems) {
  if (!Array.isArray(reads) || reads.length === 0) {
    problems.push(`${where} must list at least one repo-relative file that reads the key`);
    return [];
  }
  if (reads.length > MAX_READS_PER_KEY) {
    problems.push(`${where} has ${reads.length} entries; at most ${MAX_READS_PER_KEY}`);
  }
  const normalized = [];
  for (const read of reads) {
    const file = typeof read === "string" ? read.trim().replaceAll("\\", "/") : "";
    if (!file || file.startsWith("/") || file.split("/").includes("..") || file.length > MAX_LABEL_LENGTH) {
      problems.push(`${where} entry ${JSON.stringify(read)} must be a repo-relative path`);
    } else {
      normalized.push(file);
    }
  }
  return [...new Set(normalized)].sort();
}

function checkSurfaceNames(surfaces, problems) {
  const seen = new Set();
  for (const surface of surfaces) {
    if (surface.surface && seen.has(surface.surface)) {
      problems.push(`surface "${surface.surface}" is listed more than once; list its keys once`);
    }
    seen.add(surface.surface);
  }
}

function checkOriginsAgree(surfaces, problems) {
  const origins = new Map();
  for (const entry of surfaces.flatMap((surface) => surface.keys)) {
    const known = origins.get(entry.key);
    if (known && known !== entry.origin && (known === FlagOrigin.New || entry.origin === FlagOrigin.New)) {
      problems.push(`\`${entry.key}\` is new on one surface and existing on another; a key is either created by this work or not`);
    }
    origins.set(entry.key, known ?? entry.origin);
  }
}

function snapshotValue(snapshot, key) {
  const value = snapshot?.flags?.[key];
  if (value === undefined) {
    return snapshot ? "not in snapshot" : "Pending";
  }
  return typeof value === "boolean" ? String(value) : `\`${value}\``;
}

function boundedText(value, max, where, problems) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) {
    problems.push(`${where} must be text of 1 to ${max} characters`);
  }
  return text;
}

function unknownFields(object, allowed, where) {
  return Object.keys(object).filter((key) => !allowed.has(key)).map((key) => `${where} has unknown field "${key}"`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
