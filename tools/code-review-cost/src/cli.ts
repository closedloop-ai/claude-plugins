/**
 * Shared CLI entry helper: run main() only when executed directly (not when
 * imported by tests), mirroring Python's `if __name__ == "__main__"`.
 *
 * CANONICAL SOURCE: tools/design-inventory/src/cli.ts. This is a deliberate
 * verbatim copy. The two tool packages are self-contained and bundle
 * independently (separate package.json / tsconfig / esbuild target) with no
 * shared module, so this ~10-line bootstrap is duplicated rather than
 * cross-imported across package boundaries. Keep the copies in lockstep: land
 * any change to the helper (e.g. a synchronous-throw guard) in the
 * design-inventory copy first, then mirror it here verbatim.
 */

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
