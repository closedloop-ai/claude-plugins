// Test-file classification shared by the handoff inventory and the retired-test
// record. Root web and Desktop specs live outside the session's app paths.

export const ROOT_TEST_PREFIXES = ["e2e/", "apps/desktop/test/"];
export const TEST_SPEC_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_SUPPORT_PATTERN = /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|__snapshots__|fixtures)\//;
const SNAPSHOT_PATTERN = /\.snap$/;

/** A spec, a file under a test support folder, or a snapshot. */
export function isTestFile(filePath) {
  return TEST_SPEC_PATTERN.test(filePath) || TEST_SUPPORT_PATTERN.test(filePath) || SNAPSHOT_PATTERN.test(filePath);
}

export function isSnapshot(filePath) {
  return SNAPSHOT_PATTERN.test(filePath);
}

export function isRootTest(filePath) {
  return ROOT_TEST_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}
