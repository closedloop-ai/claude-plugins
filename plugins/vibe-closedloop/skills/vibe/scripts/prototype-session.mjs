import { readFileSync } from "node:fs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { prototypeRecipe } from "./area-paths.mjs";

const { git, readSessionRecord, writeSessionRecord } = await vibeCore("lib/vibe/scripts/session-record.mjs");

export const LEGACY_PROTOTYPE_BRANCH_PREFIX = "prototype/";
export const SESSION_BRANCH_PREFIX = "vibe/";
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Only a private record created for this branch admits a prototype to vibe. */
export function isOwnedPrototypeSession(record, branch = record?.branch) {
  return Boolean(record && SLUG.test(record.slug ?? "") &&
    (branch === `${LEGACY_PROTOTYPE_BRANCH_PREFIX}${record.slug}` ||
      (record.kind === "prototype" && branch === `${SESSION_BRANCH_PREFIX}${record.slug}`)) && record.branch === branch &&
    record.operator?.id && record.operator?.email && record.createdAt);
}

/** Check prototype support and slug uniqueness on the exact freshly fetched comparison tree. */
export function assertPrototypeSource(repo, ref, slug) {
  if (!git(repo, ["ls-tree", "--name-only", ref, ".claude/skills/prototype/SKILL.md"])) {
    throw new Error("This repository uses its app and Storybook previews for mockups. Start the regular Vibe session for this work.");
  }
  const root = prototypeRecipe()?.sessionRoot;
  if (root && git(repo, ["ls-tree", "--name-only", ref, `${root}/${slug}`])) {
    throw new Error(`Prototype ${slug} already exists on the fresh base. Pick another slug.`);
  }
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
  const deployment = url.hostname.endsWith(".vercel.app") || deploymentHost(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !deployment || url.hostname.includes("-git-") ||
    url.pathname !== `/p/${record.slug}`) {
    throw new Error("Use the canonical deployment's immutable HTTPS preview URL with /p/<slug>, not an alias.");
  }
  const verifiedAt = result.verifiedAt === undefined ? new Date().toISOString() : result.verifiedAt;
  if (!ISO_DATETIME.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) {
    throw new Error("The prototype verification timestamp must be an ISO datetime.");
  }
  const access = ["public", "vercel-team", "unverified"].includes(result.access) ? result.access : undefined;
  return { slug: result.slug, previewUrl: url.href, deployedCommit: headSha, verifiedAt, ...(access ? { access } : {}) };
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

/** Whether `host` is the provider's prototype deployment host (`recipes.prototypes.deploymentHost`); none without one. */
function deploymentHost(host) {
  const pattern = prototypeRecipe()?.deploymentHost;
  return typeof pattern === "string" && new RegExp(pattern).test(host);
}
