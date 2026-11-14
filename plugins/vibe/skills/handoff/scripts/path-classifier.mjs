import path from "node:path";
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

/** Classify one changed or planned file through the canonical Vibe path policy. */
export function classifyHandoffPath({
  file,
  phase,
  policy,
  prototype = null,
  portableSurfaceAllowed = false,
  retiredDeletion = false,
}) {
  if (isForbiddenHandoffPath(policy, file.path)) {
    return { disposition: PathDisposition.Forbidden, reason: "forbidden" };
  }
  const allowedPath = isAllowedSourcePath({
    filePath: file.path,
    policy,
    prototype,
    portableSurfaceAllowed,
  });
  if (isTestFile(file.path)) {
    const testLocationAllowed = allowedPath || Boolean(policy?.rootTests && isRootTest(file.path));
    if (file.status === "M" && !isSnapshot(file.path) && testLocationAllowed) {
      return { disposition: PathDisposition.Allowed, reason: "test-repair" };
    }
    if (file.status === "D" && retiredDeletion && testLocationAllowed) {
      return { disposition: PathDisposition.Allowed, reason: "retired-test" };
    }
    const pullRequestTest = allowedPath || Boolean(policy?.rootTests && isRootTest(file.path) && TEST_SPEC_PATTERN.test(file.path));
    return phase === "pull-request" && pullRequestTest
      ? { disposition: PathDisposition.Allowed, reason: "pull-request-test" }
      : { disposition: PathDisposition.Outside, reason: "test-not-admitted" };
  }
  return allowedPath
    ? { disposition: PathDisposition.Allowed, reason: "allowed-path" }
    : { disposition: PathDisposition.Outside, reason: "outside-allowed" };
}

/** Whether the repository declaration forbids this literal path. */
function isForbiddenHandoffPath(policy, filePath) {
  return path.posix.basename(filePath) === PATH_POLICY_BASENAME ||
    Boolean(policy?.forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix))) ||
    Boolean(policy?.forbiddenBasenames.includes(path.posix.basename(filePath)));
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
