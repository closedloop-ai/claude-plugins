#!/usr/bin/env node
// The fleet board: what every writer is doing, and what each writer or QA
// guide must be told. Writers that could not see each other's work collided,
// a QA guide never heard that its checkpoint was ready, and a UX ruling
// reached one writer as text while another PR rendered the same behavior.
//
// Usage: board.mjs <orchDir> writer <name> [--pr <n>] [--repo <owner/repo>] [--head <sha>] [--status <text>] [--deps <a,b>] [--runtime codex|claude]
//        board.mjs <orchDir> deliver <item> --to <a,b> [--kind ruling|checkpoint|note] [--reference <file>] [--head <sha>]
//        board.mjs <orchDir> told <item> <recipient>
//        board.mjs <orchDir> duty <duty> --owner <writer or helper>
//        board.mjs <orchDir> status [--pushed <name>=<sha>]... [--threads <name>=<n>]...
//
// `writer` adds or updates a writer's row (owner, PR, head, status,
// dependencies). `deliver` records something each recipient must be told
// directly (a ruling saved once as a reference file, a QA checkpoint that is
// ready); `told` marks one recipient told. Every write re-renders
// <orchDir>/board.md, the page every writer reads, with a log line.
//
// `status` prints `STALE <writer> board head <a>, pushed <b>` for a row whose
// head differs from the PR's pushed head (`--pushed`, or `gh pr view` for rows
// with a PR and repo; `BOARD_GH` overrides the gh binary), and
// `UNTOLD <item> <recipient>` for each recipient not yet told, then
// `board: <writers> writers, <stale> stale, <untold> untold`; exits 1 when any.
//
// A standing duty (main's post-merge health, a PR shepherd, the watcher) has a
// named owner (`duty`). Main's health once went unwatched for an hour after its
// owner was stopped with no replacement. `status` prints `UNOWNED-DUTY <duty>
// owner <who> <why>` when the owner is neither a board writer nor a running
// helper in helpers.json, and helpers.mjs refuses to stop an owner.
// A Codex writer (`--runtime codex`) whose head has not moved for 30 minutes
// while its PR has unresolved human review threads (`--threads`, or read with
// `gh api graphql` for rows with a PR and repo) prints `SLOW <writer> ...`:
// hand it to a Claude writer. One spent 35 minutes on nine threads without a push.
// Both count toward the exit status.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const STATE = "board.json";
const PAGE = "board.md";
const KINDS = new Set(["ruling", "checkpoint", "note"]);
const LOG_LINES = 50;
const RUNTIMES = new Set(["codex", "claude"]);
const SLOW_MINUTES = 30;
const BOTS = new RegExp(process.env.BOT_LOGIN_REGEX || "vercel|codex|github-actions|copilot|bot", "i");

/** Rows whose recorded head differs from the pushed head; a row with no known pushed head is not judged. */
export function staleRows(board, pushed) {
  return Object.entries(board.writers)
    .filter(([name, row]) => pushed[name] && row.head !== pushed[name])
    .map(([name, row]) => ({ name, head: row.head ?? "none", pushed: pushed[name] }));
}

/** Codex writers whose head has not moved for SLOW_MINUTES while their PR has unresolved human threads. */
export function slowRows(board, threads, now) {
  return Object.entries(board.writers)
    .filter(([name, row]) => row.runtime === "codex" && threads[name] > 0 && row.headAt && now - Date.parse(row.headAt) >= SLOW_MINUTES * 60_000)
    .map(([name, row]) => ({ name, minutes: Math.floor((now - Date.parse(row.headAt)) / 60_000), threads: threads[name] }));
}

/** Duties whose owner is not a board writer and not a started, unstopped helper. */
export function unownedDuties(board, helpers) {
  return Object.entries(board.duties).flatMap(([duty, { owner }]) => {
    if (board.writers[owner]) return [];
    const helper = helpers[owner];
    if (helper?.startedAt && !helper.stoppedAt) return [];
    return [{ duty, owner, why: helper?.stoppedAt ? `stopped ${helper.stoppedAt}` : "is not a writer or a running helper" }];
  });
}

