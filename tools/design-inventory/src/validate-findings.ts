/**
 * Validate design-inventory findings.json / decisions.json documents.
 *
 * Usage:
 *     node validate-findings.mjs <file.json> [more.json ...] [--kind findings|decisions]
 *
 * Kind defaults to auto-detection: documents containing a top-level
 * "decisions" object are validated as decisions, everything else as findings.
 * Prints one line per error prefixed with the file name; exits 0 when all
 * files are valid, 1 on validation errors, 2 on unreadable/unparseable input.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { validateDecisions, validateFindings } from "./design-findings-schema.js";
import { runWhenMain } from "./cli.js";

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { kind: { type: "string", default: "auto" } },
  });
  const kindOption = String(values.kind);
  if (!["auto", "findings", "decisions"].includes(kindOption)) {
    console.error(`error: invalid --kind ${kindOption}`);
    return 2;
  }
  if (positionals.length === 0) {
    console.error("error: at least one JSON document is required");
    return 2;
  }

  let hadErrors = false;
  for (const name of positionals) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(name, "utf-8"));
    } catch (exc) {
      console.error(`${name}: unreadable: ${exc instanceof Error ? exc.message : String(exc)}`);
      return 2;
    }
    let kind = kindOption;
    if (kind === "auto") {
      kind =
        typeof doc === "object" && doc !== null && !Array.isArray(doc) && "decisions" in doc
          ? "decisions"
          : "findings";
    }
    const errors = kind === "decisions" ? validateDecisions(doc) : validateFindings(doc);
    for (const error of errors) {
      hadErrors = true;
      console.log(`${name}: ${error}`);
    }
    if (errors.length === 0) {
      console.log(`${name}: OK (${kind})`);
    }
  }
  return hadErrors ? 1 : 0;
}

runWhenMain(import.meta.url, main);
