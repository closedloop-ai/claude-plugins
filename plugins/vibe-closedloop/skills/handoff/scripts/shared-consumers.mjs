// A fix aimed at one host of a shared component once changed it for every
// host: a flag-off branch inside the shared grid stripped a control from all
// flag-off hosts, a sibling surface lost what main ships, and the consumers'
// tests went red after the push. diff-rules.mjs runs this.
//
// A UI component the diff changes is shared when two or more non-test files
// import it. Every test or story file that imports it, or imports one of its
// consumers, becomes a required run. When the change reads a feature flag,
// each of those runs is needed with the flag on and with it off (`flagStates`;
// a `testRuns` entry carries `flag: "on"` or `flag: "off"`), and the diff
// blocks until the change log records which host the behavior is keyed on.

import { isTestFile } from "../../vibe/scripts/test-files.mjs";

const COMPONENT = /\.[jt]sx$/;
const STORY = /\.stories\.[jt]sx?$/;
const FLAG = /\b(?:use)?[Ff]eature[Ff]lag\w*|\bFeatureFlagged\b|\bflag(?:Enabled|Off|On|Key)?\b|\bisFlagEnabled\b/;
export const FLAG_STATES = ["on", "off"];

/** Required runs for the consumers of every shared component the diff changes, and the flag-branch finding. */
export function sharedComponentTests(files, repo, logged, add) {
  const changed = files.filter((file) => file.status === "M" && COMPONENT.test(file.path) && !isTestFile(file.path) && !STORY.test(file.path)
    && file.added.length + file.removed.length > 0);
  if (changed.length === 0) return [];
  const importers = repo.importersOf(changed.map((file) => file.path));
  const required = new Map();
  for (const file of changed) {
    const all = [...(importers.get(file.path) ?? [])];
    const consumers = all.filter((hit) => !isTestFile(hit) && !STORY.test(hit));
    if (consumers.length < 2) continue;
    const suites = new Set(all.filter((hit) => isTestFile(hit) || STORY.test(hit)));
    for (const hits of repo.importersOf(consumers).values()) {
      for (const hit of hits) if (isTestFile(hit) || STORY.test(hit)) suites.add(hit);
    }
    const flagged = [...file.added, ...file.removed].some((entry) => FLAG.test(entry.text));
    for (const suite of [...suites].sort()) {
      const previous = required.get(suite);
      required.set(suite, {
        path: suite,
        reason: `covers a consumer of the shared ${file.path} (${consumers.length} hosts import it); run every host's suite, not only the one the fix aims at`,
        ...(flagged || previous?.flagStates ? { flagStates: FLAG_STATES } : {}),
      });
    }
    if (flagged && !logged("Shared behavior:", file.path)) {
      const line = file.added.find((entry) => FLAG.test(entry.text))?.line ?? file.added[0]?.line ?? 1;
      add("shared-flag-branch", file.path, line, `changes flag-dependent behavior inside a component ${consumers.length} hosts share, so every flag-off host changes with it`, "key the behavior on the host (a prop or slot the one host passes), never a global flag branch, then record `Shared behavior: <file>: keyed on <prop>; hosts run: <each host's suite>`");
    }
  }
  return [...required.values()];
}
