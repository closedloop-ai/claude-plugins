import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isProviderBroken } from "../../../plugins/vibe-core/lib/vibe/scripts/provider.mjs";
import { runWhenMain } from "../../shared/cli.js";

/** A symlinked plugin entry is still direct execution, including macOS temporary paths. */
export function runFromCanonicalEntry(metaUrl: string, main: (argv: string[]) => number | Promise<number>): void {
  const entry = process.argv[1];
  if (!entry || realpathSync(fileURLToPath(metaUrl)) !== realpathSync(entry)) return;
  runWhenMain(pathToFileURL(entry).href, providerAware(main));
}

/** `main`, answering a broken bound provider as provider.mjs does: one `provider-broken: ...` line on stdout and exit 4. */
export function providerAware(main: (argv: string[]) => number | Promise<number>): (argv: string[]) => Promise<number> {
  return async (argv) => {
    try {
      return await main(argv);
    } catch (error) {
      if (!isProviderBroken(error)) throw error;
      process.stdout.write(`provider-broken: ${(error as Error).message}\n`);
      return 4;
    }
  };
}
