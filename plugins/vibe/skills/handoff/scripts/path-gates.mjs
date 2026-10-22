// Gates a repository requires when a diff touches given paths. Some gates
// read files by scanning them rather than by import, so neither graph test
// selection nor PR CI picks them; a prototype import the repo's catalog gate
// rejects merged that way and broke main.
//
// The repository declares them in `.vibe/path-gates.json`:
//   {"gates": [{"name": "catalog-imports", "paths": ["apps/prototypes/**"],
//               "command": "node apps/prototypes/scripts/check-catalog-imports.mjs"}]}
// A path is a prefix, or a glob with `*` (one segment) and `**` (any depth).
// Each gate a changed file matches becomes a required test whose path is the
// gate's command, so the evidence gate needs a passing run of that command on
// the published commit (`testRuns` entry with `path` set to the command).

export const PATH_GATES_FILE = ".vibe/path-gates.json";

/** The gates' required-test entries for `files`; a missing or unreadable declaration requires none and says why. */
export function pathGateTests(files, read) {
  const text = read(PATH_GATES_FILE);
  if (text === null || text === undefined) {
    return [];
  }
  let gates;
  try {
    gates = JSON.parse(text).gates;
  } catch (error) {
    return [{ path: PATH_GATES_FILE, reason: `could not be parsed (${error instanceof Error ? error.message : String(error)}); fix it so its gates run` }];
  }
  if (!Array.isArray(gates)) {
    return [{ path: PATH_GATES_FILE, reason: "has no gates list; fix it so its gates run" }];
  }
  return gates.flatMap((gate) => {
    if (typeof gate?.command !== "string" || !Array.isArray(gate.paths)) {
      return [{ path: PATH_GATES_FILE, reason: `gate ${JSON.stringify(gate?.name ?? null)} needs a command and a paths list` }];
    }
    const matchers = gate.paths.map(pathMatcher);
    const hit = files.map((file) => file.path).find((file) => matchers.some((matches) => matches(file)));
    return hit ? [{ path: gate.command, reason: `${gate.name ?? "a path gate"} in ${PATH_GATES_FILE}: ${hit} changed; record a passing run of this command on the published commit` }] : [];
  });
}

/** A prefix, or a glob with `*` (one segment) and `**` (any depth), as a predicate over repo paths. */
export function pathMatcher(pattern) {
  if (!pattern.includes("*")) {
    return (file) => file === pattern || file.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`);
  }
  const source = pattern.split("**").map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*");
  const regex = new RegExp(`^${source}$`);
  return (file) => regex.test(file);
}
