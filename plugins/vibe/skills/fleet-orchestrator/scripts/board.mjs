#!/usr/bin/env node
// The fleet board: what every writer is doing, and what each writer or QA
// guide must be told. Writers that could not see each other's work collided,
// a QA guide never heard that its checkpoint was ready, and a UX ruling
// reached one writer as text while another PR rendered the same behavior.
//
// Usage: board.mjs <orchDir> writer <name> [--pr <n>] [--repo <owner/repo>] [--head <sha>] [--ready <sha>] [--status <text>] [--deps <a,b>] [--runtime codex|claude]
//        board.mjs <orchDir> push-check <writer> --head <sha>
//        board.mjs <orchDir> deliver <item> --to <a,b> [--kind ruling|checkpoint|note] [--reference <file>] [--head <sha>]
//        board.mjs <orchDir> told <item> <recipient>
//        board.mjs <orchDir> duty <duty> --owner <writer or helper>
//        board.mjs <orchDir> question|answered|ack <writer> --id <question id> [--text <the question and its default>]
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
// Each duty in `REQUIRED_DUTIES` (config.env, space-separated; default
// `green-watch` and `status-sweep` once the work dir watches PRs in prs.txt)
// must have one:
// `status` prints `MISSING-DUTY <duty>` until it does. Merged program PRs once
// broke main's post-merge batch with nobody following it.
// A Codex writer (`--runtime codex`) whose head has not moved for 30 minutes
// while its PR has unresolved human review threads (`--threads`, or read with
// `gh api graphql` for rows with a PR and repo) prints `SLOW <writer> ...`:
// hand it to a Claude writer. One spent 35 minutes on nine threads without a push.
// A writer declares the head it calls push-ready (`writer <name> --ready
// <sha>`); `push-check` exits 1 unless the head you are about to push for it
// is that one. The orchestrator once pushed a writer's committed head while the
// writer was still fixing two regressions in it, and auto-merge took it.
// A writer records each question it sends you under an id (`question`), your
// answer echoes that id (`answered`), and the writer acknowledges it in its next
// status (`ack`). `status` prints `QUESTION-UNANSWERED <writer> <id> <m>m:
// <text>` once a question waited 15 minutes, and `UNACKED <writer> <id> <m>m`
// once an answer waited 15 minutes unacknowledged: escalate, for example by
// asking the operator to press Esc in that pane. A writer once held its PR six
// hours on an unanswered question, and answers to writers in long turns had to
// be sent three times.
// <orchDir> is a fleet home or a program dir (work-dir.mjs). `status` also prints
// fleet-home.mjs check's lines for a home, or for a flat dir that watches sessions or PRs.
// All of these count toward the exit status, as does `WATCHER-MISSING(<why>)` when the
// work dir watches sessions or PRs (sessions.txt or prs.txt) and its watcher is
// not running: a watcher left unarmed overnight let writers' questions sit
// unanswered for 7 hours.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { watcherState } from "../../codex-fleet-monitor/scripts/watcher.mjs";
import { readConfig, resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { homeProblems } from "./fleet-home.mjs";
import { readThreads } from "../../vibe/scripts/pr-threads.mjs";

const STATE = "board.json";
const PAGE = "board.md";
const KINDS = new Set(["ruling", "checkpoint", "note"]);
const LOG_LINES = 50;
const RUNTIMES = new Set(["codex", "claude"]);
const SLOW_MINUTES = 30;
const QUESTION_MINUTES = 15;
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

/** Questions unanswered, and answers unacknowledged, for QUESTION_MINUTES or more. */
export function lateQuestions(board, now) {
  const minutesSince = (at) => Math.floor((now - Date.parse(at)) / 60_000);
  const entries = Object.entries(board.questions).map(([key, entry]) => ({ writer: entry.writer ?? key, id: entry.id ?? "-", ...entry }));
  return {
    unanswered: entries.filter((entry) => !entry.answeredAt && minutesSince(entry.at) >= QUESTION_MINUTES)
      .map((entry) => ({ ...entry, minutes: minutesSince(entry.at) })),
    unacked: entries.filter((entry) => entry.answeredAt && minutesSince(entry.answeredAt) >= QUESTION_MINUTES)
      .map((entry) => ({ ...entry, minutes: minutesSince(entry.answeredAt) })),
  };
}

/** Required duties with no owner recorded. */
export function missingDuties(board, required) {
  return required.filter((duty) => !board.duties[duty]);
}

function requiredDuties(orchDir) {
  const configured = readConfig(resolveWorkDir(orchDir)).REQUIRED_DUTIES;
  if (configured !== undefined) return configured.split(/\s+/).filter(Boolean);
  return existsSync(path.join(orchDir, "prs.txt")) ? ["green-watch", "status-sweep"] : [];
}

/** Every recipient of every delivery not yet told. */
export function untold(board) {
  return Object.entries(board.deliveries).flatMap(([item, delivery]) =>
    delivery.to.filter((recipient) => !delivery.told[recipient]).map((recipient) => ({ item, recipient, delivery })));
}

/** The page writers read. */
export function render(board) {
  const rows = Object.entries(board.writers).map(([name, row]) =>
    `| ${name} | ${row.pr ? `${row.repo ?? ""}#${row.pr}` : ""} | ${row.head ?? ""} | ${row.ready ?? ""} | ${row.status ?? ""} | ${(row.deps ?? []).join(", ")} | ${row.updatedAt} |`);
  const open = untold(board).map(({ item, recipient, delivery }) =>
    `- ${item} (${delivery.kind}) for ${recipient}${delivery.reference ? `: ${delivery.reference}` : ""}${delivery.head ? ` at ${delivery.head}` : ""}`);
  const duties = Object.entries(board.duties).map(([duty, { owner, at }]) => `- ${duty}: ${owner} (since ${at})`);
  return [
    "# Fleet board",
    "",
    "| Writer | PR | Head | Ready | Status | Depends on | Updated |",
    "|---|---|---|---|---|---|---|",
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
  return { writers: board.writers ?? {}, deliveries: board.deliveries ?? {}, duties: board.duties ?? {}, questions: board.questions ?? {}, log: board.log ?? [] };
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

/** Unresolved review threads a human opened, or null when gh cannot answer. */
function ghThreads(row) {
  const threads = readThreads(row.repo, row.pr, process.env.BOARD_GH || "gh");
  return threads === null ? null : threads.filter((thread) => !thread.resolved && !BOTS.test(thread.opener ?? "bot")).length;
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
  const [workDir, action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      pr: { type: "string" }, repo: { type: "string" }, head: { type: "string" }, status: { type: "string" }, deps: { type: "string" },
      to: { type: "string" }, kind: { type: "string" }, reference: { type: "string" },
      pushed: { type: "string", multiple: true }, threads: { type: "string", multiple: true }, now: { type: "string" },
      runtime: { type: "string" }, owner: { type: "string" }, text: { type: "string" }, ready: { type: "string" }, id: { type: "string" },
    },
  });
  if (!workDir || !["writer", "deliver", "told", "duty", "question", "answered", "ack", "push-check", "status"].includes(action)) {
    throw new Error("Usage: board.mjs <orchDir> writer|deliver|told|duty|question|answered|ack|push-check|status ...");
  }
  const orchDir = resolveWorkDir(workDir).dir;
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
    const missing = missingDuties(board, requiredDuties(orchDir));
    for (const duty of missing) process.stdout.write(`MISSING-DUTY ${duty}: give it an owner with board.mjs <orchDir> duty ${duty} --owner <writer or helper>\n`);
    const { unanswered, unacked } = lateQuestions(board, now);
    for (const entry of unanswered) process.stdout.write(`QUESTION-UNANSWERED ${entry.writer} ${entry.id} ${entry.minutes}m: ${entry.text.slice(0, 160)}\n`);
    for (const entry of unacked) process.stdout.write(`UNACKED ${entry.writer} ${entry.id} ${entry.minutes}m: the writer has not acknowledged your answer; it is likely in a long turn, so escalate\n`);
    const asked = [...unanswered, ...unacked];
    const watched = ["sessions.txt", "prs.txt"].some((file) => existsSync(path.join(orchDir, file)));
    const watcher = watched ? watcherState(orchDir, now) : { ok: true };
    if (!watcher.ok) process.stdout.write(`WATCHER-MISSING ${watcher.line.replace("watcher MISSING", "")}: re-arm watch.sh now (run_in_background)\n`);
    const home = watched || resolveWorkDir(workDir).home ? homeProblems(orchDir) : [];
    for (const line of home) process.stdout.write(`${line}\n`);
    process.stdout.write(`board: ${Object.keys(board.writers).length} writers, ${stale.length} stale, ${open.length} untold, ${slow.length} slow, ${duties.length + missing.length} unowned duties, ${unanswered.length} unanswered, ${unacked.length} unacked${watcher.ok ? "" : ", watcher missing"}${home.length > 0 ? `, ${home.length} outside the fleet home` : ""}\n`);
    return stale.length + open.length + slow.length + duties.length + missing.length + asked.length + home.length + (watcher.ok ? 0 : 1) === 0 ? 0 : 1;
  }
  const [name, recipient] = positionals;
  if (!name) {
    throw new Error(`${action} needs a name.`);
  }
  if (action === "push-check") {
    const ready = board.writers[name]?.ready;
    if (!values.head) {
      throw new Error("push-check needs --head <the sha you would push>.");
    }
    if (!ready || !(ready.startsWith(values.head) || values.head.startsWith(ready)) || Math.min(ready.length, values.head.length) < 7) {
      process.stdout.write(`NOT-READY ${name} head ${values.head}, declared ready ${ready ?? "none"}: ask the writer for its push-ready head and wait for it; never push a head it has not called ready\n`);
      return 1;
    }
    process.stdout.write(`READY ${name} ${values.head}\n`);
    return 0;
  }
  if (["question", "answered", "ack"].includes(action)) {
    if (!/^[\w.:-]{1,40}$/.test(values.id ?? "")) {
      throw new Error(`${action} needs --id <question id>; the answer echoes it and the writer acknowledges it.`);
    }
    const key = `${name}/${values.id}`;
    if (action === "question") {
      if (!values.text?.trim()) throw new Error("question needs --text <the question and the default you proceed on>.");
      board.questions[key] = { writer: name, id: values.id, text: values.text.trim(), at };
    } else if (!board.questions[key]) {
      throw new Error(`no question ${values.id} from ${name} is recorded.`);
    } else if (action === "answered") {
      board.questions[key].answeredAt = at;
    } else {
      delete board.questions[key];
    }
    write(orchDir, board, `${name} ${action} ${values.id}`, at);
    return 0;
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
    const update = Object.fromEntries(Object.entries({ pr: values.pr, repo: values.repo, head: values.head, ready: values.ready, status: values.status, runtime: values.runtime })
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
