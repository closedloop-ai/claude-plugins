// A repository's own commands, for the steps that run them when no provider recipe names one: the test command its
// AGENTS.md documents and the install its lockfile asks for.

const AGENTS_TEST_COMMAND = /`((?:pnpm|npm|yarn|bun|npx|uv|uvx|make|just|cargo|go|pytest|python3?|bundle|mvn|gradle|\.\/[\w./-]+)\b[^`\n]*test[^`\n]*)`/;

/** The test command an AGENTS.md names: the first command code span on a line about tests, or null. */
export function agentsTestCommand(text) {
  for (const line of String(text ?? "").split("\n")) {
    if (!/test/i.test(line)) continue;
    const found = AGENTS_TEST_COMMAND.exec(line);
    if (found) return found[1].trim();
  }
  return null;
}

/** The install each lockfile asks for, in the order a repository with several is read: `[lockfile, program, args]`. */
export const LOCKFILE_INSTALLS = Object.freeze([
  ["pnpm-lock.yaml", "pnpm", ["install", "--frozen-lockfile"]],
  ["yarn.lock", "yarn", ["install", "--frozen-lockfile"]],
  ["bun.lock", "bun", ["install", "--frozen-lockfile"]],
  ["bun.lockb", "bun", ["install", "--frozen-lockfile"]],
  ["package-lock.json", "npm", ["ci"]],
]);
