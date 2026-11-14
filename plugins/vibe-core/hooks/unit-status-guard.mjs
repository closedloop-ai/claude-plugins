// PreToolUse guard for the bound tracker's status write, a rule its provider
// supplies as data (`data.tickets.unitStatusGuard`: the tool, the fields that
// carry the ticket and status, and the guarded statuses); with no tracker bound
// it does nothing. A ticket of a grouped unit moves to a guarded status only
// after the unit's review of the completed
// work passed (operator ruling, 2026-11-10): every member and PRD criterion
// with a code review row and a visual QA capture on each page and surface it
// names. Production acceptance testing of one PRD's list work found 33 misses
// on tickets that had been moved to In Review and Done with nothing checking
// that review.
//
// Two places say a ticket is in a unit, and each holds its own proof:
// - the active fleet program's board (fleet-home.mjs): an open unit listing
//   the ticket needs its recorded review (vibe's handoff unit-review.mjs --record);
// - the vibe session in the call's working directory: when it records member
//   tickets and the ticket is its own or a member, its handoff gate witness
//   needs `unitReviewPassed` (vibe's handoff-gate.mjs --review).
// Any other ticket, status or write passes untouched. Runs from pre-tool-use.mjs.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { deny, eventCwd } from "./hook-dispatch.mjs";
import { gatePath } from "../lib/handoff/scripts/handoff-gate-check.mjs";
import { openBoardUnits, unitReviewProblem } from "../lib/handoff/scripts/unit-review-record.mjs";
import { currentProgram, validChat } from "../lib/fleet-orchestrator/scripts/chat-binding.mjs";
import { chatProgramDir, defaultHome } from "../lib/fleet-orchestrator/scripts/fleet-home.mjs";
import { readSessionRecord } from "../lib/vibe/scripts/session-record.mjs";
import { providerDataOr, recordedBinding } from "../lib/vibe/scripts/provider.mjs";

/** The bound tracker's status-write rule for this event's chat (its session worktree, then the chat), or null. */
export function unitStatusRule(event, home) {
  const binding = recordedBinding({ worktree: eventCwd(event), conversation: event?.session_id ?? null, home });
  const rule = providerDataOr(binding, "tickets", "unitStatusGuard", null);
  if (!rule || typeof rule.tool !== "string") return null;
  return { ...rule, keyPattern: providerDataOr(binding, "tickets", "keyPattern", null) };
}

/** Why `slug` may not move to `status` yet under `rule`, or null. */
export function unitStatusProblem({ slug, status, cwd, rule, home = defaultHome(), chat }) {
  if (!rule?.keyPattern || !(rule.guarded ?? []).includes(status) || typeof slug !== "string"
    || !new RegExp(`^${rule.keyPattern}$`).test(slug)) return null;
  return boardProblem(slug, status, home, chat) ?? sessionProblem(slug, status, cwd);
}

/** The PreToolUse result for the tracker's status write: a deny while its ticket's unit is unreviewed, else null. */
export function unitStatusGuard(event, rule = unitStatusRule(event)) {
  if (!rule || event?.tool_name !== rule.tool) return null;
  const input = event?.tool_input ?? {};
  const chat = validChat(event?.session_id);
  const problem = unitStatusProblem({ slug: input[rule.slugField], status: input[rule.statusField], cwd: eventCwd(event), rule,
    home: defaultHome(process.env, chat), chat });
  return problem ? deny(problem) : null;
}

function boardProblem(slug, status, home, chat) {
  let units;
  let orchDir = home;
  try {
    if (chat && existsSync(path.join(home, "programs"))) orchDir = boundOrCurrent(home, chat);
    units = openBoardUnits(orchDir);
  }
  catch { return null; }
  for (const [name, unit] of Object.entries(units)) {
    if (!(unit.tickets ?? []).includes(slug)) continue;
    const problem = unitReviewProblem(orchDir, name, unit);
    if (problem) return `${slug} stays IN_PROGRESS, not ${status}: ${problem}. Every member and PRD criterion needs a code review row and a visual QA capture on each page and surface it names; give the operator its GAP lines.`;
  }
  return null;
}

/** The program dir `chat` is bound to in `home`, else the home's `current` one, which this gate checked before bindings. */
function boundOrCurrent(home, chat) {
  try {
    return chatProgramDir(home, chat).dir;
  } catch {
    const current = currentProgram(home);
    return current ? path.join(home, "programs", current) : home;
  }
}

function sessionProblem(slug, status, cwd) {
  let record;
  try { record = readSessionRecord(cwd); }
  catch { return null; }
  const members = record?.memberTickets ?? [];
  if (members.length === 0 || ![record.liveTicket ?? record.ticket, ...members].includes(slug)) return null;
  let witness = null;
  try {
    const file = gatePath(cwd);
    witness = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch { witness = null; }
  if (witness?.unitReviewPassed === true) return null;
  return `${slug} stays IN_PROGRESS, not ${status}: this vibe session delivers a unit and its handoff gate has not passed the unit review (handoff-gate.mjs --review <review.json> --prd <slug>=<body>).`;
}
