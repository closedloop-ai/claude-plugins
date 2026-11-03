#!/usr/bin/env node
// The keys a person must turn on to see a vibe session's work, per surface,
// and the person's approval of every key or read the session adds
// (`../references/guardrails.md`, "Feature flags"; operator ruling,
// 2026-10-20, after one symphony-alpha session gated a single Branches list
// behind three keys). No agent adds a flag on its own: the justification is
// the input to a question the person answers in the session, one key at a
// time, and only their recorded yes lets the key be built.
//
// Usage:
//   flag-keys.mjs record   --worktree <path> --file <flag-keys.json>
//   flag-keys.mjs question --worktree <path> --key <flag key>
//   flag-keys.mjs approve  --worktree <path> --key <flag key> --decision approved|declined --answer <their words>
//   flag-keys.mjs show     --worktree <path>
//
// `record` validates the writer's set and saves it on the session record,
// replacing any earlier set and keeping earlier answers. `question` prints the
// exact approval question for one proposed key and the session-questions.mjs
// key to ask it under. `approve` saves the person's answer once that exact
// question was asked and answered through session-questions.mjs; it is tied
// to the proposal it answered, so a changed surface, stack, reason or source
// needs a new question. `vibe-sessions.mjs list` shows each session's keys and
// `ticket-sections` renders them. Every command prints one JSON object;
// errors print {"ok":false,"error":...} and exit non-zero.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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
const QUESTION_KEY_PREFIX = "flag-approval";
const FINGERPRINT_LENGTH = 12;
const MAX_QUESTION_SLUG = 48;

export const FLAG_KEYS_HEADING = "### Keys to see this work";

export const FlagHost = {
  Web: "web",
  Desktop: "desktop",
};
const HOST_LABEL = { [FlagHost.Web]: "web", [FlagHost.Desktop]: "Desktop" };

// `new` is a key this session creates; `new-read` an existing key this
// session reads in a new place; `existing` a read already on main that gates
// the changed code. The first two need a justification and the person's
// approval; all three must be on to see the work.
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
const PROPOSED_ORIGINS = new Set([FlagOrigin.New, FlagOrigin.NewRead]);

// The only reasons a key or read may be proposed: a net-new surface, screen
// or navigation item, or a rollout a spec asks for. Anything else ships
// ungated without asking.
export const FlagReason = {
  NetNewSurface: "net-new-surface",
  NetNewScreen: "net-new-screen",
  NetNewNavigationItem: "net-new-navigation-item",
  SpecRequestedRollout: "spec-requested-rollout",
};
const REASONS = new Set(Object.values(FlagReason));
const REASON_LABEL = {
  [FlagReason.NetNewSurface]: "it is a new surface",
  [FlagReason.NetNewScreen]: "it is a new screen",
  [FlagReason.NetNewNavigationItem]: "it is a new navigation item",
  [FlagReason.SpecRequestedRollout]: "the spec asks for a gated rollout",
};

export const FlagDecision = {
  Approved: "approved",
  Declined: "declined",
};
// `pending` has no answer for the key's current proposal; a stale answer
// (given for a different surface, stack, reason or source) counts as none.
export const ApprovalStatus = {
  ...FlagDecision,
  Pending: "pending",
};

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
  checkKeysAgree(normalized, problems);
  if (problems.length > 0) {
    throw new Error(`Flag keys do not match the contract: ${problems.join("; ")}.`);
  }
  return { surfaces: normalized };
}

/**
 * Every proposed key (new or new read) with what the person is asked about:
 * its justification, the surfaces it gates and every other key the same work
 * also sits behind there.
 */
export function proposals(flagKeys) {
  const byKey = new Map();
  for (const surface of flagKeys.surfaces) {
    for (const entry of surface.keys.filter((candidate) => PROPOSED_ORIGINS.has(candidate.origin))) {
      const proposal = byKey.get(entry.key) ?? {
        key: entry.key, origin: entry.origin, reason: entry.reason, repoRule: entry.repoRule, source: entry.source,
        surfaces: [], stack: new Set(),
      };
      proposal.surfaces.push({ surface: surface.surface, hosts: surface.hosts });
      for (const other of surface.keys) {
        if (other.key !== entry.key) {
          proposal.stack.add(other.key);
        }
      }
      byKey.set(entry.key, proposal);
    }
  }
  return new Map([...byKey].map(([key, proposal]) => [key, { ...proposal, stack: [...proposal.stack].sort() }]));
}

