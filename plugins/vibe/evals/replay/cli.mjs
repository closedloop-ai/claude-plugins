#!/usr/bin/env node
// Offline replay tooling. Every live step (checkout, running vibe or fleet,
// running the human tests, an llm judge) comes from a `--deps <module>` whose
// default export is the `deps` object named in runner.mjs and scorer.mjs (see
// live-deps.mjs for the factory); nothing here reaches ClosedLoop or GitHub by itself.
//
// Usage:
//   cli.mjs select      --tickets <tickets.json> [--per-class 3]
//   cli.mjs plan        --corpus <corpus.json> --arms baseline,candidate [--runs 3]
//   cli.mjs run         --corpus <corpus.json> --arms baseline,candidate [--runs 3] --deps <module>
//   cli.mjs score       --corpus <corpus.json> --records <records.json> --deps <module>
//                       [--graders <dir of <slug>/*.md>] [--uncertainty <labels.json>]
//   cli.mjs uncertainty --input <uncertainty.json>
//   cli.mjs report      --scores <scores.json> [--markdown]
// `--uncertainty` is a map keyed "<slug>/<arm>/<run>" to the input of uncertainty.mjs.
// JSON goes to stdout; `report --markdown` prints the table.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { buildReport, reportMarkdown } from "./baseline-report.mjs";
import { selectCorpus } from "./corpus-select.mjs";
import { loadGraders } from "./graders.mjs";
import { MIN_RUNS, planRuns, runReplay } from "./runner.mjs";
import { scoreRun } from "./scorer.mjs";
import { scoreUncertainty } from "./uncertainty.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tickets: { type: "string" }, corpus: { type: "string" }, records: { type: "string" }, scores: { type: "string" },
    input: { type: "string" }, arms: { type: "string" }, deps: { type: "string" }, graders: { type: "string" }, uncertainty: { type: "string" },
    "per-class": { type: "string" }, runs: { type: "string" }, markdown: { type: "boolean", default: false },
  },
});

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const need = (name) => values[name] ?? fail(`--${name} is required.`);
const armList = () => need("arms").split(",").map((name) => ({ name: name.trim() }));
const runCount = () => (values.runs === undefined ? MIN_RUNS : Number(values.runs));
const loadDeps = async () => (await import(pathToFileURL(path.resolve(need("deps"))).href)).default;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function score() {
  const deps = await loadDeps();
  const tickets = new Map(readJson(need("corpus")).map((ticket) => [ticket.slug, ticket]));
  const labels = values.uncertainty ? readJson(values.uncertainty) : {};
  const scores = [];
  for (const record of readJson(need("records"))) {
    const ticket = tickets.get(record.slug) ?? fail(`record for ${record.slug} has no ticket in the corpus.`);
    const gradersDir = values.graders ? path.join(values.graders, record.slug) : null;
    const graders = gradersDir && existsSync(gradersDir) ? loadGraders(gradersDir) : undefined;
    scores.push(await scoreRun({ ticket, record, deps: { ...deps, graders }, uncertaintyInput: labels[`${record.slug}/${record.arm}/${record.run}`] }));
  }
  return scores;
}

async function main() {
  switch (positionals[0]) {
    case "select":
      return selectCorpus(readJson(need("tickets")), { perClass: values["per-class"] === undefined ? 3 : Number(values["per-class"]) });
    case "plan":
      return planRuns({ corpus: readJson(need("corpus")), arms: armList(), runs: runCount() });
    case "run":
      return runReplay({ corpus: readJson(need("corpus")), arms: armList(), runs: runCount(), deps: await loadDeps() });
    case "score":
      return score();
    case "uncertainty":
      return scoreUncertainty(readJson(need("input")));
    case "report": {
      const report = buildReport(readJson(need("scores")));
      return values.markdown ? { markdown: reportMarkdown(report) } : report;
    }
    default:
      return fail("Use one of: select, plan, run, score, uncertainty, report.");
  }
}

const result = await main();
process.stdout.write(result?.markdown !== undefined ? result.markdown : `${JSON.stringify(result, null, 2)}\n`);
