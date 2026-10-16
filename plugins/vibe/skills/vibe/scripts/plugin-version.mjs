#!/usr/bin/env node
// The vibe startup version check (operator ruling, 2026-10-16): compares the
// installed vibe plugin with the version on the closedloop-ai marketplace's
// main branch and, when the installed one is older, prints the update
// commands for this harness. It never stops a session: every failure to learn
// the latest version (no network, a refused or slow request, an unreadable
// manifest) prints status `unknown` with the reason, and the exit code is
// always 0.
//
// Usage: plugin-version.mjs --runtime codex|claude [--codex <CLI>]
//                           [--plugin-root <dir>] [--latest-url <url>] [--timeout-ms <n>]
//
// Prints one JSON object:
//   {"status":"current","installed":"1.0.53","latest":"1.0.53"}
//   {"status":"outdated","installed":"1.0.52","latest":"1.0.53","update":["<command>", ...]}
//   {"status":"unknown","installed":"1.0.53","reason":"<why the check could not run>"}
//
// The installed version is the running plugin's own manifest, two folders
// above this skill (`.codex-plugin/plugin.json` in Codex,
// `.claude-plugin/plugin.json` in Claude Code). The latest version is the same
// manifest on claude-plugins `main`, the branch both harnesses' Git
// marketplaces install from. `--latest-url` (or VIBE_LATEST_MANIFEST_URL)
// replaces that address, for tests.

import { accessSync, constants, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MARKETPLACE = "closedloop-ai";
const RAW_MAIN = "https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/plugins/vibe";
export const MANIFESTS = { codex: ".codex-plugin/plugin.json", claude: ".claude-plugin/plugin.json" };
export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const DEFAULT_TIMEOUT_MS = 5_000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SAFE_WORD = /^[\w@%+=:,./-]+$/;

/** -1, 0 or 1 for two x.y.z versions, or null when either is not one. */
export function compareVersions(left, right) {
  const a = VERSION.exec(String(left ?? "").trim());
  const b = VERSION.exec(String(right ?? "").trim());
  if (!a || !b) {
    return null;
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** The commands that update vibe in this harness, already quoted for a shell. */
export function updateCommands(runtime, { codex = BUNDLED_CODEX, localMarketplace = null } = {}) {
  if (runtime === "claude") {
    return [
      `claude plugin marketplace update ${MARKETPLACE}`,
      `claude plugin update vibe@${MARKETPLACE}`,
    ];
  }
  const cli = shellWord(codex);
  // A local folder marketplace is not refreshed by `marketplace upgrade`
  // (INSTALL.md, "Updating"); its checkout is pulled instead.
  const refresh = localMarketplace
    ? `git -C ${shellWord(localMarketplace)} pull --ff-only`
    : `${cli} plugin marketplace upgrade ${MARKETPLACE}`;
  return [refresh, `${cli} plugin add vibe@${MARKETPLACE}`, `${cli} plugin add closedloop-core@${MARKETPLACE}`];
}

/** The check's result for an installed version and a fetched latest manifest's text. */
export function decide({ installed, latestText, runtime, codex, localMarketplace = () => null }) {
  let latest;
  try {
    latest = JSON.parse(latestText).version;
  } catch {
    return { status: "unknown", installed, reason: "the latest manifest is not JSON" };
  }
  const order = compareVersions(installed, latest);
  if (order === null) {
    return { status: "unknown", installed, reason: `cannot compare ${installed} with ${latest}` };
  }
  if (order < 0) {
    return { status: "outdated", installed, latest, update: updateCommands(runtime, { codex, localMarketplace: localMarketplace() }) };
  }
  return { status: "current", installed, latest };
}

/** Runs the whole check; never throws. */
export async function checkVersion({
  runtime,
  pluginRoot,
  latestUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  codex,
  fetchImpl = fetch,
}) {
  let installed;
  try {
    installed = JSON.parse(readFileSync(path.join(pluginRoot, MANIFESTS[runtime]), "utf8")).version;
  } catch (error) {
    return { status: "unknown", installed: null, reason: `the installed manifest could not be read: ${error.message}` };
  }
  let latestText;
  try {
    const response = await fetchImpl(latestUrl ?? `${RAW_MAIN}/${MANIFESTS[runtime]}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { status: "unknown", installed, reason: `the marketplace answered ${response.status}` };
    }
    latestText = await response.text();
  } catch (error) {
    return { status: "unknown", installed, reason: `the marketplace could not be reached: ${error.message}` };
  }
  const cli = runtime === "codex" ? (codex ?? findCodex()) : undefined;
  // Asked only when an update is needed, so a current install starts no CLI.
  const localMarketplace = () => (runtime === "codex" ? codexLocalMarketplace(cli) : null);
  return decide({ installed, latestText, runtime, codex: cli, localMarketplace });
}

/** The folder of a local Codex marketplace vibe was installed from, or null for a Git one or when unknown. */
export function codexLocalMarketplace(codex) {
  try {
    const listed = JSON.parse(execFileSync(codex, ["plugin", "list", "--json"], { encoding: "utf8", timeout: 10_000 }));
    const vibe = (listed.installed ?? []).find((plugin) => plugin.pluginId === `vibe@${MARKETPLACE}`);
    const source = vibe?.marketplaceSource;
    return source?.sourceType === "local" && typeof source.source === "string" ? source.source : null;
  } catch {
    return null;
  }
}

function findCodex() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "codex");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not on this PATH entry.
    }
  }
  return BUNDLED_CODEX;
}

function shellWord(word) {
  return SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string" },
      codex: { type: "string" },
      "plugin-root": { type: "string" },
      "latest-url": { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  if (!(values.runtime in MANIFESTS)) {
    process.stdout.write(`${JSON.stringify({ status: "unknown", installed: null, reason: "--runtime must be codex or claude" })}\n`);
    return;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const timeoutMs = Number(values["timeout-ms"]);
  const result = await checkVersion({
    runtime: values.runtime,
    pluginRoot: values["plugin-root"] ?? path.resolve(scriptDir, "..", "..", ".."),
    latestUrl: values["latest-url"] ?? process.env.VIBE_LATEST_MANIFEST_URL,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    codex: values.codex,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "unknown", installed: null, reason: error.message })}\n`);
  }
}
