// Pure helpers behind vibe-sessions.mjs: the session's Vercel URLs, the
// production flag snapshot contract (ISS-12048), the Codex session ids that
// worked on it, the person running it, the environment run's verified result,
// and the live ticket sections rendered from the session record.

import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

// Vercel mints `<project>-git-<branch>` aliases on this domain for every
// pushed branch. A DNS label longer than 63 characters is truncated and
// hashed, so the alias is only predictable below that.
const PREVIEW_DOMAIN = ".preview.closedloop-stage.ai";
const MAX_DNS_LABEL = 63;
export const VercelProject = {
  App: "app-stage",
  Api: "api-stage",
  // Storybook is served by the prototypes project under /storybook
  // (symphony-alpha apps/storybook/AGENTS.md).
  Storybook: "prototypes",
};
const STORYBOOK_PATH = "/storybook";
export const VERCEL_URL_KEYS = ["appUrl", "apiUrl", "storybookUrl"];

// The snapshot contract in symphony-alpha
// packages/api/src/types/feature-flag-snapshot.ts (ISS-12048).
const SNAPSHOT_KEYS = new Set(["takenAt", "distinctId", "orgId", "flags"]);
const MAX_ID_LENGTH = 200;
const MAX_FLAG_KEY_LENGTH = 200;
const MAX_VARIANT_LENGTH = 200;
const MAX_FLAGS = 1000;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ROLLOUT_PREFIX = "rollout-";
const FIRST_LINE_CHUNK = 64 * 1024;
const MAX_FIRST_LINE = 4 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PENDING = "Pending.";

// The permission-less request workflow in symphony-alpha that starts the
// session's environment (ISS-12056). It runs from main; the workflow holding
// the cloud credential (`vibe-environment.yml`) runs after it on
// `workflow_run`, never dispatched here. Both runs are titled
// `Vibe environment <branch> (<request_id>)`.
export const DISPATCH_WORKFLOW = "vibe-environment-dispatch.yml";
export const DispatchInput = {
  Branch: "branch",
  Mode: "mode",
  FlagSnapshot: "flag_snapshot",
  PersonEmail: "person_email",
  ClerkOrgId: "clerk_org_id",
  DesktopAuth: "desktop_auth",
  RequestId: "request_id",
};
// What `pnpm --filter desktop vibe:profile auth-claim` prints: public values
// only; the profile's secrets never leave the Mac.
const DESKTOP_AUTH_KEYS = ["refreshTokenHash", "publicKeySpki", "gatewayId"];
const MAX_DESKTOP_AUTH_VALUE = 4096;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLERK_ORG_ID = /^org_[A-Za-z0-9]+$/;
export const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
const OPERATOR_ID = /^[A-Za-z0-9_-]{1,200}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const HTTPS_URL = /^https:\/\/\S+$/;
const MAX_DEPLOYMENT_ID = 200;
// What symphony-alpha's `vibe-environment.yml` uploads as the
// `vibe-environment-result` artifact once the branch head's app, API, and
// Storybook deployments are READY and their aliases verified against them.
// Any `*.preview.closedloop-stage.ai` host without its own deployment is
// served by the stage production app, so only this result says a URL is safe.
export const ENVIRONMENT_RESULT_ARTIFACT = "vibe-environment-result";
export const ENVIRONMENT_RESULT_FILE = "vibe-environment-result.json";
const ENVIRONMENT_RESULT_KEYS = [
  "requestId",
  "branch",
  "mode",
  "headSha",
  "appUrl",
  "apiUrl",
  "storybookUrl",
  "deploymentIds",
  "verifiedAt",
];
const DEPLOYMENT_ID_KEYS = ["app", "api", "storybook"];
const MAX_OPERATOR_NAME = 200;

