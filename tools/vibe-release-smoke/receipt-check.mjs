#!/usr/bin/env node
// CI half of the vibe release smoke (ISS-13315). GitHub's runners cannot sign in to ChatGPT, so
// the smoke runs on a release author's Mac (`node tools/vibe-release-smoke/smoke.mjs --receipt`)
// and commits receipt.json. A change to plugins/vibe fails here until receipt.json records a
// passing smoke of exactly the plugins/vibe and plugins/closedloop-core trees being merged.
//
// Usage: node tools/vibe-release-smoke/receipt-check.mjs --base <ref>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const RECEIPT = "tools/vibe-release-smoke/receipt.json";
const SMOKE = "node tools/vibe-release-smoke/smoke.mjs --receipt";
const PLUGINS = ["vibe", "closedloop-core"];

/** Why the receipt does not cover `trees` ({vibe, "closedloop-core"} at HEAD), or null; nothing is needed without a vibe change. */
export function receiptProblem({ vibeChanged, receipt, trees }) {
  if (!vibeChanged) {
    return null;
  }
  if (!receipt) {
    return `plugins/vibe changed but ${RECEIPT} is missing or not JSON. Run \`${SMOKE}\` on a Mac with the ChatGPT app signed in, and commit ${RECEIPT}.`;
  }
  if (receipt.result !== "pass") {
    return `${RECEIPT} does not record a passing smoke. Run \`${SMOKE}\` and commit ${RECEIPT}.`;
  }
  const stale = PLUGINS.filter((name) => receipt.plugins?.[name]?.tree !== trees[name]);
  if (stale.length > 0) {
    return `${RECEIPT} was recorded for other ${stale.map((name) => `plugins/${name}`).join(" and ")} contents than this commit has (the smoke tests one exact build). Run \`${SMOKE}\` on this commit and commit ${RECEIPT}.`;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  if (!values.base) {
    process.stderr.write("--base <ref> is required\n");
    process.exit(2);
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const vibeChanged = git("diff", "--name-only", `${values.base}...HEAD`, "--", "plugins/vibe") !== "";
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(RECEIPT, "utf8"));
  } catch {
    // Reported below as missing.
  }
  const trees = Object.fromEntries(PLUGINS.map((name) => [name, git("rev-parse", `HEAD:plugins/${name}`)]));
  const problem = receiptProblem({ vibeChanged, receipt, trees });
  if (problem) {
    process.stdout.write(`::error::${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(vibeChanged ? `${RECEIPT} covers this commit's plugins/vibe (${trees.vibe}) and plugins/closedloop-core (${trees["closedloop-core"]}).\n` : "plugins/vibe did not change; no release smoke receipt is needed.\n");
}
