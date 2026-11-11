#!/usr/bin/env node
// One evidence file for `vibe-requirements-worker`:
// the request's own references resolved against the worktree, and a ledger of
// which of the worker's required tracker and graph queries (the bound
// provider's `data.graph.requirementsQueries`; none without one) have a saved
// result and which are missing.
//
// The queries themselves are MCP calls this script cannot make, and there is
// no REST client to make them instead. So the worker still makes them; each result
// it saves as `<tool>.json` in `--results-dir` is bundled whole into the file,
// and every required query with no saved result is listed under `missing`, so a
// requirements brief never silently lacks an overlap or in-flight check. What it
// removes is the worker's mechanical reading of the worktree: the references
// in the text (the bound tracker's slugs, else GitHub `#123` numbers), the
// paths it names that exist, their CODEOWNERS and feature map entries, and the
// files that already use its terms.
//
// Usage: req-gather.mjs --worktree <path> (--request <text> | --request-file <file>)
//                       [--results-dir <dir>] [--terms <t1,t2,...>] [--out <file>]
// Prints the evidence JSON (`vibe.req-evidence/1`); with --out writes it too.
// Exits 0 when every required query has a result, 3 when any is missing, 2 on
// a usage error.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createGraphPack } from "./graph-pack.mjs";
import { execCommand, parseJson, stdoutOf } from "./ws3-exec.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { boundWith, providerDataOr, sessionBinding } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const EVIDENCE_SCHEMA = "vibe.req-evidence/1";
const MAX_RESULT_BYTES = 200_000;
const GITHUB_NUMBER = /(?<![\w/&])#\d+\b/g;
const PATH_TOKEN = /(?:[\w@.-]+\/)+[\w@.-]*/g;
const MAX_PATHS = 25;
const NOT_JSON = Symbol("not json");

/**
 * The queries the requirements worker owes for `binding`: the bound graph provider's list, without the tracker's
 * own queries when no tracker is bound; none without a graph provider.
 */
export function requiredQueries(binding) {
  const tracker = new Set(boundWith(binding, "tickets") ? [] : providerDataOr(binding, "graph", "trackerQueries", []));
  return Object.freeze(providerDataOr(binding, "graph", "requirementsQueries", []).filter((name) => !tracker.has(name)));
}

/**
 * Every reference in `text`, once each, in order of first mention: the bound tracker's slugs
 * (`data.tickets.mentionPattern`), else GitHub `#123` numbers.
 */
export function slugsIn(text, binding = null) {
  const pattern = providerDataOr(binding, "tickets", "mentionPattern", null);
  return [...new Set(text.match(pattern ? new RegExp(pattern, "g") : GITHUB_NUMBER) ?? [])];
}

/** Path-like tokens in `text` that name a tracked file or a folder holding tracked files. */
export function pathsIn(text, tracked) {
  const found = [];
  for (const token of text.match(PATH_TOKEN) ?? []) {
    const cleaned = token.replace(/[.,;:)]+$/, "").replace(/^\.\//, "");
    if (!cleaned.includes("/") || found.includes(cleaned)) continue;
    const isFile = tracked.has(cleaned);
    const isFolder = !isFile && [...tracked].some((file) => file.startsWith(cleaned.endsWith("/") ? cleaned : `${cleaned}/`));
    if (isFile || isFolder) found.push(cleaned);
    if (found.length >= MAX_PATHS) break;
  }
  return found;
}

/** The saved results for each required query: present (parsed, truncated flag) or missing. */
export function readResults(dir, { exists = existsSync, read = (file) => readFileSync(file, "utf8"), size = (file) => statSync(file).size } = {},
  required = []) {
  const results = {};
  const present = [];
  const missing = [];
  const unreadable = [];
  for (const name of required) {
    const file = dir ? path.join(dir, `${name}.json`) : null;
    if (!file || !exists(file)) { missing.push(name); continue; }
    if (size(file) > MAX_RESULT_BYTES) { unreadable.push({ name, reason: `the saved result is over ${MAX_RESULT_BYTES} bytes; save the part the brief needs` }); missing.push(name); continue; }
    const parsed = parseJson(read(file), NOT_JSON);
    if (parsed === NOT_JSON) { unreadable.push({ name, reason: "the saved result is not JSON" }); missing.push(name); continue; }
    results[name] = parsed;
    present.push(name);
  }
  return { results, present, missing, unreadable };
}

export function gatherEvidence({ worktree, request, resultsDir, terms = [] }, deps = {}) {
  const run = deps.run ?? execCommand;
  const binding = deps.binding === undefined ? sessionBinding(worktree) : deps.binding;
  const required = requiredQueries(binding);
  const tracked = new Set(stdoutOf(run("git", ["-C", worktree, "ls-files"]), "git ls-files").split("\n").filter(Boolean));
  const paths = pathsIn(request, tracked);
  const pack = (deps.graphPack ?? createGraphPack({ run, binding })).pack({ worktree, paths, terms });
  const queries = readResults(resultsDir, deps.fs, required);
  return {
    schema: EVIDENCE_SCHEMA,
    head: pack.head,
    slugs: slugsIn(request, binding),
    paths: pack.paths.map(({ path: file, kind, tracked: isTracked, owner, featureMap }) => ({ path: file, kind, tracked: isTracked, owner, featureMap })),
    precedents: pack.precedents,
    queries: { required: [...required], present: queries.present, missing: queries.missing, unreadable: queries.unreadable },
    results: queries.results,
  };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, request: { type: "string" }, "request-file": { type: "string" },
    "results-dir": { type: "string" }, terms: { type: "string" }, out: { type: "string" },
  } });
  if (!values.worktree || (!values.request && !values["request-file"])) throw new Error("--worktree and --request or --request-file are required.");
  const request = values.request ?? readFileSync(values["request-file"], "utf8");
  const terms = (values.terms ?? "").split(",").map((term) => term.trim()).filter(Boolean);
  const evidence = gatherEvidence({ worktree: path.resolve(values.worktree), request, resultsDir: values["results-dir"], terms });
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, text);
  }
  process.stdout.write(text);
  return evidence.queries.missing.length === 0 ? 0 : 3;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
