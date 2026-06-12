/** Shared CLI entry helper: run main() only when executed directly (not when
 * imported by tests), mirroring Python's `if __name__ == "__main__"`. */

import { pathToFileURL } from "node:url";

export function runWhenMain(metaUrl: string, main: (argv: string[]) => number | Promise<number>): void {
  const entry = process.argv[1];
  if (!entry) return;
  if (metaUrl !== pathToFileURL(entry).href) return;
  Promise.resolve(main(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
