import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRootTest, isSnapshot, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { portableSurfaceChecker } from "./prototype-allowlist.mjs";
import { prototypeRecipe } from "../../vibe/scripts/area-paths.mjs";

export const PathDisposition = Object.freeze({
  Allowed: "allowed",
  Forbidden: "forbidden",
  Outside: "outside",
});

const PATH_POLICY_BASENAME = "vibe-handoff-paths.json";

/**
 * The built-in policy for a repository with no committed declaration (operator ruling, 2026-11-11): no protected
 * path classes, so every path but the declaration itself is the session's to change, and tests may live anywhere.
 */
export const DEFAULT_PATH_POLICY = Object.freeze({ version: 1, allowedPrefixes: Object.freeze([""]), allowedFiles: Object.freeze([]),
  forbiddenPrefixes: Object.freeze([]), forbiddenBasenames: Object.freeze([]), rootTests: true });
export const DEFAULT_POLICY_SOURCE = "built-in-default";

/** Identify the publisher authorized to edit its existing root instructions. */
export function publisherRootInstructions(repository) {
  return repository?.toLowerCase() === "closedloop-ai/claude-plugins";
}

/** Classify one changed or planned file through the canonical Vibe path policy. */
export function classifyHandoffPath({
  file,
  phase,
  policy,
  repository = null,
  declaration = null,
  prototype = null,
  portableSurfaceAllowed = false,
  pathCitations = [],
  retiredDeletion = false,
}) {
  if (isForbiddenHandoffPath(policy, file)) {
    if (publisherRootInstructions(repository) && file.path === PATH_POLICY_BASENAME && file.status === "M" &&
      declaration && !policy.allowedFiles.includes("AGENTS.md") &&
      isDeepStrictEqual(declaration, { ...policy, allowedFiles: [...policy.allowedFiles, "AGENTS.md"] })) {
      return { disposition: PathDisposition.Allowed, reason: "publisher-root-instructions" };
    }
    // Operator ruling, 2026-11-18: permit edits to the publisher repository's existing root AGENTS.md.
    if (publisherRootInstructions(repository) && file.path === "AGENTS.md" && file.status === "M") {
      return { disposition: PathDisposition.Allowed, reason: "root-instruction-edit" };
    }
    return { disposition: PathDisposition.Forbidden, reason: "forbidden" };
  }
  const allowedPath = isAllowedSourcePath({
    filePath: file.path,
    policy,
    prototype,
    portableSurfaceAllowed,
  });
  // A citation changes location eligibility only. Test phase, snapshot and retirement rules still apply.
  const citation = allowedPath ? undefined : pathCitations.find(entry => entry.path === file.path);
  const cited = citation ? { citation } : {};
  if (isTestFile(file.path)) {
    const rootTest = Boolean(policy?.rootTests && isRootTest(file.path));
    const testLocationAllowed = allowedPath || rootTest || citation;
    if (file.status === "M" && !isSnapshot(file.path) && testLocationAllowed) {
      return { disposition: PathDisposition.Allowed, reason: "test-repair", ...(rootTest ? {} : cited) };
    }
    if (file.status === "D" && retiredDeletion && testLocationAllowed) {
      return { disposition: PathDisposition.Allowed, reason: "retired-test", ...(rootTest ? {} : cited) };
    }
    const standard = allowedPath || (rootTest && TEST_SPEC_PATTERN.test(file.path));
    const pullRequestTest = standard || citation;
    return phase === "pull-request" && pullRequestTest
      ? { disposition: PathDisposition.Allowed, reason: "pull-request-test", ...(standard ? {} : cited) }
      : { disposition: PathDisposition.Outside, reason: "test-not-admitted" };
  }
  if (allowedPath) return { disposition: PathDisposition.Allowed, reason: "allowed-path" };
  if (citation) return { disposition: PathDisposition.Allowed, reason: "ticket-criterion", citation };
  return { disposition: PathDisposition.Outside, reason: "outside-allowed" };
}

/** A declaration can admit edits to an exact protected basename. Deletions, protected directories and the declaration stay protected. */
function isForbiddenHandoffPath(policy, { path: filePath, status }) {
  return path.posix.basename(filePath) === PATH_POLICY_BASENAME ||
    Boolean(policy?.forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) ||
    Boolean(policy?.forbiddenBasenames.includes(path.posix.basename(filePath)) && (status !== "M" || !policy.allowedFiles.includes(filePath)));
}

function isAllowedSourcePath({ filePath, policy, prototype, portableSurfaceAllowed }) {
  const recipe = prototypeRecipe();
  if (prototype?.owned && recipe && (filePath.startsWith(`${recipe.sessionRoot}/${prototype.slug}/`) || filePath === recipe.registry)) {
    return true;
  }
  if (prototype?.owned && filePath === portableSurfaceChecker()) return portableSurfaceAllowed;
  return Boolean(policy?.allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) ||
    Boolean(policy?.allowedFiles.includes(filePath));
}
