import path from "node:path";
import { isRootTest, isSnapshot, isTestFile, TEST_SPEC_PATTERN } from "../../vibe/scripts/test-files.mjs";
import { PORTABLE_SURFACE_CHECKER } from "./prototype-allowlist.mjs";

export const PathDisposition = Object.freeze({
  Allowed: "allowed",
  Forbidden: "forbidden",
  Outside: "outside",
});

const PATH_POLICY_BASENAME = "vibe-handoff-paths.json";
const PROTOTYPE_REGISTRY = "apps/prototypes/lib/registry.generated.ts";

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
  if (prototype?.owned && (filePath.startsWith(`apps/prototypes/app/p/${prototype.slug}/`) || filePath === PROTOTYPE_REGISTRY)) {
    return true;
  }
  if (prototype?.owned && filePath === PORTABLE_SURFACE_CHECKER) return portableSurfaceAllowed;
  return Boolean(policy?.allowedPrefixes.some((prefix) => filePath.startsWith(prefix))) ||
    Boolean(policy?.allowedFiles.includes(filePath));
}
