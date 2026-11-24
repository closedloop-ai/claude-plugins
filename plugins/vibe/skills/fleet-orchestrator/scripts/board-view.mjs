// The fleet board's derived views: rows whose head is stale or slow, unowned duties, late questions, unacknowledged
// or unstarted scope changes, what a writer has pending, deliveries not yet told, and the page writers read.
import { execFileSync } from "node:child_process";
import { renderUnits } from "./ticket-units.mjs";
import { renderPlacements } from "./writer-placement.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { Shape } = await vibeCore("lib/fleet-orchestrator/scripts/fleet-home.mjs");

export const LOG_LINES = 50;
const SLOW_MINUTES = 30;
const QUESTION_MINUTES = 15;
const SCOPE_START_MINUTES = 30;

/** Rows whose recorded head differs from the pushed head; a row with no known pushed head is not judged. */
export function staleRows(board, pushed) {
  return Object.entries(board.writers)
    .filter(([name, row]) => !row.retiredAt && pushed[name] && row.head !== pushed[name])
    .map(([name, row]) => ({ name, head: row.head ?? "none", pushed: pushed[name] }));
}

/** Codex writers whose head has not moved for SLOW_MINUTES while their PR has unresolved human threads. */
export function slowRows(board, threads, now) {
  return Object.entries(board.writers)
    .filter(([name, row]) => !row.retiredAt && row.runtime === "codex" && threads[name] > 0 && row.headAt && now - Date.parse(row.headAt) >= SLOW_MINUTES * 60_000)
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
  const entries = Object.entries(board.questions).map(([key, entry]) => ({ writer: entry.writer ?? key, id: entry.id ?? "-", ...entry }))
    .filter((entry) => !board.writers?.[entry.writer]?.retiredAt);
  return {
    unanswered: entries.filter((entry) => !entry.answeredAt && minutesSince(entry.at) >= QUESTION_MINUTES)
      .map((entry) => ({ ...entry, minutes: minutesSince(entry.at) })),
    unacked: entries.filter((entry) => entry.answeredAt && minutesSince(entry.answeredAt) >= QUESTION_MINUTES)
      .map((entry) => ({ ...entry, minutes: minutesSince(entry.answeredAt) })),
  };
}

/** A worktree's HEAD and whether it has no changes (untracked files count), or null when git cannot read it. */
export function worktreeState(worktree) {
  try {
    const git = (args) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    return { head: git(["rev-parse", "HEAD"]).trim(), clean: git(["status", "--porcelain"]).trim() === "" };
  } catch {
    return null;
  }
}

/** Told scope changes unacknowledged for QUESTION_MINUTES, and those whose writer's worktree sat clean at the recorded head for SCOPE_START_MINUTES. */
export function scopeProblems(board, now, readState = worktreeState) {
  const unacked = [];
  const notStarted = [];
  for (const [item, delivery] of Object.entries(board.deliveries)) {
    if (delivery.kind !== "scope") continue;
    for (const writer of delivery.to) {
      if (board.writers[writer]?.retiredAt) continue;
      const toldAt = delivery.told[writer];
      if (!toldAt) continue;
      const minutes = Math.floor((now - Date.parse(toldAt)) / 60_000);
      if (!delivery.acked?.[writer] && minutes >= QUESTION_MINUTES) unacked.push({ item, writer, minutes });
      const base = delivery.base?.[writer];
      const worktree = board.writers[writer]?.worktree;
      if (!base || !worktree || minutes < SCOPE_START_MINUTES) continue;
      const current = readState(worktree);
      if (current?.clean && current.head === base) notStarted.push({ item, writer, minutes, head: base });
    }
  }
  return { unacked, notStarted };
}

/** The scope changes and answers a writer has not acknowledged yet. */
export function pendingFor(board, writer) {
  const changes = Object.entries(board.deliveries)
    .filter(([, delivery]) => delivery.kind === "scope" && delivery.to.includes(writer) && !delivery.acked?.[writer])
    .map(([item, delivery]) => ({ kind: "SCOPE", id: item, text: delivery.text ?? delivery.reference }));
  const answers = Object.values(board.questions)
    .filter((entry) => entry.writer === writer && entry.answeredAt)
    .map((entry) => ({ kind: "ANSWERED", id: entry.id, text: entry.answer ?? `see the message answering: ${entry.text}` }));
  return [...changes, ...answers];
}

/** Why a program of `shape` with `writers` cannot take another writer, or null. */
export function writerShapeProblem(shape, writers) {
  if (shape === Shape.NoWriter || (shape === Shape.OneWriter && writers.length > 0)) {
    return `this program is recorded as ${shape}${writers.length > 0 ? ` (writer ${writers.join(", ")})` : ""}; record its new shape with fleet-home.mjs shape ${shape === Shape.NoWriter ? "one-writer|fleet" : "fleet"} before adding a writer, so the sections that shape needs apply`;
  }
  return null;
}

/** Required duties with no owner recorded. */
export function missingDuties(board, required) {
  return required.filter((duty) => !board.duties[duty]);
}

/** Every recipient of every delivery not yet told. */
export function untold(board) {
  return Object.entries(board.deliveries).flatMap(([item, delivery]) =>
    delivery.to.filter((recipient) => !board.writers?.[recipient]?.retiredAt && !delivery.told[recipient]).map((recipient) => ({ item, recipient, delivery })));
}

/** The page writers read. */
export function render(board) {
  const rows = Object.entries(board.writers).map(([name, row]) =>
    `| ${name} | ${row.pr ? `${row.repo ?? ""}#${row.pr}` : ""} | ${row.head ?? ""} | ${row.ready ?? ""} | ${row.retiredAt ? `Retired (${(row.retiredReason ?? "terminal").replaceAll("|", "\\|")})` : row.mergeHold ? `Held: ${row.mergeHold.reason.replaceAll("|", "\\|")}` : row.status ?? ""} | ${(row.deps ?? []).join(", ")} | ${row.updatedAt} |`);
  const open = untold(board).map(({ item, recipient, delivery }) =>
    `- ${item} (${delivery.kind}) for ${recipient}${delivery.reference ? `: ${delivery.reference}` : ""}${delivery.head ? ` at ${delivery.head}` : ""}`);
  const duties = Object.entries(board.duties).map(([duty, { owner, at }]) => `- ${duty}: ${owner} (since ${at})`);
  const scope = Object.keys(board.writers).flatMap((writer) => pendingFor(board, writer).filter((entry) => entry.kind === "SCOPE")
    .map((entry) => `- ${entry.id} for ${writer}: ${entry.text}`));
  return [
    "# Fleet board",
    "",
    "| Writer | PR | Head | Ready | Status | Depends on | Updated |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Operator merge list",
    "",
    ...Object.entries(board.writers).flatMap(([name, row]) =>
      row.mergeListed && !row.mergeHold && !row.retiredAt ? [`- ${name}: ${row.repo}#${row.pr} at ${row.mergeListed.head}`] : []),
    "",
    "## Standing duties",
    "",
    ...(duties.length > 0 ? duties : ["- none"]),
    "",
    "## Units",
    "",
    ...renderUnits(board.units, board.writers),
    "",
    "## Placement",
    "",
    ...renderPlacements(board.placements),
    "",
    "## Not yet told",
    "",
    ...(open.length > 0 ? open : ["- nothing"]),
    "",
    "## Scope changes not acknowledged",
    "",
    ...(scope.length > 0 ? scope : ["- none"]),
    "",
    "## Log",
    "",
    ...board.log.slice(-LOG_LINES).map((line) => `- ${line}`),
    "",
  ].join("\n");
}
