import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MatchStatus, matchAssignee, usersFromPages } from "./match-assignee.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "match-assignee.mjs");
const ADA = { id: "u-ada", firstName: "Ada", lastName: "Lovelace", email: "ada.lovelace@example.com", role: "ENGINEER" };
const ADA_K = { id: "u-adak", firstName: "Ada", lastName: "King", email: "ada.king@example.com", role: "MEMBER" };
const GRACE = { id: "u-grace", firstName: "Grace", lastName: "Hopper", email: "grace@example.com", role: "MEMBER" };
const NAMELESS = { id: "u-nameless", firstName: null, lastName: null, email: "ops@example.com", role: "MEMBER" };
const USERS = [ADA, ADA_K, GRACE, NAMELESS];

/** A `list-users` response as the ClosedLoop MCP returns it. */
const page = (items, { offset = 0, total = USERS.length } = {}) => ({
  total,
  offset,
  limit: items.length,
  returned: items.length,
  hasMore: offset + items.length < total,
  nextOffset: offset + items.length,
  items,
});

test("a full name names exactly one user", () => {
  assert.deepEqual(matchAssignee("Grace Hopper", USERS), {
    query: "Grace Hopper",
    status: MatchStatus.One,
    matches: [{ id: "u-grace", name: "Grace Hopper", email: "grace@example.com" }],
  });
  assert.equal(matchAssignee("Lovelace", USERS).matches[0].id, "u-ada");
});

test("a shared first name returns every user who has it", () => {
  const result = matchAssignee("Ada", USERS);
  assert.equal(result.status, MatchStatus.Several);
  assert.deepEqual(result.matches, [
    { id: "u-adak", name: "Ada King", email: "ada.king@example.com" },
    { id: "u-ada", name: "Ada Lovelace", email: "ada.lovelace@example.com" },
  ]);
});

test("a name nobody has, or only part of one, matches no one", () => {
  for (const query of ["Linus", "Gra", "Hopper Grace", "grace@example"]) {
    assert.deepEqual(matchAssignee(query, USERS), { query, status: MatchStatus.None, matches: [] }, query);
  }
});

test("an email names its user, which settles a shared first name", () => {
  assert.deepEqual(matchAssignee("ada.king@example.com", USERS).matches, [
    { id: "u-adak", name: "Ada King", email: "ada.king@example.com" },
  ]);
  assert.deepEqual(matchAssignee("ops@example.com", USERS).matches, [
    { id: "u-nameless", name: "ops@example.com", email: "ops@example.com" },
  ]);
});

test("case and extra spaces do not matter", () => {
  for (const query of ["grace hopper", "GRACE HOPPER", "  Grace   Hopper ", "GRACE@EXAMPLE.COM", "hopper"]) {
    assert.equal(matchAssignee(query, USERS).status, MatchStatus.One, query);
    assert.equal(matchAssignee(query, USERS).matches[0].id, "u-grace", query);
  }
});

test("an empty name is refused rather than matched", () => {
  assert.throws(() => matchAssignee("   ", USERS), /empty/);
});

test("users are read from every page once, and a page set missing anyone is refused", () => {
  const pages = [page([ADA, ADA_K]), page([GRACE, NAMELESS], { offset: 2 })];
  assert.deepEqual(
    usersFromPages(pages).map((user) => user.id),
    USERS.map((user) => user.id)
  );
  assert.equal(usersFromPages([...pages, page([GRACE], { offset: 2 })]).length, USERS.length);
  assert.throws(() => usersFromPages([page([ADA, ADA_K])]), /2 of 4 users/);
  assert.throws(() => usersFromPages([page([ADA], { total: 4 }), page([GRACE], { offset: 1, total: 5 })]), /disagree/);
  assert.throws(() => usersFromPages([]), /No list-users pages/);
  assert.throws(() => usersFromPages([{ items: [ADA] }]), /no items array or total/);
  assert.throws(() => usersFromPages([page([{ ...ADA, id: "" }], { total: 1 })]), /no id/);
});

test("the CLI matches across saved pages and fails on a partial set", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "match-assignee-"));
  const first = path.join(dir, "page-0.json");
  const second = path.join(dir, "page-1.json");
  writeFileSync(first, JSON.stringify(page([ADA, ADA_K])));
  writeFileSync(second, JSON.stringify(page([GRACE, NAMELESS], { offset: 2 })));

  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const found = run("--name", "grace hopper", "--users", first, "--users", second);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).matches[0].id, "u-grace");

  const partial = run("--name", "grace hopper", "--users", first);
  assert.equal(partial.status, 1);
  assert.match(JSON.parse(partial.stdout).error, /hasMore is false/);

  const missingName = run("--users", first, "--users", second);
  assert.equal(missingName.status, 1);
  assert.match(JSON.parse(missingName.stdout).error, /--name is required/);
});
