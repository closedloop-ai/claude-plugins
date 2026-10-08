import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWhenMain } from "../../shared/cli.js";

/** A symlinked plugin entry is still direct execution, including macOS temporary paths. */
export function runFromCanonicalEntry(metaUrl: string, main: (argv: string[]) => number | Promise<number>): void {
  const entry = process.argv[1];
  if (!entry || realpathSync(fileURLToPath(metaUrl)) !== realpathSync(entry)) return;
  runWhenMain(pathToFileURL(entry).href, main);
}