/** The exact words the person is asked before one proposed key is built. */
export function approvalQuestion(proposal) {
  const where = proposal.surfaces.map(({ surface, hosts }) => `${surface} (${hosts.map((host) => HOST_LABEL[host]).join(", ")})`).join("; ");
  const ask = proposal.origin === FlagOrigin.New
    ? `Add the new feature switch \`${proposal.key}\`?`
    : `Put this work behind the existing feature switch \`${proposal.key}\`?`;
  const stack = proposal.stack.length === 0
    ? "No other switch gates this work there."
    : `To see the work there, these switches would also have to be on: ${proposal.stack.map((key) => `\`${key}\``).join(", ")}.`;
  return [
    `${ask} It would keep this work hidden until the switch is on, on: ${where}.`,
    `Why: ${REASON_LABEL[proposal.reason]}. Source: ${proposal.source}`,
    stack,
    `Reply yes to add \`${proposal.key}\`, or no to build the change without a switch, so it shows for everyone once it ships.`,
  ].join("\n");
}

/** The session-questions.mjs key for one proposal; a changed proposal gets a new one. */
export function approvalQuestionKey(proposal) {
  const slug = proposal.key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, MAX_QUESTION_SLUG);
  return `${QUESTION_KEY_PREFIX}:${slug}:${fingerprint(proposal)}`;
}

/** Whether the person approved this key for its current proposal. */
export function approvalStatus(flagKeys, key) {
  const proposal = proposals(flagKeys).get(key);
  const approval = flagKeys.approvals?.[key];
  if (!proposal || !approval || approval.fingerprint !== fingerprint(proposal)) {
    return ApprovalStatus.Pending;
  }
  return approval.decision;
}

/**
 * What blocks handoff in a session's recorded keys: none recorded, a proposed
 * key without the person's yes for its current proposal, or an approved key
 * that no file reads.
 */
export function flagKeyProblems(record) {
  if (!record || isOwnedPrototypeSession(record)) {
    return [];
  }
  if (!record.flagKeys) {
    return ["no keys to see the work are recorded (flag-keys.mjs record)"];
  }
  const problems = [];
  for (const key of proposals(record.flagKeys).keys()) {
    const status = approvalStatus(record.flagKeys, key);
    if (status !== ApprovalStatus.Approved) {
      problems.push(`\`${key}\` has no approval from the person (${status}); ask them, or build the change without it and remove it`);
    } else if (readsOf(record.flagKeys, key).length === 0) {
      problems.push(`\`${key}\` is approved but no file reads it; record its reads or remove it`);
    }
  }
  return problems;
}

/** Validates the writer's set and saves it, keeping the person's earlier answers. */
export function recordFlagKeys(worktree, file) {
  const record = requireSessionRecord(worktree);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON flag keys file from ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = { ...validateFlagKeys(parsed), approvals: record.flagKeys?.approvals ?? {} };
  const refused = [];
  for (const key of proposals(candidate).keys()) {
    const status = approvalStatus(candidate, key);
    if (status === ApprovalStatus.Declined) {
      refused.push(`the person declined \`${key}\`; remove it and build the change without a switch`);
    } else if (status === ApprovalStatus.Pending && readsOf(candidate, key).length > 0) {
      refused.push(`\`${key}\` is read in ${readsOf(candidate, key).join(", ")} without the person's yes for this proposal; build no flag until they approve it (flag-keys.mjs question)`);
    }
  }
  if (refused.length > 0) {
    throw new Error(`Flag keys not recorded: ${refused.join("; ")}.`);
  }
  const now = new Date().toISOString();
  const updated = { ...record, flagKeys: { ...candidate, recordedAt: now }, lastActiveAt: now };
  writeSessionRecord(worktree, updated);
  const pending = [...proposals(candidate).keys()]
    .filter((key) => approvalStatus(candidate, key) === ApprovalStatus.Pending)
    .map((key) => ({
      key,
      next: `Do not read \`${key}\` yet. Confirm no key on main or in another session's vibe-sessions.mjs list entry already gates these surfaces (reuse it if one does), build the rest without the gate, and return NEEDS_FLAG_APPROVAL for \`${key}\`.`,
    }));
  return { worktree, ...updated, pending };
}