/** Every recipient of every delivery not yet told. */
export function untold(board) {
  return Object.entries(board.deliveries).flatMap(([item, delivery]) =>
    delivery.to.filter((recipient) => !delivery.told[recipient]).map((recipient) => ({ item, recipient, delivery })));
}

/** The page writers read. */
export function render(board) {
  const rows = Object.entries(board.writers).map(([name, row]) =>
    `| ${name} | ${row.pr ? `${row.repo ?? ""}#${row.pr}` : ""} | ${row.head ?? ""} | ${row.status ?? ""} | ${(row.deps ?? []).join(", ")} | ${row.updatedAt} |`);
  const open = untold(board).map(({ item, recipient, delivery }) =>
    `- ${item} (${delivery.kind}) for ${recipient}${delivery.reference ? `: ${delivery.reference}` : ""}${delivery.head ? ` at ${delivery.head}` : ""}`);
  const duties = Object.entries(board.duties).map(([duty, { owner, at }]) => `- ${duty}: ${owner} (since ${at})`);
  return [
    "# Fleet board",
    "",
    "| Writer | PR | Head | Status | Depends on | Updated |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Standing duties",
    "",
    ...(duties.length > 0 ? duties : ["- none"]),
    "",
    "## Not yet told",
    "",
    ...(open.length > 0 ? open : ["- nothing"]),
    "",
    "## Log",
    "",
    ...board.log.slice(-LOG_LINES).map((line) => `- ${line}`),
    "",
  ].join("\n");
}

function read(orchDir) {
  const file = path.join(orchDir, STATE);
  const board = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { writers: board.writers ?? {}, deliveries: board.deliveries ?? {}, duties: board.duties ?? {}, log: board.log ?? [] };
}

function write(orchDir, board, line, at) {
  board.log.push(`${at} ${line}`);
  board.log = board.log.slice(-LOG_LINES);
  for (const [name, text] of [[STATE, `${JSON.stringify(board, null, 2)}\n`], [PAGE, render(board)]]) {
    const file = path.join(orchDir, name);
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  }
}

function list(text) {
  return (text ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}

function ghHead(row) {
  try {
    return execFileSync(process.env.BOARD_GH || "gh", ["pr", "view", String(row.pr), "-R", row.repo, "--json", "headRefOid", "-q", ".headRefOid"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).trim() || null;
  } catch {
    return null;
  }
}

const THREADS_QUERY = "query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}";

/** Unresolved review threads a human opened, or null when gh cannot answer. */
function ghThreads(row) {
  const [owner, name] = row.repo.split("/");
  try {
    const out = execFileSync(process.env.BOARD_GH || "gh", ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `p=${row.pr}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 });
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.filter((node) => !node.isResolved && !BOTS.test(node.comments?.nodes?.[0]?.author?.login ?? "bot")).length;
  } catch {
    return null;
  }
}

function pairs(texts, flag) {
  return Object.fromEntries(texts.map((pair) => {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new Error(`${flag} needs <name>=<value>, got ${pair}`);
    }
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
}

function threadCounts(board, texts) {
  const threads = Object.fromEntries(Object.entries(pairs(texts, "--threads")).map(([name, n]) => [name, Number(n)]));
  for (const [name, row] of Object.entries(board.writers)) {
    if (threads[name] === undefined && row.runtime === "codex" && row.pr && row.repo) {
      const count = ghThreads(row);
      if (count !== null) threads[name] = count;
    }
  }
  return threads;
}

function readHelpers(orchDir) {
  const file = path.join(orchDir, "helpers.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function pushedHeads(board, texts) {
  const pushed = pairs(texts, "--pushed");
  for (const [name, row] of Object.entries(board.writers)) {
    if (!pushed[name] && row.pr && row.repo) {
      const head = ghHead(row);
      if (head) pushed[name] = head;
    }
  }
  return pushed;
}

function main(argv) {
  const [orchDir, action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pr: { type: "string" }, repo: { type: "string" }, head: { type: "string" }, status: { type: "string" }, deps: { type: "string" },
      to: { type: "string" }, kind: { type: "string" }, reference: { type: "string" },
      pushed: { type: "string", multiple: true }, threads: { type: "string", multiple: true }, now: { type: "string" },
      runtime: { type: "string" }, owner: { type: "string" },
    },
  });
  if (!orchDir || !["writer", "deliver", "told", "duty", "status"].includes(action)) {
    throw new Error("Usage: board.mjs <orchDir> writer|deliver|told|duty|status ...");
  }
  const board = read(orchDir);
  const now = values.now ? Date.parse(values.now) : Date.now();
  const at = new Date(now).toISOString();
  if (action === "status") {
    const stale = staleRows(board, pushedHeads(board, values.pushed ?? []));
    for (const row of stale) process.stdout.write(`STALE ${row.name} board head ${row.head}, pushed ${row.pushed}\n`);
    const open = untold(board);
    for (const entry of open) process.stdout.write(`UNTOLD ${entry.item} ${entry.recipient}\n`);
    const slow = slowRows(board, threadCounts(board, values.threads ?? []), now);
    for (const row of slow) {
      process.stdout.write(`SLOW ${row.name} no push for ${row.minutes}m with ${row.threads} unresolved human threads; hand it to a Claude writer\n`);
    }
    const duties = unownedDuties(board, readHelpers(orchDir));
    for (const entry of duties) process.stdout.write(`UNOWNED-DUTY ${entry.duty} owner ${entry.owner} ${entry.why}\n`);
    process.stdout.write(`board: ${Object.keys(board.writers).length} writers, ${stale.length} stale, ${open.length} untold, ${slow.length} slow, ${duties.length} unowned duties\n`);
    return stale.length + open.length + slow.length + duties.length === 0 ? 0 : 1;
  }
  const [name, recipient] = positionals;
  if (!name) {
    throw new Error(`${action} needs a name.`);
  }
  if (action === "duty") {
    if (!values.owner) {
      throw new Error("duty needs --owner <writer or helper>; a standing duty is never left without one.");
    }
    board.duties[name] = { owner: values.owner, at };
    write(orchDir, board, `duty ${name}: ${values.owner}`, at);
    return 0;
  }
  if (action === "writer") {
    if (values.runtime !== undefined && !RUNTIMES.has(values.runtime)) {
      throw new Error("--runtime must be codex or claude.");
    }
    const row = board.writers[name] ?? {};
    const update = Object.fromEntries(Object.entries({ pr: values.pr, repo: values.repo, head: values.head, status: values.status, runtime: values.runtime })
      .filter(([, value]) => value !== undefined));
    const moved = values.head !== undefined && values.head !== row.head;
    board.writers[name] = { ...row, ...update, ...(values.deps === undefined ? {} : { deps: list(values.deps) }), ...(moved ? { headAt: at } : {}), updatedAt: at };
    write(orchDir, board, `${name}: ${Object.entries(update).map(([key, value]) => `${key} ${value}`).join(", ") || "touched"}`, at);
    return 0;
  }
  if (action === "deliver") {
    const to = list(values.to);
    const kind = values.kind ?? "note";
    if (to.length === 0 || !KINDS.has(kind)) {
      throw new Error("deliver needs --to <a,b> and a --kind of ruling, checkpoint or note.");
    }
    if (kind === "ruling" && !values.reference) {
      throw new Error("a ruling is saved once as a reference file (its screenshots beside it); pass --reference <file>.");
    }
    const previous = board.deliveries[name];
    board.deliveries[name] = {
      kind,
      to: [...new Set([...(previous?.to ?? []), ...to])],
      told: previous?.told ?? {},
      ...(values.reference ? { reference: values.reference } : {}),
      ...(values.head ? { head: values.head } : {}),
      at,
    };
    write(orchDir, board, `${name} (${kind}) for ${to.join(", ")}`, at);
    return 0;
  }
  const delivery = board.deliveries[name];
  if (!delivery || !recipient || !delivery.to.includes(recipient)) {
    throw new Error(`told needs a delivery and one of its recipients (${delivery ? delivery.to.join(", ") : "no such delivery"}).`);
  }
  delivery.told[recipient] = at;
  write(orchDir, board, `${recipient} told ${name}`, at);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
