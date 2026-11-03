/**
 * erd-diagram CLI entry, bundled to plugins/closedloop-core/skills/erd-diagram/scripts/dist/erd.mjs.
 * Commands are documented in lib/cli.ts. The templates live two levels up from the bundle.
 */
import { fileURLToPath } from "node:url";
import { runWhenMain } from "../../shared/cli.js";
import { run } from "./lib/cli.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

runWhenMain(import.meta.url, (argv) =>
  run(argv, TEMPLATES_DIR, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  }),
);
