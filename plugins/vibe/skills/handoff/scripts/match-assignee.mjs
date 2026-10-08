#!/usr/bin/env node
// Resolves the name or email the person gave at handoff to the ClosedLoop
// user who picks the work up next. Reads every page of ClosedLoop
// `list-users` the caller saved, verbatim, and refuses a set of pages that
// does not cover the whole organization, so a match is never made against a
// partial list. A user matches when the text equals their first name, last
// name, full name, or email, ignoring case and extra spaces. Prints one JSON
// object: `status` is `one`, `several`, or `none`, with every match's id,
// name, and email. Exits 0 when it could decide and 1 on bad input. Changes
// nothing.
//
// Usage: match-assignee.mjs --name "<what the person said>" --users <page.json> [--users <page.json> ...]

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const MatchStatus = { One: "one", Several: "several", None: "none" };

const WHITESPACE = /\s+/g;

/** Every user across the saved `list-users` pages, once each; throws when the pages miss anyone. */
export function usersFromPages(pages) {
  if (pages.length === 0) {
    throw new Error("No list-users pages were given.");
  }
  const users = new Map();
  let total = null;
  for (const page of pages) {
    if (!page || !Array.isArray(page.items) || !Number.isInteger(page.total)) {
      throw new Error("A list-users page has no items array or total.");
    }
    if (total !== null && page.total !== total) {
      throw new Error(`The list-users pages disagree on the total (${total} and ${page.total}); page them again.`);
    }
    total = page.total;
    for (const user of page.items) {
      if (typeof user?.id !== "string" || user.id === "") {
        throw new Error("A list-users item has no id.");
      }
      users.set(user.id, user);
    }
  }
  if (users.size < total) {
    throw new Error(`The pages hold ${users.size} of ${total} users; page list-users until hasMore is false.`);
  }
  return [...users.values()];
}

/** The users whose first name, last name, full name, or email is the given text. */
export function matchAssignee(query, users) {
  const wanted = normalize(query);
  if (wanted === "") {
    throw new Error("--name is empty.");
  }
  const matches = users
    .filter((user) => candidateKeys(user).includes(wanted))
    .map((user) => ({ id: user.id, name: fullName(user) || user.email, email: user.email ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { query: query.trim(), status: statusFor(matches.length), matches };
}

function candidateKeys(user) {
  return [user.firstName, user.lastName, fullName(user), user.email].map(normalize).filter((key) => key !== "");
}

function fullName(user) {
  return [user.firstName, user.lastName].filter((part) => typeof part === "string" && part.trim() !== "").join(" ");
}

function normalize(text) {
  return typeof text === "string" ? text.trim().replace(WHITESPACE, " ").toLowerCase() : "";
}

function statusFor(count) {
  if (count === 1) {
    return MatchStatus.One;
  }
  return count === 0 ? MatchStatus.None : MatchStatus.Several;
}

function main() {
  const { values } = parseArgs({
    options: { name: { type: "string" }, users: { type: "string", multiple: true } },
  });
  try {
    if (values.name === undefined) {
      throw new Error("--name is required.");
    }
    const pages = (values.users ?? []).map((file) => JSON.parse(readFileSync(path.resolve(file), "utf8")));
    const result = matchAssignee(values.name, usersFromPages(pages));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