/** The stable per-branch Vercel URLs for a vibe branch, or null when unpredictable. */
export function vercelAliases(branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const host = (project) => {
    const label = `${project}-git-${slug}`;
    return label.length > MAX_DNS_LABEL ? null : `https://${label}${PREVIEW_DOMAIN}`;
  };
  const storybookHost = host(VercelProject.Storybook);
  return {
    appUrl: host(VercelProject.App),
    apiUrl: host(VercelProject.Api),
    storybookUrl: storybookHost ? `${storybookHost}${STORYBOOK_PATH}` : null,
  };
}

/**
 * Validates a flag snapshot against the ISS-12048 contract and returns it
 * re-serialized with keys in a fixed order. Throws with every problem found.
 */
export function validateFlagSnapshot(snapshot) {
  const problems = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Flag snapshot must be a JSON object.");
  }
  for (const key of Object.keys(snapshot)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      problems.push(`unknown field "${key}"`);
    }
  }
  if (typeof snapshot.takenAt !== "string" || !ISO_DATETIME.test(snapshot.takenAt) || Number.isNaN(Date.parse(snapshot.takenAt))) {
    problems.push("takenAt must be an ISO datetime");
  }
  if (!isBoundedString(snapshot.distinctId, MAX_ID_LENGTH)) {
    problems.push(`distinctId must be a string of 1 to ${MAX_ID_LENGTH} characters`);
  }
  if (snapshot.orgId !== undefined && !isBoundedString(snapshot.orgId, MAX_ID_LENGTH)) {
    problems.push(`orgId, when present, must be a string of 1 to ${MAX_ID_LENGTH} characters`);
  }
  const flags = snapshot.flags;
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    problems.push("flags must be an object");
  } else {
    const entries = Object.entries(flags);
    if (entries.length > MAX_FLAGS) {
      problems.push(`flags has ${entries.length} entries; at most ${MAX_FLAGS}`);
    }
    for (const [key, value] of entries) {
      if (!isBoundedString(key, MAX_FLAG_KEY_LENGTH)) {
        problems.push(`flag key "${key.slice(0, 40)}" must be 1 to ${MAX_FLAG_KEY_LENGTH} characters`);
      }
      if (typeof value !== "boolean" && !isBoundedString(value, MAX_VARIANT_LENGTH)) {
        problems.push(`flag "${key.slice(0, 40)}" must be true, false, or a variant of 1 to ${MAX_VARIANT_LENGTH} characters`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Flag snapshot does not match the contract: ${problems.join("; ")}.`);
  }
  const normalized = {
    takenAt: snapshot.takenAt,
    distinctId: snapshot.distinctId,
    ...(snapshot.orgId === undefined ? {} : { orgId: snapshot.orgId }),
    flags: Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))),
  };
  const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (bytes >= MAX_SNAPSHOT_BYTES) {
    throw new Error(`Flag snapshot is ${bytes} bytes; it must be under ${MAX_SNAPSHOT_BYTES}.`);
  }
  return normalized;
}

function isBoundedString(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

/**
 * Codex threads spawned, directly or through other subagents, by any of the
 * given orchestrator threads. Reads only the first line (`session_meta`) of
 * rollout files under `<codexHome>/sessions` dated on or after `since`.
 */
export function findCodexSubagents({ codexHome, orchestrators, since }) {
  const metas = readRolloutMetas(path.join(codexHome, "sessions"), since);
  const known = new Set(orchestrators);
  const found = new Map();
  let grew = true;
  while (grew) {
    grew = false;
    for (const meta of metas) {
      if (known.has(meta.id) || !meta.parentId || !known.has(meta.parentId)) {
        continue;
      }
      known.add(meta.id);
      found.set(meta.id, meta);
      grew = true;
    }
  }
  return [...found.values()].sort(
    (a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.id.localeCompare(b.id)
  );
}

function readRolloutMetas(sessionsDir, since) {
  if (!existsSync(sessionsDir)) {
    return [];
  }
  const sinceDay = since ? dayKey(new Date(Date.parse(since) - DAY_MS)) : null;
  const metas = [];
  for (const file of listRolloutFiles(sessionsDir, sinceDay)) {
    const meta = parseSessionMeta(readFirstLine(file));
    if (meta) {
      metas.push(meta);
    }
  }
  return metas;
}

/** Rollout files in `YYYY/MM/DD` folders, skipping days before `sinceDay`. */
function listRolloutFiles(sessionsDir, sinceDay) {
  const files = [];
  for (const year of sortedDirs(sessionsDir)) {
    for (const month of sortedDirs(path.join(sessionsDir, year))) {
      for (const day of sortedDirs(path.join(sessionsDir, year, month))) {
        if (sinceDay && `${year}-${month}-${day}` < sinceDay) {
          continue;
        }
        const dir = path.join(sessionsDir, year, month, day);
        for (const name of readdirSync(dir)) {
          if (name.startsWith(ROLLOUT_PREFIX) && name.endsWith(".jsonl")) {
            files.push(path.join(dir, name));
          }
        }
      }
    }
  }
  return files;
}

function sortedDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function readFirstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK);
    while (total < MAX_FIRST_LINE) {
      const read = readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) {
        break;
      }
      const newline = buffer.subarray(0, read).indexOf(10);
      if (newline !== -1) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      total += read;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function parseSessionMeta(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const payload = parsed?.type === "session_meta" ? parsed.payload : null;
  if (!payload || typeof payload.id !== "string") {
    return null;
  }
  const spawn = payload.source?.subagent?.thread_spawn;
  const parentId = typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : spawn?.parent_thread_id;
  return {
    id: payload.id,
    parentId: typeof parentId === "string" ? parentId : null,
    role: stringOrNull(payload.agent_role ?? spawn?.agent_role),
    nickname: stringOrNull(payload.agent_nickname ?? spawn?.agent_nickname),
    startedAt: stringOrNull(payload.timestamp),
  };
}

function stringOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The live ticket sections that come straight from the session record:
 * Environment, Production flag snapshot, and Sessions. Workers paste this
 * markdown over those three sections instead of writing them by hand.
 */
export function renderRecordSections(record, snapshot) {
  return [
    renderEnvironment(record),
    renderFlagSnapshot(record, snapshot),
    renderSessions(record),
  ].join("\n\n");
}

function renderEnvironment(record) {
  const vercel = record.vercel ?? {};
  // A URL goes on the ticket only once the environment run verified it
  // against the branch's own deployment; until then any preview host may be
  // the stage production app.
  const verified = Boolean(vercel.verifiedAt);
  const url = (value) => (verified && value ? value : PENDING);
  const deployed = verified && vercel.lastDeployedCommit
    ? `\`${vercel.lastDeployedCommit.slice(0, 10)}\` at ${vercel.lastDeployedAt}`
    : PENDING;
  const base = record.baseCommit ? ` (base: origin/main at \`${record.baseCommit.slice(0, 10)}\`)` : "";
  return [
    "## Environment",
    "",
    `- Branch: \`${record.branch}\`${base}`,
    `- Data: ${modeLabel(record.mode)}`,
    `- App: ${url(vercel.appUrl)}`,
    `- API: ${url(vercel.apiUrl)}`,
    `- Storybook: ${url(vercel.storybookUrl)}`,
    `- Last deployed: ${deployed}`,
  ].join("\n");
}

function modeLabel(mode) {
  if (mode === "seeded") {
    return "seeded (Acme Co sample data)";
  }
  if (mode === "blank") {
    return "blank (no data)";
  }
  return PENDING;
}

function renderFlagSnapshot(record, snapshot) {
  const heading = ["## Production flag snapshot", ""];
  if (!record.flagSnapshot || !snapshot) {
    return [...heading, PENDING].join("\n");
  }
  const org = snapshot.orgId ? ` in org \`${snapshot.orgId}\`` : "";
  const rows = Object.entries(snapshot.flags).map(
    ([key, value]) => `| \`${key}\` | ${typeof value === "boolean" ? String(value) : `\`${value}\``} |`
  );
  return [
    ...heading,
    `Taken ${snapshot.takenAt} as PostHog user \`${snapshot.distinctId}\`${org}. ${rows.length} flags. Every redeploy in this session uses these values.`,
    "",
    "| Flag | Value |",
    "|---|---|",
    ...rows,
  ].join("\n");
}

function renderSessions(record) {
  const sessions = record.codexSessions ?? { orchestrators: [], subagents: [] };
  const lines = ["## Sessions", ""];
  if (sessions.orchestrators.length === 0) {
    lines.push(PENDING);
    return lines.join("\n");
  }
  for (const orchestrator of sessions.orchestrators) {
    lines.push(`- Codex session (orchestrator): \`${orchestrator.id}\``);
  }
  for (const subagent of sessions.subagents) {
    const label = [subagent.role, subagent.nickname].filter(Boolean).join(", ");
    lines.push(`- Codex subagent: \`${subagent.id}\`${label ? ` (${label})` : ""}`);
  }
  return lines.join("\n");
}

/**
 * The request workflow's inputs, every value a string: the branch, the mode,
 * the snapshot as compact JSON, and the request id that names both runs. A
 * seeded session also sends the person's email (the stage API finds their
 * Clerk user and org from it) and, only when they belong to more than one
 * stage org, the Clerk id of the one they chose. A session that touches
 * Desktop also sends its saved Desktop auth claim, in either mode, with the
 * person's email so the Desktop session belongs to them (symphony-alpha's
 * request check refuses the claim without it). A blank session without a
 * Desktop claim sends no email, and a blank session never sends a Clerk org.
 */
export function buildDispatchInputs({ record, snapshot, personEmail, clerkOrgId, desktopAuth, requestId }) {
  if (record.mode !== "seeded" && record.mode !== "blank") {
    throw new Error("The session has no seeded or blank mode yet; set it with touch --mode.");
  }
  if (!snapshot) {
    throw new Error("The session has no flag snapshot yet; save one with flag-snapshot first.");
  }
  if (!REQUEST_ID.test(requestId ?? "")) {
    throw new Error("The request id must be 8 to 64 letters, digits, or hyphens.");
  }
  const inputs = {
    [DispatchInput.Branch]: record.branch,
    [DispatchInput.Mode]: record.mode,
    [DispatchInput.FlagSnapshot]: JSON.stringify(validateFlagSnapshot(snapshot)),
    [DispatchInput.RequestId]: requestId,
  };
  if (desktopAuth) {
    inputs[DispatchInput.DesktopAuth] = JSON.stringify(validateDesktopAuth(desktopAuth));
  }
  if (record.mode === "blank") {
    if (clerkOrgId) {
      throw new Error("A Clerk org is only sent for a seeded session.");
    }
    if (!desktopAuth) {
      if (personEmail) {
        throw new Error("A blank session sends the person's email only with a Desktop auth claim.");
      }
      return inputs;
    }
  }
  if (!EMAIL.test(personEmail ?? "")) {
    throw new Error(
      desktopAuth
        ? "A request with a Desktop auth claim needs --person-email (the email ClosedLoop get-me returns), so the Desktop session belongs to the person."
        : "A seeded session needs --person-email (the email ClosedLoop get-me returns)."
    );
  }
  inputs[DispatchInput.PersonEmail] = personEmail;
  if (record.mode === "blank") {
    return inputs;
  }
  if (clerkOrgId !== undefined) {
    if (!CLERK_ORG_ID.test(clerkOrgId)) {
      throw new Error("--clerk-org-id must be a Clerk organization id (org_...).");
    }
    inputs[DispatchInput.ClerkOrgId] = clerkOrgId;
  }
  return inputs;
}

/** Validates an auth claim from `vibe:profile auth-claim` and returns it with keys in a fixed order. */
export function validateDesktopAuth(claim) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    throw new Error("The Desktop auth claim must be a JSON object.");
  }
  const problems = Object.keys(claim)
    .filter((key) => !DESKTOP_AUTH_KEYS.includes(key))
    .map((key) => `unknown field "${key}"`);
  for (const key of DESKTOP_AUTH_KEYS) {
    if (!isBoundedString(claim[key], MAX_DESKTOP_AUTH_VALUE)) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Desktop auth claim does not match auth-claim's output: ${problems.join("; ")}.`);
  }
  return Object.fromEntries(DESKTOP_AUTH_KEYS.map((key) => [key, claim[key]]));
}

