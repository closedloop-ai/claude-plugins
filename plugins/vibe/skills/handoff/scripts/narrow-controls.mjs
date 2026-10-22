#!/usr/bin/env node
// Compares the interactive controls of one list row captured at a wide and at a
// narrow width, so a control the narrow row drops cannot pass review unseen.
//
// Input is two Playwright accessibility snapshots of the same row, as
// `control snapshot <row locator>` or `locator.ariaSnapshot()` writes them.
// Every wide control needs a narrow home: the same role and name in the narrow
// row, or a change log line naming where it went or who ruled it out:
//   Narrow home: button "Status: Open" -> button "More actions"
//   Narrow ruling: button "Favorite": <ticket, PRD or operator ruling>
// A home must name a control the narrow row has.
//
// Usage:
//   narrow-controls.mjs --wide <wide.yml> --narrow <narrow.yml> [--change-log <file> | --worktree <wt>]
// Prints {"ok", "wide", "narrow", "missing", "problems"}; exits 1 when any wide
// control has no narrow home or a change log line does not hold.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const INTERACTIVE = new Set(["button", "checkbox", "combobox", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
  "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
const NODE = /^\s*-\s+(.*)$/;
const ROLE_NAME = /^([a-z]+)(?:\s+("(?:[^"\\]|\\.)*"))?/;
const CONTROL = String.raw`([a-z]+)\s+("(?:[^"\\]|\\.)*")`;
const HOME_LINE = new RegExp(String.raw`^\s*(?:[-*]\s+)?Narrow home:\s*${CONTROL}\s*->\s*${CONTROL}\s*$`);
const RULING_LINE = new RegExp(String.raw`^\s*(?:[-*]\s+)?Narrow ruling:\s*${CONTROL}\s*:\s*(\S.*)$`);

/** The interactive controls of a Playwright aria snapshot, in order, as `role "name"` keys. */
export function snapshotControls(yaml) {
  const controls = [];
  for (const line of yaml.split("\n")) {
    const node = NODE.exec(line);
    if (!node) continue;
    let text = node[1];
    if (text.startsWith("'")) {
      const end = text.search(/'(?!')(?=\s*:?\s*$|:\s)/);
      text = text.slice(1, end > 0 ? end : undefined).replaceAll("''", "'");
    }
    const match = ROLE_NAME.exec(text);
    if (match && INTERACTIVE.has(match[1])) controls.push(key(match[1], match[2] ? JSON.parse(match[2]) : ""));
  }
  return controls;
}

/** Wide controls with no narrow home, after same-role-and-name matches, recorded homes and rulings. */
export function compareRows(wideYaml, narrowYaml, changeLog = "") {
  const wide = snapshotControls(wideYaml);
  const narrow = snapshotControls(narrowYaml);
  const unmatched = new Map();
  for (const control of narrow) unmatched.set(control, (unmatched.get(control) ?? 0) + 1);
  const left = wide.filter((control) => {
    const count = unmatched.get(control) ?? 0;
    if (count > 0) unmatched.set(control, count - 1);
    return count === 0;
  });
  const homes = new Map();
  const rulings = new Set();
  const problems = [];
  for (const line of changeLog.split("\n")) {
    const home = HOME_LINE.exec(line);
    const ruling = RULING_LINE.exec(line);
    if (home) {
      const host = key(home[3], JSON.parse(home[4]));
      if (narrow.includes(host)) homes.set(key(home[1], JSON.parse(home[2])), host);
      else problems.push(`${line.trim()}: the narrow row has no ${host}`);
    } else if (ruling) {
      rulings.add(key(ruling[1], JSON.parse(ruling[2])));
    }
  }
  const missing = left.filter((control) => !homes.has(control) && !rulings.has(control));
  return { ok: missing.length === 0 && problems.length === 0, wide, narrow, missing, problems };
}

function key(role, name) {
  return `${role} ${JSON.stringify(name)}`;
}

function changeLogText({ "change-log": file, worktree }) {
  const target = file ?? (worktree
    ? path.join(execFileSync("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(), "vibe-changes.md")
    : undefined);
  return target && existsSync(target) ? readFileSync(target, "utf8") : "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { wide: { type: "string" }, narrow: { type: "string" },
      "change-log": { type: "string" }, worktree: { type: "string" } } });
    if (!values.wide || !values.narrow) throw new Error("--wide and --narrow snapshot files are required");
    const result = compareRows(readFileSync(values.wide, "utf8"), readFileSync(values.narrow, "utf8"), changeLogText(values));
    if (result.wide.length === 0) result.problems.push("the wide snapshot has no interactive controls; capture the row itself");
    result.ok = result.ok && result.problems.length === 0;
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, problems: [error instanceof Error ? error.message : String(error)] }));
    process.exitCode = 1;
  }
}
