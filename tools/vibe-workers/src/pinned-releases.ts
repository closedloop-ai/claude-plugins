import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository checkout these tests run in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Released vibe 1.1.25, the installed writer the live upgrade test archives. */
export const VIBE_1_1_25_SHA = "f45882fb9118cca457221e48e7cef850557f8246";

/** Every release commit a test archives. Global setup makes each one present before any test runs. */
export const PINNED_RELEASE_SHAS: readonly string[] = [VIBE_1_1_25_SHA];