/** The approval question for one proposed key, with the key to ask it under. */
export function flagQuestion(worktree, key) {
  const proposal = requireProposal(requireSessionRecord(worktree), key);
  const questionKey = approvalQuestionKey(proposal);
  return {
    key, questionKey, question: approvalQuestion(proposal),
    next: [
      `Ask the person in exactly these words with session-questions.mjs ask --worktree <wt> --key ${questionKey}, one key per question, with no research or precedent gate.`,
      `Record their exact words with session-questions.mjs answer under ${questionKey}, then run flag-keys.mjs approve --key ${key} --answer "<their words>" with --decision approved only for an explicit yes, otherwise declined.`,
      "Resume the same writer with the result. With no answer, the key stays pending and nothing is gated.",
    ],
  };
}

/**
 * Saves the person's answer for one proposed key. The exact question must
 * have been asked and answered with these words through session-questions.mjs,
 * by the person running the session.
 */
export function approveFlagKey(worktree, { key, decision, answer }) {
  const record = requireSessionRecord(worktree);
  const proposal = requireProposal(record, key);
  if (!Object.values(FlagDecision).includes(decision)) {
    throw new Error(`--decision must be one of ${Object.values(FlagDecision).join(", ")}.`);
  }
  if (!record.operator?.id || !record.operator?.email) {
    throw new Error("The session records no operator; only the person running it can approve a flag key.");
  }
  const questionKey = approvalQuestionKey(proposal);
  const question = approvalQuestion(proposal);
  const asked = (record.questions ?? []).find((entry) => entry.key === questionKey);
  if (!asked || asked.question !== question) {
    throw new Error(`The person was not asked about \`${key}\` in these words; ask under ${questionKey} with the text flag-keys.mjs question prints.`);
  }
  if (!answer || asked.answer !== answer || !asked.answeredAt) {
    throw new Error(`No recorded answer under ${questionKey} matches --answer; record their exact words with session-questions.mjs answer first.`);
  }
  const approvals = {
    ...record.flagKeys.approvals,
    [key]: {
      decision, fingerprint: fingerprint(proposal), questionKey, question, words: answer,
      by: { id: record.operator.id, email: record.operator.email, name: record.operator.name ?? null },
      at: asked.answeredAt,
    },
  };
  const updated = { ...record, flagKeys: { ...record.flagKeys, approvals }, lastActiveAt: new Date().toISOString() };
  writeSessionRecord(worktree, updated);
  return { worktree, key, decision, at: asked.answeredAt };
}

/**
 * The body of the live ticket's keys block for a recorded set: one row per
 * surface and key, with the person's approval and the key's value in their
 * snapshot.
 */
export function renderFlagKeys(flagKeys, snapshot) {
  const heading = [FLAG_KEYS_HEADING, ""];
  if (flagKeys.surfaces.length === 0) {
    return [...heading, "No visible surface changed; no key is needed."].join("\n");
  }
  const rows = flagKeys.surfaces.flatMap((surface) => {
    const hosts = surface.hosts.map((host) => HOST_LABEL[host]).join(", ");
    if (surface.keys.length === 0) {
      return [`| ${surface.surface} | ${hosts} | none | - | - | - |`];
    }
    return surface.keys.map((entry) =>
      `| ${surface.surface} | ${hosts} | \`${entry.key}\` | ${ORIGIN_LABEL[entry.origin]} | ${approvalLabel(flagKeys, entry)} | ${snapshotValue(snapshot, entry.key)} |`
    );
  });
  return [
    ...heading,
    "Every key listed for a surface must be on to see the work there.",
    "",
    "| Surface | Hosts | Key | Origin | Approval | In this snapshot |",
    "|---|---|---|---|---|---|",
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
    keys: surface.keys.map((entry) => ({
      key: entry.key,
      origin: entry.origin,
      ...(PROPOSED_ORIGINS.has(entry.origin) ? { approval: approvalStatus(flagKeys, entry.key) } : {}),
    })),
  }));
}