/**
 * The person running the session, from ClosedLoop `get-me`: their user id and
 * email (the live ticket is assigned to that user and compared by id and exact
 * email, never by display name) and, when given, their name for the ticket.
 */
export function validateOperator({ id, email, name }) {
  if (!OPERATOR_ID.test(id ?? "")) {
    throw new Error("--operator-id must be the ClosedLoop user id get-me returns.");
  }
  if (!EMAIL.test(email ?? "")) {
    throw new Error("--operator-email must be the email get-me returns.");
  }
  const trimmed = name?.trim() ?? "";
  if (name !== undefined && (trimmed === "" || trimmed.length > MAX_OPERATOR_NAME)) {
    throw new Error(`--operator-name must be 1 to ${MAX_OPERATOR_NAME} characters when given.`);
  }
  return { id, email, name: trimmed || null };
}

/**
 * Validates the environment run's result against the request it answers and
 * the branch head that was pushed. Throws naming every mismatch; a URL is
 * returned only when the whole result checks out.
 */
export function validateEnvironmentResult(result, { requestId, branch, mode, headSha }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The environment result must be a JSON object.");
  }
  const problems = Object.keys(result)
    .filter((key) => !ENVIRONMENT_RESULT_KEYS.includes(key))
    .map((key) => `unknown field "${key}"`);
  const expected = { requestId, branch, mode, headSha };
  for (const [key, value] of Object.entries(expected)) {
    if (result[key] !== value) {
      problems.push(`${key} is ${JSON.stringify(result[key] ?? null)}, expected ${JSON.stringify(value)}`);
    }
  }
  if (!FULL_SHA.test(result.headSha ?? "")) {
    problems.push("headSha must be a full commit SHA");
  }
  for (const key of VERCEL_URL_KEYS) {
    if (typeof result[key] !== "string" || !HTTPS_URL.test(result[key])) {
      problems.push(`${key} must be an https URL`);
    }
  }
  const ids = result.deploymentIds;
  if (!ids || typeof ids !== "object" || Array.isArray(ids)) {
    problems.push("deploymentIds must name the app, api, and storybook deployments");
  } else {
    for (const key of DEPLOYMENT_ID_KEYS) {
      if (!isBoundedString(ids[key], MAX_DEPLOYMENT_ID)) {
        problems.push(`deploymentIds.${key} must be a non-empty string`);
      }
    }
    for (const key of Object.keys(ids).filter((key) => !DEPLOYMENT_ID_KEYS.includes(key))) {
      problems.push(`unknown deploymentIds field "${key}"`);
    }
  }
  if (typeof result.verifiedAt !== "string" || !ISO_DATETIME.test(result.verifiedAt)) {
    problems.push("verifiedAt must be an ISO date and time");
  }
  if (problems.length > 0) {
    throw new Error(`The environment result is not verified for this request: ${problems.join("; ")}.`);
  }
  return {
    appUrl: result.appUrl.replace(/\/$/, ""),
    apiUrl: result.apiUrl.replace(/\/$/, ""),
    storybookUrl: result.storybookUrl.replace(/\/$/, ""),
    deploymentIds: Object.fromEntries(DEPLOYMENT_ID_KEYS.map((key) => [key, ids[key]])),
    headSha: result.headSha,
    verifiedAt: result.verifiedAt,
  };
}
