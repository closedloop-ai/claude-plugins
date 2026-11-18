// Test-file classification shared by the handoff inventory and the retired-test
// record. Root web and Desktop specs live outside the session's app paths.

// The root e2e folder, plus the repository's other root test folders (the provider's layout recipe).
import { repositoryLayout } from "./area-paths.mjs";

export const ROOT_TEST_PREFIXES = ["e2e/"];
export const TEST_SPEC_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
// A pytest module: test_*.py or *_test.py.
const PYTHON_TEST_PATTERN = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;
const TEST_SUPPORT_PATTERN = /(?:^|\/)(?:__tests__|__fixtures__|__mocks__|__snapshots__|fixtures)\//;
const SNAPSHOT_PATTERN = /\.snap$/;
// An e2e suite root is any directory named `e2e`, `e2e-*` or `*-e2e` (web, Desktop, smoke and walk suites alike).
const E2E_ROOT = /(?:^|\/)(?:e2e|e2e[-_][^/]+|[^/]+[-_]e2e)\//;
// The same suite roots, but only inside one of their folders: the suite root holds the harness, not support.
const E2E_SUPPORT_DIR = /(?:^|\/)(?:e2e|e2e[-_][^/]+|[^/]+[-_]e2e)\/[^/]+\//;
export const E2E_ROOT_PATHSPECS = [":(glob)**/e2e/**", ":(glob)**/e2e[-_]*/**", ":(glob)**/*[-_]e2e/**"];

/** A spec, a file under a test support folder, or a snapshot. */
export function isTestFile(filePath) {
  return TEST_SPEC_PATTERN.test(filePath) || TEST_SUPPORT_PATTERN.test(filePath) || SNAPSHOT_PATTERN.test(filePath);
}

/** A file a test runner collects: a node or vitest spec, or a pytest module. Support folders and snapshots are not. */
export function isCollectedTestFile(filePath) {
  return TEST_SPEC_PATTERN.test(filePath) || PYTHON_TEST_PATTERN.test(filePath);
}

export function isSnapshot(filePath) {
  return SNAPSHOT_PATTERN.test(filePath);
}

/** A test under a root web or Desktop test directory, or under any e2e suite root. */
export function isRootTest(filePath) {
  return [...ROOT_TEST_PREFIXES, ...(repositoryLayout().rootTests ?? [])].some((prefix) => filePath.startsWith(prefix)) || isE2ePath(filePath);
}

/** A file under an e2e suite root, at any depth. */
export function isE2ePath(filePath) {
  return E2E_ROOT.test(filePath);
}

/**
 * A module an e2e suite's specs import: in a FOLDER under an e2e suite root, and neither a spec nor a snapshot.
 * A suite names that folder freely (`helpers/`, `perf/`, `fixtures/`), so recognising support by folder name alone
 * leaves a `helpers/` module outside every test class. The suite root itself is excluded because that is where the
 * harness lives -- the playwright config, the auth setup, the compose files -- and editing the harness is not a
 * test repair.
 */
export function isE2eTestSupport(filePath) {
  return E2E_SUPPORT_DIR.test(filePath) && !TEST_SPEC_PATTERN.test(filePath) && !SNAPSHOT_PATTERN.test(filePath);
}