function approvalLabel(flagKeys, entry) {
  if (!PROPOSED_ORIGINS.has(entry.origin)) {
    return "on main";
  }
  const status = approvalStatus(flagKeys, entry.key);
  if (status === ApprovalStatus.Approved) {
    const approval = flagKeys.approvals[entry.key];
    return `approved by ${approval.by.name ?? approval.by.email} at ${approval.at}`;
  }
  return status === ApprovalStatus.Declined ? "declined, not built" : "pending approval, not built";
}

function readsOf(flagKeys, key) {
  return [...new Set(flagKeys.surfaces.flatMap((surface) =>
    surface.keys.filter((entry) => entry.key === key).flatMap((entry) => entry.readAt)))].sort();
}

function fingerprint(proposal) {
  const { key, origin, reason, source, repoRule, surfaces, stack } = proposal;
  return createHash("sha256")
    .update(JSON.stringify({ key, origin, reason, source, repoRule, surfaces, stack }))
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}

function requireSessionRecord(worktree) {
  const record = readSessionRecord(worktree);
  if (!record) {
    throw new Error(`No vibe session record in ${worktree}.`);
  }
  if (isOwnedPrototypeSession(record)) {
    throw new Error("A prototype session reads no feature flags; it has no keys to record.");
  }
  return record;
}

function requireProposal(record, key) {
  const proposal = record.flagKeys ? proposals(record.flagKeys).get(key) : undefined;
  if (!proposal) {
    throw new Error(`\`${key}\` is not a proposed new key or new read in the recorded set; record it with flag-keys.mjs record first.`);
  }
  return proposal;
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
  const proposed = PROPOSED_ORIGINS.has(entry.origin);
  // A proposed key is recorded before it is built, so it may have no reads yet.
  const readAt = validateReads(entry.readAt, `${where}.readAt`, problems, { required: !proposed });
  const normalized = { key, origin: entry.origin, readAt };
  if (!proposed) {
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

function validateReads(reads, where, problems, { required }) {
  if (reads === undefined && !required) {
    return [];
  }
  if (!Array.isArray(reads) || (required && reads.length === 0)) {
    problems.push(`${where} must list ${required ? "at least one" : "each"} repo-relative file that reads the key`);
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

/** A key is either created by this work or not, and one proposal has one justification. */
function checkKeysAgree(surfaces, problems) {
  const first = new Map();
  for (const entry of surfaces.flatMap((surface) => surface.keys)) {
    const known = first.get(entry.key);
    if (!known) {
      first.set(entry.key, entry);
      continue;
    }
    if (known.origin !== entry.origin && (known.origin === FlagOrigin.New || entry.origin === FlagOrigin.New)) {
      problems.push(`\`${entry.key}\` is new on one surface and existing on another; a key is either created by this work or not`);
    } else if (PROPOSED_ORIGINS.has(known.origin) && PROPOSED_ORIGINS.has(entry.origin) &&
      (known.reason !== entry.reason || known.source !== entry.source || known.repoRule !== entry.repoRule)) {
      problems.push(`\`${entry.key}\` has a different justification on different surfaces; give it one`);
    }
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

function run(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      worktree: { type: "string" },
      file: { type: "string" },
      key: { type: "string" },
      decision: { type: "string" },
      answer: { type: "string" },
    },
  });
  const option = (name) => {
    if (!values[name]) {
      throw new Error(`--${name} is required.`);
    }
    return values[name];
  };
  switch (positionals[0]) {
    case "record": {
      const { pending, ...session } = recordFlagKeys(option("worktree"), option("file"));
      return { session, pending };
    }
    case "question":
      return flagQuestion(option("worktree"), option("key"));
    case "approve":
      return approveFlagKey(option("worktree"), { key: option("key"), decision: option("decision"), answer: option("answer") });
    case "show": {
      const record = requireSessionRecord(option("worktree"));
      return { flagKeys: record.flagKeys ?? null, problems: flagKeyProblems(record) };
    }
    default:
      throw new Error("Unknown command. Use one of: record, question, approve, show.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, ...run(process.argv.slice(2)) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}
