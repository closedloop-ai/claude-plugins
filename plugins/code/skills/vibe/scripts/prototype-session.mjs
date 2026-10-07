import { readFileSync } from "node:fs";
import { git, readSessionRecord, writeSessionRecord } from "./session-record.mjs";

export const PROTOTYPE_BRANCH_PREFIX = "prototype/";
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STAGE_DEPLOYMENT_HOST = /^prototypes-[a-z0-9]+\.preview\.closedloop-stage\.ai$/;

/** Only a private record created for this branch admits a prototype to vibe. */
export function isOwnedPrototypeSession(record, branch = record?.branch) {
  return Boolean(record && SLUG.test(record.slug ?? "") &&
    branch === `${PROTOTYPE_BRANCH_PREFIX}${record.slug}` && record.branch === branch &&
    record.operator?.id && record.operator?.email && record.createdAt);
}

/** Validates the canonical worker's publication against the owned branch HEAD. */
export function validatePrototypePublication(result, record, headSha) {
  if (!isOwnedPrototypeSession(record)) {
    throw new Error("The session is not an owned prototype session.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The prototype result must be a JSON object.");
  }
  if (result.slug !== record.slug || result.deployedCommit !== headSha || !FULL_SHA.test(headSha)) {
    throw new Error("The prototype result must name this session's slug and full HEAD commit SHA.");
  }
  let url;
  try {
    url = new URL(result.previewUrl);
  } catch {
    throw new Error("The prototype preview URL is invalid.");
  }
  const deploymentHost = url.hostname.endsWith(".vercel.app") || STAGE_DEPLOYMENT_HOST.test(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !deploymentHost || url.hostname.includes("-git-") ||
    url.pathname !== `/p/${record.slug}`) {
    throw new Error("Use the canonical deployment's immutable HTTPS preview URL with /p/<slug>, not an alias.");
  }
  const verifiedAt = result.verifiedAt === undefined ? new Date().toISOString() : result.verifiedAt;
  if (!ISO_DATETIME.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
    throw new Error("The prototype verification timestamp must be an ISO datetime.");
  }
  return { slug: result.slug, previewUrl: url.href, deployedCommit: headSha, verifiedAt };
}

/** Publication is required at handoff, and must still match the current HEAD. */
export function requirePrototypePublication(record, headSha) {
  if (!record?.prototype) {
    throw new Error("The prototype has no verified canonical publication yet.");
  }
  if (typeof record.prototype.verifiedAt !== "string") {
    throw new Error("The stored prototype publication has no verification timestamp.");
  }
  return validatePrototypePublication(record.prototype, record, headSha);
}

/** Persists the canonical worker result only after the owned branch HEAD checks. */
export function savePrototypePublication(worktree, file) {
  const record = readSessionRecord(worktree);
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!isOwnedPrototypeSession(record, branch)) {
    throw new Error("The worktree is not on its owned prototype branch.");
  }
  const result = JSON.parse(readFileSync(file, "utf8"));
  const prototype = validatePrototypePublication(result, record, git(worktree, ["rev-parse", "HEAD"]));
  const updated = { ...record, prototype, lastActiveAt: new Date().toISOString() };
  writeSessionRecord(worktree, updated);
  return { worktree, ...updated };
}
