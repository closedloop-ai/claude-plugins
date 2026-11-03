import { ensureGitCommits } from "../../shared/git-commit-fixture.mjs";
import { PINNED_RELEASE_SHAS, REPO_ROOT } from "./pinned-releases.js";

/**
 * Fetches the pinned release commits once, before any test starts and outside every test and
 * hook timeout. A depth-one CI checkout lacks them; fetching inside a `beforeAll` made that
 * hook's 10 s timeout depend on how fast GitHub served the fetch (ISS-13662).
 */
export default function setup() {
  ensureGitCommits(REPO_ROOT, PINNED_RELEASE_SHAS);
}
