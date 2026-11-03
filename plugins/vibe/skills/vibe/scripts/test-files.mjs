// Test-file classification shared by the handoff inventory and the retired-test
// record. Root web and Desktop specs live outside the session's app paths.

export const ROOT_TEST_PREFIXES = ["e2e/", "apps/desktop/test/"];
export const TEST_SPEC_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_SUPPORT_PATTERN = /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|__snapshots__|fixtures)\//;
const SNAPSHOT_PATTERN = /\.snap$/;
// An e2e suite root is any directory named `e2e`, `e2e-*` or `*-e2e` (web, Desktop, smoke and walk suites alike).
const E2E_ROOT = /(?:^|\/)(?:e2e|e2e[-_][^/]+|[^/]+[-_]e2e)\//;
export const E2E_ROOT_PATHSPECS = [":(glob)**/e2e/**", ":(glob)**/e2e[-_]*/**", ":(glob)**/*[-_]e2e/**"];

/** A spec, a file under a test support folder, or a snapshot. */
export function isTestFile(filePath) {
  return TEST_SPEC_PATTERN.test(filePath) || TEST_SUPPORT_PATTERN.test(filePath) || SNAPSHOT_PATTERN.test(filePath);
}

export function isSnapshot(filePath) {
  return SNAPSHOT_PATTERN.test(filePath);
}

/** A test under a root web or Desktop test directory, or under any e2e suite root. */
export function isRootTest(filePath) {
  return ROOT_TEST_PREFIXES.some((prefix) => filePath.startsWith(prefix)) || isE2ePath(filePath);
}

/** A file under an e2e suite root, at any depth. */
export function isE2ePath(filePath) {
  return E2E_ROOT.test(filePath);
}
